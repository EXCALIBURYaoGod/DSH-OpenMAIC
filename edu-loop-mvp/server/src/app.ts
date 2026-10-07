/**
 * Express 应用装配。
 *
 * @module app
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cors from 'cors'
import express, { type Express } from 'express'
import type { AppContext } from './context.js'
import type { AppMode } from './config/mode.js'
import { createCourseRouter } from './http/routes/course.js'
import { createEvalRouter } from './http/routes/eval.js'
import { createLlmRouter } from './http/routes/llm.js'
import { createQuizRouter } from './http/routes/quiz.js'
import { createReviewRouter } from './http/routes/review.js'
import { createRubricRouter } from './http/routes/rubric.js'
import { createSlideRouter } from './http/routes/slide.js'

export interface AppOptions {
  /** 运行模式；生产模式下前端由本服务单端口托管，开发模式下前端独立跑在 vite。 */
  mode?: AppMode
  /** 生产模式下前端构建产物目录。 */
  webDist?: string
  /** 插件诊断拓扑（可选）：用于暴露 /api/plugins。 */
  plugins?: {
    listPlugins(): string[]
    listServices(): Array<{ name: string; providedBy?: string; available: boolean }>
  }
}

export function createApp(context: AppContext, options: AppOptions = {}): Express {
  const mode = options.mode ?? 'development'
  const app = express()
  // 开发模式前端跑在 5173，需放开跨域；生产为同源单端口，无须 CORS。
  if (mode === 'development') app.use(cors())
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      mode,
      defaultProvider: context.llm.defaultProvider,
      defaultModel: context.llm.defaultModel,
      providers: context.runtime.listProviders(),
      time: new Date().toISOString(),
    })
  })

  // 插件/服务诊断拓扑（在 /api 404 兜底之前挂载）。
  if (options.plugins !== undefined) {
    app.get('/api/plugins', (_req, res) => {
      res.json({ plugins: options.plugins!.listPlugins(), services: options.plugins!.listServices() })
    })
  }

  app.use('/api/llm', createLlmRouter(context))
  app.use('/api/eval', createEvalRouter(context))
  app.use('/api/courses', createCourseRouter(context))
  app.use('/api/quiz', createQuizRouter(context))
  app.use('/api/review', createReviewRouter(context))
  app.use('/api/rubric', createRubricRouter(context))
  app.use('/api/slides', createSlideRouter(context))

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { message: '接口不存在' } })
  })

  // 生产模式：若前端已构建，直接由后端托管静态资源（单端口即可访问）。
  const webDist = options.webDist
  if (webDist !== undefined && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist))
    app.get('*', (_req, res) => {
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  return app
}