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
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  ToolResultBlock,
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

/** OpenAI 线格式的 `tool_calls` 条目。 */
interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI 线格式的消息（只声明用到的字段）。 */
interface WireMessage {
  role: string
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** OpenAI 兼容 chat.completions 的增量载荷（只声明用到的字段）。 */
interface ChatCompletionChunk {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      /** 流式工具调用分片：`index` 标识同一次调用，供跨分片聚合。 */
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
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
        `${this.provider}: 未解析到凭据（检查 llm.config.json 的 apiKeyEnv 与 .env.local）`,
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
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
      body.tool_choice = 'auto'
    }

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

    // ---- 块管理：推理块/文本块/工具调用块按需懒开启，结束时统一关闭 ----
    const openBlocks = new Map<number, { blockType: 'text' | 'reasoning'; text: string }>()
    /** 工具调用块按块 index 聚合；`toolBlockByCallIndex` 把 provider 的调用序号映射到块 index。 */
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>()
    const toolBlockByCallIndex = new Map<number, number>()
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
          // 工具调用分片：按 provider 的 `index` 懒开启一个 tool-call 块，再按块 index 聚合。
          for (const call of choice.delta?.tool_calls ?? []) {
            let blockIndex = toolBlockByCallIndex.get(call.index)
            if (blockIndex === undefined) {
              blockIndex = nextIndex++
              toolBlockByCallIndex.set(call.index, blockIndex)
              toolBlocks.set(blockIndex, {
                id: call.id ?? '',
                name: call.function?.name ?? '',
                args: '',
              })
              yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
            }
            const entry = toolBlocks.get(blockIndex)!
            if (call.id !== undefined && call.id.length > 0) entry.id = call.id
            if (call.function?.name !== undefined && call.function.name.length > 0) entry.name = call.function.name
            const argumentsDelta = call.function?.arguments ?? ''
            entry.args += argumentsDelta
            yield {
              type: 'tool-call-delta',
              index: blockIndex,
              id: entry.id,
              ...(entry.name.length > 0 ? { name: entry.name } : {}),
              argumentsDelta,
            }
          }
          if (choice.finish_reason != null) finishKind = mapFinishReason(choice.finish_reason)
        }
      }
    } finally {
      clearTimeout(timer)
    }

    // 按块 index 归并文本/推理块与工具调用块，统一产出 block-end。
    const emissions: Array<{ index: number; block: ContentBlock }> = []
    for (const [index, entry] of openBlocks) {
      emissions.push({
        index,
        block: entry.blockType === 'text' ? { type: 'text', text: entry.text } : { type: 'reasoning', text: entry.text },
      })
    }
    for (const [index, entry] of toolBlocks) {
      emissions.push({ index, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args } })
    }
    for (const item of emissions.sort((a, b) => a.index - b.index)) {
      yield { type: 'block-end', index: item.index, block: item.block }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: finishKind } }
  }
}

/**
 * 把 Harness 的块式消息映射为 OpenAI 线格式；`system` 前置于 messages。
 *
 * 序列化规则：
 * - 文本块拼成 `content` 字符串（多条文本块以换行连接）；推理块不回灌（DeepSeek 等
 *   不要求把 `reasoning_content` 传回多轮上下文）。
 * - assistant 若带工具调用块（或 `toolCalls`），输出 `content`（可为 null）+ `tool_calls`。
 * - `role:'tool'` 的消息直接映射为 OpenAI 的 `tool` 消息。
 * - 消息内含 `tool-result` 块时，拆成独立的 `{ role:'tool', tool_call_id, content }` 消息
 *   （OpenAI 要求工具结果紧跟其对应的 assistant `tool_calls`）。
 */
function toWireMessages(options: GenerateOptions): WireMessage[] {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: textOfBlocks(message.content),
      })
      continue
    }

    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    const text = textOfBlocks(message.content.filter(block => block.type !== 'tool-result'))
    const toolCalls = collectToolCalls(message)

    if (message.role === 'assistant' && toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        tool_calls: toolCalls.map(toWireToolCall),
      })
    } else if (text.length > 0 || message.role === 'system') {
      messages.push({ role: message.role, content: text })
    }

    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: textOfBlocks(result.content),
      })
    }
  }
  return messages
}

/** assistant 发起的工具调用：优先取内容块，其次取显式 `toolCalls`。 */
function collectToolCalls(message: RequestMessage): ToolCallBlock[] {
  const fromBlocks = message.content.filter((block): block is ToolCallBlock => block.type === 'tool-call')
  if (fromBlocks.length > 0) return fromBlocks
  return message.toolCalls ?? []
}

/** 内容块 → 文本：仅取 text 块，按换行连接。 */
function textOfBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function toWireToolCall(call: ToolCallBlock): WireToolCall {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }
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