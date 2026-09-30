/**
 * LLM provider 配置：配置驱动的 provider profile。
 *
 * 字段命名对齐 DSH 的 `PiAiProviderProfile`
 * （`deepseek-harness/packages/llm/llm-pi-ai/src/config.ts`）：
 * `apiKeyEnv`（凭据引用而非明文）、`displayName`、`api`、`baseURL`、`models`、`headers`、`timeoutMs`。
 *
 * @module llm/config
 */

/** 单个模型条目。 */
export interface ModelProfile {
  /** 传给 `GenerateOptions.model` 的精确模型 id。 */
  id: string
  /** 选择器展示名；默认取 `id`。 */
  name?: string
  description?: string
  /** 上下文容量（tokens）。 */
  contextWindow?: number
  /** 单次请求输出上限（tokens）。 */
  maxTokens?: number
}

/**
 * 一个 provider 路由的配置；`providers` 字典的键就是路由名。
 */
export interface ProviderProfile {
  /** 展示名；默认取路由键。 */
  displayName?: string
  /**
   * 该路由使用的线协议。
   * `openai-completions` = OpenAI 兼容的 `/chat/completions` 流式接口；
   * `mock` = 内置确定性适配器（无需网络与凭据）。
   */
  api?: string
  /** 该路由模型使用的端点；`openai-completions` 下默认 `https://api.deepseek.com/v1`。 */
  baseURL?: string
  /** 凭据引用（环境变量名），按请求经 `resolveCredential` 解析。 */
  apiKeyEnv?: string
  /** provider 请求头；保留名（content-type/authorization）由适配器掌管。 */
  headers?: Record<string, string>
  /**
   * provider 专有的请求体字段，原样并入 `/chat/completions` 的 body。
   * 用于承载各家的非标准参数（如火山方舟的 `thinking`），避免这些差异渗进适配器代码。
   * `model` / `messages` / `stream` / `stream_options` 为保留字段，不可被覆盖。
   */
  extraBody?: Record<string, unknown>
  /** HTTP 超时（毫秒）。 */
  timeoutMs?: number
  /** 该路由的模型目录。 */
  models?: ModelProfile[]
}

/** `llm.config.json` 的整体形状。 */
export interface LlmConfigFile {
  /** 默认 provider 路由。 */
  defaultProvider?: string
  /** 默认模型 id；省略时取该 provider 的第一个模型。 */
  defaultModel?: string
  providers: Record<string, ProviderProfile>
}

export const PROVIDER_APIS = ['openai-completions', 'mock'] as const

export function normalizeProviderProfile(provider: string, profile: ProviderProfile): Required<Pick<ProviderProfile, 'displayName' | 'api'>> & ProviderProfile {
  const api = profile.api ?? 'openai-completions'
  return {
    ...profile,
    api,
    displayName: profile.displayName ?? provider,
    models: profile.models ?? [],
  }
}

export function assertValidConfig(config: LlmConfigFile): void {
  const entries = Object.entries(config.providers ?? {})
  if (entries.length === 0) throw new Error('llm.config.json 至少需要配置一个 provider')
  for (const [provider, profile] of entries) {
    const api = profile.api ?? 'openai-completions'
    if (!(PROVIDER_APIS as readonly string[]).includes(api)) {
      throw new Error(`provider "${provider}" 声明了未知的 api "${api}"，可选值为 ${PROVIDER_APIS.join(' / ')}`)
    }
    if (api === 'openai-completions' && profile.baseURL === undefined) {
      throw new Error(`provider "${provider}" 使用 openai-completions 时必须提供 baseURL`)
    }
    for (const model of profile.models ?? []) {
      if (model.id.length === 0) throw new Error(`provider "${provider}" 存在空的模型 id`)
    }
  }
  if (config.defaultProvider !== undefined && config.providers[config.defaultProvider] === undefined) {
    throw new Error(`defaultProvider "${config.defaultProvider}" 未在 providers 中定义`)
  }
}