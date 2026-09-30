/**
 * 复习路由：步骤 4（间隔重复）。
 *
 * 简化 SM-2：回忆质量 0-5 驱动 ease 与间隔；答错（<3）重置重复计数并把间隔压回 1 天。
 *
 * @module http/routes/review
 */

import { Router } from 'express'
import type { AppContext } from '../../context.js'
import { gradeFromCorrect, schedule } from '../../teaching/srs.js'
import { sendError } from '../sse.js'

export function createReviewRouter(context: AppContext): Router {
  const router = Router()

  router.get('/courses/:courseId/due', (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const dueReviews = context.repo.listDueReviews(course.id, new Date().toISOString())
    const items = dueReviews.map(review => {
      const question = context.repo.getQuestion(review.questionId)
      return { review, question }
    })
    res.json({ due: items })
  })

  router.get('/courses/:courseId/all', (req, res) => {
    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    res.json({ reviews: context.repo.listReviews(course.id) })
  })

  /** 一次复习：记录回忆质量（0-5），重新计算下一次到期时间。 */
  router.post('/questions/:questionId/review', (req, res) => {
    const question = context.repo.getQuestion(req.params.questionId)
    if (question === undefined) {
      sendError(res, 404, '题目不存在')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const gradeRaw = Number.parseInt(String(body.grade), 10)
    const grade = Number.isFinite(gradeRaw) ? Math.max(0, Math.min(5, gradeRaw)) : 2

    const previous = context.repo.getReview(question.id)
    const state = previous === undefined
      ? { ease: 2.5, intervalDays: 0, repetitions: 0 }
      : { ease: previous.ease, intervalDays: previous.intervalDays, repetitions: previous.repetitions }
    const next = schedule(state, grade)
    const now = new Date().toISOString()

    context.repo.upsertReview({
      questionId: question.id,
      courseId: question.courseId,
      ease: next.ease,
      intervalDays: next.intervalDays,
      repetitions: next.repetitions,
      dueAt: next.dueAt,
      lastGrade: grade,
      lastReviewedAt: now,
    })

    const remaining = context.repo.listDueReviews(question.courseId, now)
    res.json({
      review: { ...next, questionId: question.id, courseId: question.courseId },
      remainingDue: remaining.length,
    })
  })

  /** 便捷入口：按「对/错」而非 0-5 评分。 */
  router.post('/questions/:questionId/review-binary', (req, res) => {
    const question = context.repo.getQuestion(req.params.questionId)
    if (question === undefined) {
      sendError(res, 404, '题目不存在')
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const correct = body.correct === true || body.correct === 1 || body.correct === '1' || body.correct === 'true'
    const grade = gradeFromCorrect(correct)

    const previous = context.repo.getReview(question.id)
    const state = previous === undefined
      ? { ease: 2.5, intervalDays: 0, repetitions: 0 }
      : { ease: previous.ease, intervalDays: previous.intervalDays, repetitions: previous.repetitions }
    const next = schedule(state, grade)
    const now = new Date().toISOString()

    context.repo.upsertReview({
      questionId: question.id,
      courseId: question.courseId,
      ease: next.ease,
      intervalDays: next.intervalDays,
      repetitions: next.repetitions,
      dueAt: next.dueAt,
      lastGrade: grade,
      lastReviewedAt: now,
    })

    const remaining = context.repo.listDueReviews(question.courseId, now)
    res.json({
      review: { ...next, questionId: question.id, courseId: question.courseId },
      remainingDue: remaining.length,
    })
  })

  return router
}