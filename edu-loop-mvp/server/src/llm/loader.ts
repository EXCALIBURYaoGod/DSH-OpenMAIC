/**
 * LLM loader：把 `llm.config.json` 的 provider profile 装配成一个可用的 `LlmRuntime`。
 *
 * 这是「配置驱动」的关键一环：新增一个 OpenAI 兼容端点只需要在配置里加一段 profile，
 * 不需要改任何业务代码。若某个路由没有解析到凭据，会为其注册确定性 mock 适配器，
 * 从而保证「无 Key 也能本地跑通」这条硬要求——降级状态通过 `providerInfo().degraded` 暴露。
 *
 * @module llm/loader
 */

import { resolveCredential } from '../config/env.js'
import { LlmRuntime } from './registry.js'
import { MockAdapter } from './adapters/mock.js'
import { OpenAICompatAdapter } from './adapters/openai-compat.js'
import {
  assertValidConfig,
  normalizeProviderProfile,
  type LlmConfigFile,
  type ProviderProfile,
} from './config.js'
import type { LlmModelInfo } from './types.js'

export interface LoadedLlm {
  runtime: LlmRuntime
  /** 默认 provider 路由。 */
  defaultProvider: string
  /** 默认模型 id。 */
  defaultModel: string
  /** 每个 provider 的降级状态（无凭据回退到 mock 时为 true）。 */
  degradedProviders: Set<string>
  config: LlmConfigFile
}

export function loadLlm(config: LlmConfigFile): LoadedLlm {
  assertValidConfig(config)
  const runtime = new LlmRuntime()
  const degradedProviders = new Set<string>()

  for (const [provider, rawProfile] of Object.entries(config.providers)) {
    const profile: ProviderProfile = normalizeProviderProfile(provider, rawProfile)
    const api = profile.api ?? 'openai-completions'

    if (api === 'mock') {
      degradedProviders.add(provider)
      runtime.registerAdapter([provider], new MockAdapter({
        provider,
        displayName: profile.displayName ?? provider,
        models: toModelInfos(provider, profile),
      }))
      continue
    }

    const apiKey = resolveCredential(profile.apiKeyEnv)
    if (apiKey === undefined) {
      // 无凭据：用 mock 顶替该路由，保证闭环可跑；降级状态对外可见。
      degradedProviders.add(provider)
      runtime.registerAdapter([provider], new MockAdapter({
        provider,
        displayName: `${profile.displayName ?? provider}（本地降级，未配置 ${profile.apiKeyEnv ?? '凭据'}）`,
        models: toModelInfos(provider, profile),
      }))
      continue
    }

    runtime.registerAdapter([provider], new OpenAICompatAdapter({
      provider,
      profile,
      apiKey,
    }))
  }

  const defaultProvider = config.defaultProvider ?? Object.keys(config.providers)[0]!
  const defaultModel = config.defaultModel
    ?? config.providers[defaultProvider]?.models?.[0]?.id
    ?? 'mock-teacher'

  return { runtime, defaultProvider, defaultModel, degradedProviders, config }
}

/** 把配置里的模型条目补全成 `LlmModelInfo`（mock 与真实适配器共用）。 */
function toModelInfos(provider: string, profile: ProviderProfile): LlmModelInfo[] {
  return (profile.models ?? []).map(model => ({
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }))
}