/**
 * LLM 相关路由：把可用的 provider / 模型目录暴露给前端，
 * 让「自定义 LLM 配置」在选择器上是可见、可验证的。
 *
 * @module http/routes/llm
 */

import { Router } from 'express'
import type { AppContext } from '../../context.js'

export function createLlmRouter(context: AppContext): Router {
  const router = Router()

  router.get('/providers', async (_req, res) => {
    const providers = await Promise.all(
      context.runtime.listProviders().map(async info => ({
        id: info.id,
        name: info.name,
        degraded: info.degraded === true,
        models: await context.runtime.listModels(info.id),
      })),
    )
    res.json({
      defaultProvider: context.llm.defaultProvider,
      defaultModel: context.llm.defaultModel,
      providers,
    })
  })

  router.get('/calls', (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10)
    res.json({ calls: context.repo.listLlmLogs(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50) })
  })

  return router
}