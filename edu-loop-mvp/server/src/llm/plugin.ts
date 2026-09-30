/**
 * llm 插件：把 LLM 适配器运行时包装为内核服务。
 *
 * `provide: ['llm']` —— 服务值为 `loadLlm(llmConfig)` 的产物（含 runtime /
 * defaultProvider / defaultModel / degradedProviders / config）。
 *
 * @module llm/plugin
 */

import type { Context } from '../core/context.js'
import type { Plugin } from '../core/plugin.js'
import { loadLlm, type LoadedLlm } from './loader.js'
import type { LlmConfigFile } from './config.js'

export const llmPlugin: Plugin<LlmConfigFile> = {
  name: 'edu-loop:llm',
  provide: 'llm',
  apply(ctx: Context, config: LlmConfigFile) {
    const loaded = loadLlm(config)
    ctx.service('llm', loaded, 'edu-loop:llm')

    const degraded = [...loaded.degradedProviders]
    if (degraded.length > 0) {
      console.warn(
        `[llm] provider ${degraded.join('、')} 未解析到凭据，已降级为本地 mock 适配器（教学闭环仍可完整跑通）。`,
      )
      console.warn('[llm] 如需接入真实模型：复制 .env.example 为 .env 并填写对应的 API Key。')
    }

    // disposer：插件停止时释放对 runtime 的引用（内核会同时删除 'llm' 服务）。
    return () => {
      console.log(`[llm] 已释放 provider=${loaded.defaultProvider} 的适配器引用`)
    }
  },
}

/** 便捷读取：从内核取已加载的 LLM。 */
export function useLlm(ctx: Context): LoadedLlm {
  return ctx.get<LoadedLlm>('llm')
}