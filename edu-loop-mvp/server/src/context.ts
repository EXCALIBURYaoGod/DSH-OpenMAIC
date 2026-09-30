/**
 * 应用上下文与 provider 选择。
 *
 * @module context
 */

import type { LoadedLlm } from './llm/loader.js'
import type { LlmRuntime } from './llm/registry.js'
import type { Repository } from './db/repo.js'
import type { LlmTaskContext } from './teaching/llm.js'
import type { OpenmaicSlideService } from './plugins/openmaic-slide/plugin.js'

export interface AppContext {
  runtime: LlmRuntime
  repo: Repository
  llm: LoadedLlm
  /** 可选：openmaic-slide 服务；未装配时为 undefined（调用方需降级处理）。 */
  slide?: OpenmaicSlideService
}

export interface ResolvedRoute {
  provider: string
  model: string
  degraded: boolean
}

/**
 * 解析本次请求要使用的 provider/model。
 * 未指定时回落到配置的默认值；指定了未注册的 provider 会抛出可读错误。
 */
export function resolveRoute(context: AppContext, provider?: unknown, model?: unknown): ResolvedRoute {
  const requestedProvider = typeof provider === 'string' && provider.length > 0 ? provider : context.llm.defaultProvider
  const registered = new Map(context.runtime.listProviders().map(info => [info.id, info]))
  const info = registered.get(requestedProvider)
  if (info === undefined) {
    const available = [...registered.keys()].join('、')
    throw new Error(`provider "${requestedProvider}" 未注册；可选：${available}`)
  }
  const requestedModel = typeof model === 'string' && model.length > 0 ? model : undefined
  const resolvedModel = requestedModel ?? (requestedProvider === context.llm.defaultProvider
    ? context.llm.defaultModel
    : firstModelOrDefault(context, requestedProvider))
  return {
    provider: requestedProvider,
    model: resolvedModel,
    degraded: info.degraded === true,
  }
}

function firstModelOrDefault(context: AppContext, provider: string): string {
  const profile = context.llm.config.providers[provider]
  return profile?.models?.[0]?.id ?? context.llm.defaultModel
}

/** 组装 `teaching/llm` 需要的调用上下文。 */
export function taskContext(
  context: AppContext,
  route: ResolvedRoute,
  options: { temperature?: number } = {},
): LlmTaskContext {
  return {
    runtime: context.runtime,
    repo: context.repo,
    provider: route.provider,
    model: route.model,
    degraded: route.degraded,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}