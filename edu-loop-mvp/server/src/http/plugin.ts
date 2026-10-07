/**
 * http 插件：从内核读取服务并装配 Express 应用。
 *
 * `inject: ['llm', 'repo', 'kernel']`；`provide: ['app']`。路由逻辑保持与改造前一致，
 * 只是把依赖来源从手工 `AppContext` 改为内核注册的服务。加载后由 `kernel` 服务
 * 提供 `/api/plugins` 诊断拓扑（在 app.ts 的 /api 404 兜底之前挂载）。
 *
 * @module http/plugin
 */

import type { Express } from 'express'
import type { Context } from '../core/context.js'
import type { Kernel } from '../core/kernel.js'
import type { Plugin } from '../core/plugin.js'
import type { LoadedLlm } from '../llm/loader.js'
import type { Repository } from '../db/repo.js'
import type { AppContext } from '../context.js'
import type { AppMode } from '../config/mode.js'
import type { OpenmaicSlideService } from '../plugins/openmaic-slide/plugin.js'
import { createApp } from '../app.js'

export interface HttpPluginConfig {
  /** 运行模式；生产模式托管前端构建产物，开发模式仅提供 API。 */
  mode?: AppMode
  /** 生产模式下前端构建产物目录；缺省则不托管静态资源。 */
  webDist?: string
}

export const httpPlugin: Plugin<HttpPluginConfig> = {
  name: 'edu-loop:http',
  inject: ['llm', 'repo', 'kernel'],
  provide: 'app',
  apply(ctx: Context, config: HttpPluginConfig) {
    const llm = ctx.get<LoadedLlm>('llm')
    const repo = ctx.get<Repository>('repo')
    const kernel = ctx.get<Kernel>('kernel')

    // 组装与原签名一致的 AppContext，路由层无需任何改动。
    const slide = ctx.getOrNull<OpenmaicSlideService>('openmaic.slide')
    const appContext: AppContext = {
      runtime: llm.runtime,
      repo,
      llm,
      ...(slide === undefined ? {} : { slide }),
    }

    const app: Express = createApp(appContext, {
      ...(config.mode === undefined ? {} : { mode: config.mode }),
      ...(config.webDist === undefined ? {} : { webDist: config.webDist }),
      plugins: {
        listPlugins: () => kernel.listPlugins(),
        listServices: () =>
          kernel.listServices().map(entry => ({
            name: entry.name,
            providedBy: entry.providedBy ?? 'internal',
            available: entry.value !== undefined && entry.value !== null,
          })),
      },
    })

    ctx.service('app', app, 'edu-loop:http')
  },
}