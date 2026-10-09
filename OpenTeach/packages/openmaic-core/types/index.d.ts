/**
 * `@openteach/plugin-openmaic-core` 的对外类型声明。
 *
 * 运行时实现是 `lib/index.js`（由 `build.mjs` 用 esbuild 打包 339 个 vendor 文件而成，
 * 只做转译不做类型检查 —— 那棵 vendor 源码来自 OpenMAIC 上游，已由其自身工程校验）。
 * 本文件是刻意手写的**窄接口**，作用有两个：
 * 1. 让组装层 `@openteach/bundle` 的 `tsc` 与 tsdown 的 dts 生成不进入 vendor 源码树；
 * 2. 通过 `declare module '@deepseek-ai/cordis'` 把 `openmaic.core` 服务注入类型系统。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/** Express 可直接 `app.use()` 的 Node 风格中间件。 */
export type OpenmaicCoreHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

/** 服务对外暴露的能力。 */
export interface OpenmaicCoreService {
  /** OpenMAIC 核心 API 的 Node 风格中间件。 */
  handler: OpenmaicCoreHandler
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 移植自 OpenMAIC 的核心 API 处理器。 */
    'openmaic.core': OpenmaicCoreService
  }
}

export declare const name: 'openmaic:core'
export declare const provide: 'openmaic.core'
export declare function apply(ctx: Context): void