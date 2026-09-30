/**
 * 评测路由：LLM Judge 对课程产生的教学产物打分并聚合指标。
 *
 * @module http/routes/eval
 */

import { Router } from 'express'
import type { AppContext } from '../../context.js'
import { resolveRoute, taskContext } from '../../context.js'
import type { EvalRun, Repository } from '../../db/repo.js'
import { persistEvalRun, runJudge } from '../../eval/judge.js'
import { EVAL_TARGET_LABELS, EVAL_TARGETS, metricsFor, type EvalTarget } from '../../eval/metrics.js'
import { sendError } from '../sse.js'

export function createEvalRouter(context: AppContext): Router {
  const router = Router()

  /** 元信息 + 本课程各类型最近一次评测 + 全部评测运行。 */
  router.get('/courses/:courseId', (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    res.json({
      targets: EVAL_TARGETS.map(target => ({
        target,
        label: EVAL_TARGET_LABELS[target],
        criteria: metricsFor(target).criteria,
      })),
      latest: context.repo.latestEvalPerType(course.id),
      runs: context.repo.listEvalRuns(course.id, undefined, 100),
    })
  })

  /**
   * 运行一次评测。
   * body: { target: 'outline'|'explain'|'quiz'|'grade', all?: boolean, provider?, model? }
   *  - 不传 all：仅评测「最新一份产物」。
   *  - 传 all=true：评测全部产物并逐个落库。
   */
  router.post('/courses/:courseId/run', async (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const target = String(body.target ?? '') as EvalTarget
    if (!EVAL_TARGETS.includes(target)) {
      sendError(res, 400, `target 必须是 ${EVAL_TARGETS.join('、')} 之一`)
      return
    }
    const all = body.all === true

    let route
    try {
      route = resolveRoute(context, body.provider ?? course.provider, body.model ?? course.model)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return
    }

    try {
      const runs = await runEvaluations(context, course.id, target, all, route)
      res.json({ runs })
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : String(error))
    }
  })

  return router
}

interface RouteInfo {
  provider: string
  model: string
  degraded: boolean
}

async function runEvaluations(
  context: AppContext,
  courseId: string,
  target: EvalTarget,
  all: boolean,
  route: RouteInfo,
): Promise<EvalRun[]> {
  const course = context.repo.getCourse(courseId)
  if (course === undefined) return []
  const ctx = taskContext(context, route, { temperature: 0.2 })

  const candidates = collectCandidates(context.repo, course, target, all)
  const runs: EvalRun[] = []
  for (const candidate of candidates) {
    const result = await runJudge(ctx, { target, artifact: candidate.value })
    runs.push(
      persistEvalRun(context.repo, {
        courseId,
        target,
        targetId: candidate.targetId,
        provider: candidate.provider ?? route.provider,
        model: candidate.model ?? route.model,
        degraded: candidate.degraded ?? route.degraded,
        result,
      }),
    )
  }
  return runs
}

interface Candidate {
  targetId: string | null
  provider?: string
  model?: string
  degraded?: boolean
  value: { label: string; content: string }
}

function collectCandidates(
  repo: Repository,
  course: NonNullable<ReturnType<Repository['getCourse']>>,
  target: EvalTarget,
  all: boolean,
): Candidate[] {
  switch (target) {
    case 'outline': {
      const lessons = repo.listLessons(course.id)
      const content = [
        `## 课程：${course.title}`,
        `简介：${course.summary}`,
        `学习目标：${course.objectives.join('；')}`,
        ...lessons.map((lesson, index) =>
          `${index + 1}. ${lesson.title} —— 目标：${lesson.objective}；要点：${(lesson.keyPoints ?? []).join('、')}`,
        ),
      ].join('\n')
      return [{ targetId: course.id, value: { label: '课程大纲', content } }]
    }
    case 'explain': {
      const lessons = all ? repo.listLessons(course.id) : (repo.listLessons(course.id).slice(0, 1))
      return lessons.map(lesson => ({
        targetId: lesson.id,
        value: {
          label: `讲解：${course.title} / ${lesson.title}`,
          content: lesson.explanation ?? '',
        },
      }))
    }
    case 'quiz': {
      const questions = all ? repo.listQuestions(course.id) : (repo.listQuestions(course.id).slice(0, 1))
      return questions.map(quest => {
        const options = Array.isArray(quest.options) && quest.options.length > 0
          ? `\n选项：${quest.options.join(' | ')}`
          : ''
        return {
          targetId: quest.id,
          value: {
            label: `题目：${quest.stem}`,
            content: `${quest.type === 'single_choice' ? '选择题' : '简答题'}：${quest.stem}${options}\n参考答案：${quest.answer}\n解析：${quest.explanation}`,
          },
        }
      })
    }
    case 'grade': {
      const attempts = all ? repo.listAttempts(course.id) : (repo.listAttempts(course.id).slice(0, 1))
      return attempts.map(attempt => ({
        targetId: attempt.id,
        value: {
          label: `判分反馈（${attempt.correct ? '答对' : '答错'}，得分 ${attempt.score}）`,
          content: `题目作答：${attempt.answer}\nModel 判分反馈：${attempt.feedback}\n实际对错：${attempt.correct}`,
        },
      }))
    }
  }
  return []
}