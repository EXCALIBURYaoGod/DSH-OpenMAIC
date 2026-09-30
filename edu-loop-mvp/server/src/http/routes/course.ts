/**
 * 课程路由：步骤 1（生成结构化课程）与步骤 2（结构化讲解）。
 *
 * @module http/routes/course
 */

import { Router } from 'express'
import { resolveRoute, taskContext, type AppContext } from '../../context.js'
import { newId, type Course, type Lesson } from '../../db/repo.js'
import { extractJson } from '../../teaching/json.js'
import { runLlm } from '../../teaching/llm.js'
import { normalizeOutline } from '../../teaching/normalize.js'
import { TEACHER_SYSTEM, courseOutlinePrompt, lessonExplainPrompt } from '../../teaching/prompts.js'
import { openSse, sendError } from '../sse.js'

export function createCourseRouter(context: AppContext): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({ courses: context.repo.listCourses() })
  })

  router.get('/:id', (req, res) => {
    const course = context.repo.getCourse(req.params.id)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    res.json({
      course,
      lessons: context.repo.listLessons(course.id),
      stats: context.repo.attemptStats(course.id),
      questionCount: context.repo.countQuestions(course.id),
    })
  })

  /**
   * 步骤 1：输入主题/资料 → 流式生成课程大纲 → 落库。
   * 事件序列：meta → delta* → outline（含课程与课次）| error
   */
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    if (topic.length === 0) {
      sendError(res, 400, 'topic 不能为空')
      return
    }
    const material = typeof body.material === 'string' && body.material.trim().length > 0
      ? body.material.trim()
      : null

    let route
    try {
      route = resolveRoute(context, body.provider, body.model)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return
    }

    const channel = openSse(res)
    const courseId = newId('course')
    channel.send('meta', { courseId, provider: route.provider, model: route.model, degraded: route.degraded })

    try {
      const result = await runLlm(taskContext(context, route, { temperature: 0.6 }), {
        task: 'course_outline',
        system: TEACHER_SYSTEM,
        prompt: courseOutlinePrompt(topic, material),
        onDelta: text => channel.send('delta', { text }),
      })
      if (result.errorCode !== undefined) {
        channel.send('error', { code: result.errorCode, message: result.errorMessage })
        channel.close()
        return
      }

      const outline = normalizeOutline(extractJson<unknown>(result.text), topic)
      const createdAt = new Date().toISOString()
      const course: Course = {
        id: courseId,
        topic,
        material,
        title: outline.title,
        summary: outline.summary,
        objectives: outline.objectives,
        provider: route.provider,
        model: route.model,
        degraded: route.degraded,
        createdAt,
      }
      const lessons: Lesson[] = outline.lessons.map((lesson, index) => ({
        id: newId('lesson'),
        courseId,
        idx: index,
        title: lesson.title,
        objective: lesson.objective,
        keyPoints: lesson.keyPoints,
        explanation: null,
        explainedAt: null,
      }))
      context.repo.insertCourse(course)
      context.repo.insertLessons(lessons)

      channel.send('outline', { course, lessons, usage: result.usage ?? null })
    } catch (error) {
      channel.send('error', { code: 'OUTLINE_FAILED', message: error instanceof Error ? error.message : String(error) })
    } finally {
      channel.close()
    }
  })

  /**
   * 步骤 2：对某一课生成结构化讲解，并持久化到该课次。
   * 事件序列：delta* → done（含持久化后的课次）| error
   */
  router.post('/:id/lessons/:lessonId/explain', async (req, res) => {
    const course = context.repo.getCourse(req.params.id)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const lesson = context.repo.getLesson(req.params.lessonId)
    if (lesson === undefined || lesson.courseId !== course.id) {
      sendError(res, 404, '课次不存在')
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

    const channel = openSse(res)
    channel.send('meta', { lessonId: lesson.id, provider: route.provider, model: route.model, degraded: route.degraded })

    try {
      const result = await runLlm(taskContext(context, route, { temperature: 0.5 }), {
        task: 'lesson_explain',
        system: TEACHER_SYSTEM,
        prompt: lessonExplainPrompt({
          courseTitle: course.title,
          lessonTitle: lesson.title,
          objective: lesson.objective,
          keyPoints: lesson.keyPoints,
        }),
        onDelta: text => channel.send('delta', { text }),
      })
      if (result.errorCode !== undefined) {
        channel.send('error', { code: result.errorCode, message: result.errorMessage })
        return
      }
      const explainedAt = new Date().toISOString()
      context.repo.setLessonExplanation(lesson.id, result.text, explainedAt)
      channel.send('done', {
        lesson: { ...lesson, explanation: result.text, explainedAt },
        usage: result.usage ?? null,
      })
    } catch (error) {
      channel.send('error', { code: 'EXPLAIN_FAILED', message: error instanceof Error ? error.message : String(error) })
    } finally {
      channel.close()
    }
  })

  return router
}