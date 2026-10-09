/**
 * openmaic-core 插件：把 OpenMAIC 后端核心链路（文档解析 / 检索、生成、课堂 API）
 * 以 **in-process HTTP 路由** 的形式接入 OpenTeach 的 Express 出口。
 *
 * 与其它模块插件同构的 Cordis 范式：命名导出 `name` / `provide` / `apply`，
 * `ctx.provide('openmaic.core', ...)` 注册服务，随 fiber 卸载回收。本身不依赖其它
 * 服务（模型凭据经环境变量读取，与运行中的 OpenMAIC 一致）。
 *
 * http 插件在 `/api` 兜底（501）之前 `app.use()` 本处理器：命中的核心路由由
 * OpenMAIC 实现，未命中的（已屏蔽域）仍落到 501。
 *
 * @module plugins/openmaic-core
 */

import type { Context } from '@deepseek-ai/cordis'
import { createOpenmaicCoreHandler, type OpenmaicCoreHandler } from './dispatch'

/** 服务对外暴露的能力。 */
export interface OpenmaicCoreService {
  /** OpenMAIC 核心 API 的 Node 风格中间件（Express `app.use()` 直接用）。 */
  handler: OpenmaicCoreHandler
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 移植自 OpenMAIC 的核心 API 处理器。 */
    'openmaic.core': OpenmaicCoreService
  }
}

export const name = 'openmaic:core'
export const provide = 'openmaic.core'

export function apply(ctx: Context): void {
  ctx.provide('openmaic.core', { handler: createOpenmaicCoreHandler() })
}

export type { OpenmaicCoreHandler }