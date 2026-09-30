/**
 * 测验路由：步骤 3（出题 → 作答 → 判分），并把结果接入间隔重复调度。
 *
 * @module http/routes/quiz
 */

import { Router } from 'express'
import { resolveRoute, taskContext, type AppContext } from '../../context.js'
import { newId, type Attempt, type Question } from '../../db/repo.js'
import { extractJson } from '../../teaching/json.js'
import { runLlm } from '../../teaching/llm.js'
import { normalizeGrade, normalizeQuestions } from '../../teaching/normalize.js'
import { TEACHER_SYSTEM, quizGeneratePrompt, quizGradePrompt } from '../../teaching/prompts.js'
import { gradeFromCorrect, initialReview, schedule } from '../../teaching/srs.js'
import { sendError } from '../sse.js'

export function createQuizRouter(context: AppContext): Router {
  const router = Router()

  router.get('/courses/:courseId/questions', (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    res.json({
      questions: context.repo.listQuestions(course.id),
      attempts: context.repo.listAttempts(course.id),
      stats: context.repo.attemptStats(course.id),
    })
  })

  /** 出题：默认覆盖整门课程；给定 lessonId 时只针对该课次。 */
  router.post('/courses/:courseId/generate', async (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const countRaw = Number.parseInt(String(body.count ?? '3'), 10)
    const count = Number.isFinite(countRaw) ? Math.min(Math.max(countRaw, 1), 8) : 3

    let target: { lessonId: string | null; lessonTitle: string; objective: string }
    if (typeof body.lessonId === 'string' && body.lessonId.length > 0) {
      const lesson = context.repo.getLesson(body.lessonId)
      if (lesson === undefined || lesson.courseId !== course.id) {
        sendError(res, 404, '课次不存在')
        return
      }
      target = { lessonId: lesson.id, lessonTitle: lesson.title, objective: lesson.objective }
    } else {
      target = { lessonId: null, lessonTitle: course.title, objective: course.objectives.join('；') || course.summary }
    }

    let route
    try {
      route = resolveRoute(context, body.provider ?? course.provider, body.model ?? course.model)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return
    }

    try {
      const result = await runLlm(taskContext(context, route, { temperature: 0.6 }), {
        task: 'quiz_generate',
        system: TEACHER_SYSTEM,
        prompt: quizGeneratePrompt({
          courseTitle: course.title,
          lessonTitle: target.lessonTitle,
          objective: target.objective,
          count,
        }),
      })
      if (result.errorCode !== undefined) {
        sendError(res, 502, result.errorMessage ?? '出题失败', result.errorCode)
        return
      }

      const generated = normalizeQuestions(extractJson<unknown>(result.text), count)
      if (generated.length === 0) {
        sendError(res, 502, '模型未返回任何题目，请重试')
        return
      }

      const questions: Question[] = generated.map((item, index) => ({
        id: newId('q'),
        courseId: course.id,
        lessonId: target.lessonId,
        idx: index,
        type: item.type,
        stem: item.stem,
        options: item.options,
        answer: item.answer,
        explanation: item.explanation,
        difficulty: item.difficulty,
      }))
      context.repo.insertQuestions(questions)

      // 新题立即进入复习队列（due = now），保证闭环能马上走完。
      const now = new Date().toISOString()
      for (const question of questions) {
        const initial = initialReview()
        context.repo.upsertReview({
          questionId: question.id,
          courseId: course.id,
          ease: initial.ease,
          intervalDays: initial.intervalDays,
          repetitions: initial.repetitions,
          dueAt: now,
          lastGrade: null,
          lastReviewedAt: null,
        })
      }

      res.json({ questions, degraded: route.degraded, usage: result.usage ?? null })
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : String(error))
    }
  })

  /** 作答：判分 → 落库 attempts → 更新 reviews 调度。 */
  router.post('/questions/:questionId/attempt', async (req, res) => {
    const question = context.repo.getQuestion(req.params.questionId)
    if (question === undefined) {
      sendError(res, 404, '题目不存在')
      return
    }
    const course = context.repo.getCourse(question.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''

    let route
    try {
      route = resolveRoute(context, body.provider ?? course.provider, body.model ?? course.model)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return
    }

    let graded: { correct: boolean; score: number; feedback: string }
    let gradedBy = 'llm'
    try {
      const result = await runLlm(taskContext(context, route, { temperature: 0 }), {
        task: 'quiz_grade',
        system: TEACHER_SYSTEM,
        prompt: quizGradePrompt({ stem: question.stem, reference: question.answer, answer }),
      })
      if (result.errorCode !== undefined) throw new Error(result.errorMessage ?? 'judge failed')
      graded = normalizeGrade(extractJson<unknown>(result.text))
    } catch {
      // 判分失败时退回确定性的本地判据，保证闭环不中断，并如实标注来源。
      graded = heuristicGrade(question.answer, answer)
      gradedBy = 'heuristic'
    }

    const createdAt = new Date().toISOString()
    const attempt: Attempt = {
      id: newId('attempt'),
      questionId: question.id,
      courseId: course.id,
      answer,
      correct: graded.correct,
      score: graded.score,
      feedback: graded.feedback,
      gradedBy,
      createdAt,
    }
    context.repo.insertAttempt(attempt)

    const previous = context.repo.getReview(question.id)
    const state = previous === undefined
      ? { ease: 2.5, intervalDays: 0, repetitions: 0 }
      : { ease: previous.ease, intervalDays: previous.intervalDays, repetitions: previous.repetitions }
    const next = schedule(state, gradeFromCorrect(graded.correct))
    context.repo.upsertReview({
      questionId: question.id,
      courseId: course.id,
      ease: next.ease,
      intervalDays: next.intervalDays,
      repetitions: next.repetitions,
      dueAt: next.dueAt,
      lastGrade: gradeFromCorrect(graded.correct),
      lastReviewedAt: createdAt,
    })

    res.json({
      attempt,
      review: { ...next, questionId: question.id, courseId: course.id },
      stats: context.repo.attemptStats(course.id),
    })
  })

  return router
}

/** 无 LLM 时的确定性判据：完全一致、互相包含或高重合度视为正确。 */
function heuristicGrade(reference: string, answer: string): { correct: boolean; score: number; feedback: string } {
  const normalize = (text: string): string => text.replace(/\s+/g, '').toLowerCase()
  const expected = normalize(reference)
  const actual = normalize(answer)
  if (actual.length === 0) {
    return { correct: false, score: 0, feedback: '未作答，建议先复述本课的主干结论。' }
  }
  if (actual === expected || actual.includes(expected) || expected.includes(actual)) {
    return { correct: true, score: 90, feedback: '与参考答案实质一致（本地判据）。' }
  }
  const overlap = longestCommonSubstringLength(expected, actual) / Math.max(expected.length, 1)
  if (overlap >= 0.6) {
    return { correct: true, score: 75, feedback: `与参考答案重合度 ${Math.round(overlap * 100)}%（本地判据）。` }
  }
  return {
    correct: false,
    score: Math.round(overlap * 100),
    feedback: `与参考答案重合度不足 ${Math.round(overlap * 100)}%，建议回看对应小节（本地判据）。`,
  }
}

function longestCommonSubstringLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  let best = 0
  const previous = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j]!
      if (a[i - 1] === b[j - 1]) {
        previous[j] = diagonal + 1
        if (previous[j]! > best) best = previous[j]!
      } else {
        previous[j] = 0
      }
      diagonal = saved
    }
  }
  return best
}