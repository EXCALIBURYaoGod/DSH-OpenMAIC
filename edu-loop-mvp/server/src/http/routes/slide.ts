/**
 * 幻灯片路由：把某课次的要点实时排版为 PPTist 风格 SlideDeck，供前端预览。
 *
 * 依赖 `openmaic.slide` 服务（未装配时返回 501，由调用方降级）。生成过程是纯同步、
 * 零 LLM 调用，因此每次都实时生成，不落库（避免过期快照）。
 *
 * @module http/routes/slide
 */

import { Router } from 'express'
import type { AppContext } from '../../context.js'
import type { SlideInput } from '../../plugins/openmaic-slide/plugin.js'
import { sendError } from '../sse.js'

export function createSlideRouter(context: AppContext): Router {
  const router = Router()

  router.post('/courses/:courseId/lessons/:lessonId/slides', (req, res) => {
    if (context.slide === undefined) {
      // 服务未装配（degrade 分支），让前端隐藏预览而不阻断讲解主流程。
      sendError(res, 501, '幻灯片服务不可用')
      return
    }

    const course = context.repo.getCourse(req.params.courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const lesson = context.repo.getLesson(req.params.lessonId)
    if (lesson === undefined || lesson.courseId !== course.id) {
      sendError(res, 404, '课次不存在')
      return
    }

    const input: SlideInput = {
      title: lesson.title,
      // 首页为主题标题页＋每个要点一页。
      pages: [
        { title: lesson.title, bullets: lesson.objective ? [lesson.objective] : [] },
        ...lesson.keyPoints.map(point => ({ title: point, bullets: [point] })),
      ],
    }

    const deck = context.slide.generateSlideJson(input)
    res.json({
      deck,
      available: context.slide.available,
      source: context.slide.source,
      dslVersion: context.slide.dslVersion,
    })
  })

  return router
}