/**
 * 量规路由：步骤 5（评估量规生成 + 学习证据评估）。
 *
 * @module http/routes/rubric
 */

import { Router } from 'express'
import { resolveRoute, taskContext, type AppContext } from '../../context.js'
import { newId, type Rubric } from '../../db/repo.js'
import { extractJson } from '../../teaching/json.js'
import { runLlm } from '../../teaching/llm.js'
import { normalizeEvaluation, normalizeRubricCriteria } from '../../teaching/normalize.js'
import { TEACHER_SYSTEM, rubricEvaluatePrompt, rubricGeneratePrompt } from '../../teaching/prompts.js'
import { sendError } from '../sse.js'

export function createRubricRouter(context: AppContext): Router {
  const router = Router()

  /** 生成/获取量规：已存在则直接返回最新一份，避免重复消耗 token。 */
  router.get('/courses/:courseId', (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const rubric = context.repo.latestRubric(course.id)
    res.json({ rubric, evaluation: context.repo.latestEvaluation(course.id) })
  })

  router.post('/courses/:courseId/generate', async (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    let route
    try {
      route = resolveRoute(context, body.provider ?? course.provider, body.model ?? course.model)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return
    }

    try {
      const result = await runLlm(taskContext(context, route, { temperature: 0.4 }), {
        task: 'rubric_generate',
        system: TEACHER_SYSTEM,
        prompt: rubricGeneratePrompt(course.title, course.objectives),
      })
      if (result.errorCode !== undefined) {
        sendError(res, 502, result.errorMessage ?? '量规生成失败', result.errorCode)
        return
      }
      const criteria = normalizeRubricCriteria(extractJson<unknown>(result.text))
      if (criteria.length === 0) {
        sendError(res, 502, '模型未返回有效的量规维度，请重试')
        return
      }
      const rubric: Rubric = {
        id: newId('rubric'),
        courseId: course.id,
        criteria,
        createdAt: new Date().toISOString(),
      }
      context.repo.insertRubric(rubric)
      res.json({ rubric, usage: result.usage ?? null })
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : String(error))
    }
  })

  /** 依据学习证据（测验表现 + 错题）给出评估。 */
  router.post('/courses/:courseId/evaluate', async (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const rubric = context.repo.latestRubric(course.id)
    if (rubric === undefined) {
      sendError(res, 400, '请先生成量规')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    let route
    try {
      route = resolveRoute(context, body.provider ?? course.provider, body.model ?? course.model)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return
    }

    const stats = context.repo.attemptStats(course.id)
    const wrongAnswers = context.repo
      .listAttempts(course.id)
      .filter(attempt => !attempt.correct)
      .slice(0, 5)
      .map(attempt => attempt.answer.slice(0, 120))

    try {
      const result = await runLlm(taskContext(context, route, { temperature: 0.3 }), {
        task: 'rubric_evaluate',
        system: TEACHER_SYSTEM,
        prompt: rubricEvaluatePrompt({
          courseTitle: course.title,
          criteria: rubric.criteria.map(item => ({ id: item.id, name: item.name, descriptor: item.descriptor })),
          attempted: stats.attempted,
          correct: stats.correct,
          accuracy: stats.accuracy,
          recentWrong: wrongAnswers,
        }),
      })
      if (result.errorCode !== undefined) {
        sendError(res, 502, result.errorMessage ?? '评估失败', result.errorCode)
        return
      }
      const evaluation = normalizeEvaluation(extractJson<unknown>(result.text), rubric.criteria)
      context.repo.insertRubricEvaluation({
        id: newId('eval'),
        courseId: course.id,
        rubricId: rubric.id,
        totalScore: evaluation.totalScore,
        level: evaluation.level,
        detail: evaluation,
        createdAt: new Date().toISOString(),
      })
      res.json({ evaluation, stats, usage: result.usage ?? null })
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : String(error))
    }
  })

  return router
}