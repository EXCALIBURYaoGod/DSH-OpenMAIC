/**
 * OpenAI 兼容流式适配器。
 *
 * 对齐 DSH 适配器契约：继承 `LlmAdapter` 并实现唯一的必需方法
 * `stream(options): AsyncIterable<StreamChunk>`，把 provider 的增量响应翻译成
 * Harness 分片（block-start / text-delta / reasoning-delta / block-end / usage / finish）。
 *
 * 适用于 DeepSeek 及任何提供 `POST {baseURL}/chat/completions` + `stream: true` 的服务。
 *
 * @module llm/adapters/openai-compat
 */

import { LlmError, PROVIDER_HTTP_ERROR_CODE } from '../errors.js'
import { LlmAdapter } from '../registry.js'
import type { ProviderProfile } from '../config.js'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '../types.js'
import { parseSseStream } from './sse.js'

interface OpenAICompatOptions {
  provider: string
  profile: ProviderProfile
  /** 已解析的凭据；`undefined` 表示该路由当前不可用。 */
  apiKey: string | undefined
  /** 是否处于降级状态（用于元信息展示）。 */
  degraded?: boolean
}

/** OpenAI 兼容 chat.completions 的增量载荷（只声明用到的字段）。 */
interface ChatCompletionChunk {
  choices?: Array<{
    index?: number
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }>
  /** 部分 OpenAI 兼容实现（如火山方舟）会在增量分片里下发 `usage: null`，因此必须允许 null。 */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
}

export class OpenAICompatAdapter extends LlmAdapter {
  private readonly provider: string
  private readonly profile: ProviderProfile
  private readonly apiKey: string | undefined
  private readonly degraded: boolean

  constructor(options: OpenAICompatOptions) {
    super()
    this.provider = options.provider
    this.profile = options.profile
    this.apiKey = options.apiKey
    this.degraded = options.degraded ?? false
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: this.profile.displayName ?? provider,
      degraded: this.degraded,
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (this.profile.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = (this.profile.models ?? []).find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      ...(found?.description === undefined ? {} : { description: found.description }),
      ...(found?.contextWindow === undefined ? {} : { contextWindow: found.contextWindow }),
      ...(found?.maxTokens === undefined ? {} : { maxTokens: found.maxTokens }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== this.provider) {
      throw new LlmError(
        `adapter for "${this.provider}" received a request for "${options.provider}"`,
        'PROVIDER_MISMATCH',
      )
    }
    if (this.apiKey === undefined) {
      throw new LlmError(
        `${this.provider}: 未解析到凭据（检查 llm.config.json 的 apiKeyEnv 与 .env）`,
        'MISSING_CREDENTIAL',
      )
    }

    const baseURL = (this.profile.baseURL ?? '').replace(/\/+$/, '')
    const url = `${baseURL}/chat/completions`
    const timeoutMs = this.profile.timeoutMs ?? 120_000

    // 超时与调用方取消合并为同一个 signal。
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
    const signal = options.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([options.signal, timeoutController.signal])

    const body: Record<string, unknown> = {
      ...this.profile.extraBody,
      model: options.model,
      messages: toWireMessages(options),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${this.apiKey}`,
          ...this.profile.headers,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (options.signal?.aborted) throw new LlmError('请求已被调用方取消', 'ABORTED', { cause: error })
      throw new LlmError(
        `${this.provider}: 请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
        'PROVIDER_NETWORK_ERROR',
        { cause: error },
      )
    }

    if (!response.ok || response.body === null) {
      clearTimeout(timer)
      const detail = await safeReadText(response)
      throw new LlmError(
        `${this.provider}: provider 返回 HTTP ${response.status}${detail.length > 0 ? `：${detail.slice(0, 500)}` : ''}`,
        PROVIDER_HTTP_ERROR_CODE,
        { status: response.status },
      )
    }

    // ---- 块管理：推理块与文本块按需懒开启，结束时统一关闭 ----
    const openBlocks = new Map<number, { blockType: 'text' | 'reasoning'; text: string }>()
    let nextIndex = 0
    let reasoningIndex: number | undefined
    let textIndex: number | undefined
    let usage: TokenUsage | undefined
    let finishKind: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'

    try {
      for await (const event of parseSseStream(response.body)) {
        if (event.data === '[DONE]') break
        if (event.data.length === 0) continue
        let payload: ChatCompletionChunk
        try {
          payload = JSON.parse(event.data) as ChatCompletionChunk
        } catch {
          continue // 忽略无法解析的心跳/脏数据
        }

        // 火山方舟等实现会在增量分片里下发 `usage: null`，必须用 `!= null` 判空。
        if (payload.usage != null) usage = mapUsage(payload.usage)

        const choice = payload.choices?.[0]
        if (choice !== undefined) {
          const reasoningDelta = choice.delta?.reasoning_content
          if (reasoningDelta != null && reasoningDelta.length > 0) {
            if (reasoningIndex === undefined) {
              reasoningIndex = nextIndex++
              openBlocks.set(reasoningIndex, { blockType: 'reasoning', text: '' })
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
            }
            openBlocks.get(reasoningIndex)!.text += reasoningDelta
            yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoningDelta }
          }
          const contentDelta = choice.delta?.content
          if (contentDelta != null && contentDelta.length > 0) {
            if (textIndex === undefined) {
              textIndex = nextIndex++
              openBlocks.set(textIndex, { blockType: 'text', text: '' })
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            openBlocks.get(textIndex)!.text += contentDelta
            yield { type: 'text-delta', index: textIndex, text: contentDelta }
          }
          if (choice.finish_reason != null) finishKind = mapFinishReason(choice.finish_reason)
        }
      }
    } finally {
      clearTimeout(timer)
    }

    for (const [index, entry] of [...openBlocks].sort((a, b) => a[0] - b[0])) {
      const block: ContentBlock = entry.blockType === 'text'
        ? { type: 'text', text: entry.text }
        : { type: 'reasoning', text: entry.text }
      yield { type: 'block-end', index, block }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: finishKind } }
  }
}

/** 把 Harness 消息映射为 OpenAI 线格式；`system` 前置于 messages。 */
function toWireMessages(options: GenerateOptions): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    messages.push({ role: message.role, content: message.content })
  }
  return messages
}

function mapFinishReason(reason: string): 'stop' | 'tool-calls' | 'max-tokens' {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool-calls'
  if (reason === 'length') return 'max-tokens'
  return 'stop'
}

function mapUsage(raw: NonNullable<ChatCompletionChunk['usage']>): TokenUsage {
  const cacheRead = raw.prompt_cache_hit_tokens
  const promptTotal = raw.prompt_tokens ?? 0
  return {
    // 与 DSH 契约一致：inputTokens 仅表示未命中缓存的输入。
    inputTokens: cacheRead === undefined ? promptTotal : Math.max(promptTotal - cacheRead, 0),
    outputTokens: raw.completion_tokens ?? 0,
    ...(raw.total_tokens === undefined ? {} : { totalTokens: raw.total_tokens }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(raw.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: raw.completion_tokens_details.reasoning_tokens }),
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}