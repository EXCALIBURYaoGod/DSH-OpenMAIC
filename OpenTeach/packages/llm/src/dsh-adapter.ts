/**
 * DSH `LlmAdapter` 桥接适配器：把 edu-loop 现有的 LLM 运行时（provider 适配器
 * 注册表 + 流式分片协议）接入 DSH 的 `ctx.llm: LlmRuntime`。
 *
 * 为什么需要它：DSH 的 agent-loop 只认 `ctx.llm`，而本项目的教学闭环跑在自己的
 * `llm` 服务（`server/src/llm/*`）上。两者的流式分片协议（`StreamChunk`）几乎
 * 同构，差异集中在：
 * - DSH 的 `Message` 用 `MessageSource` 区分 user/model/tool 来源，本项目用扁平的
 *   `RequestMessage.role`（system/user/assistant/tool）近似表达；
 * - DSH 的 `CallId` 是 branded string，本项目简化 string；
 * - DSH 的 `TokenUsage` 无 `totalTokens` 字段。
 *
 * 本适配器只做「协议翻译」：请求侧按内容块忠实映射 DSH 消息（含 `tool-result`）并
 * 直接转发 `tools`；响应侧把 edu-loop 分片映射回 DSH 分片（含 `tool-call`）。
 *
 * @module llm/dsh-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  CallId as DshCallId,
  ContentBlock as DshContentBlock,
  FinishReason as DshFinishReason,
  GenerateOptions as DshGenerateOptions,
  Message as DshMessage,
  StreamChunk as DshStreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock as EduContentBlock,
  GenerateOptions as EduGenerateOptions,
  RequestMessage,
  StreamChunk as EduStreamChunk,
} from './types.js'

/**
 * 适配器需要的 edu-loop 运行时最小依赖（`LoadedLlm.runtime` 结构上即可满足）。
 * 依赖抽象而非 `LoadedLlm` 具体类型，便于 spike / 测试注入确定性流。
 */
export interface EduLlmStreamSource {
  stream(options: EduGenerateOptions): AsyncIterable<EduStreamChunk>
}

/** DSH 内容块 → edu-loop 内容块（按块忠实映射）；edu 无对应槽位的块返回 undefined。 */
function toEduBlock(block: DshContentBlock): EduContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: block.toolCallId,
        content: block.content.map(toEduBlock).filter((item): item is EduContentBlock => item !== undefined),
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      }
    case 'image':
      // edu-loop 当前无图片槽位，忽略（不影响文本与工具往返）。
      return undefined
    default:
      return undefined
  }
}

/** DSH 消息 → edu-loop `RequestMessage`（内容块按块映射）。 */
function toEduMessage(message: DshMessage): RequestMessage {
  return {
    role: message.role,
    content: message.content.map(toEduBlock).filter((item): item is EduContentBlock => item !== undefined),
  }
}

/** edu-loop 内容块 → DSH 内容块（`tool-call` 的 id 提升为 branded `CallId`）。 */
function toDshBlock(block: EduContentBlock): DshContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: block.id as DshCallId,
        name: block.name,
        arguments: block.arguments,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: block.toolCallId as DshCallId,
        content: block.content.map(block => toDshBlock(block)),
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      }
  }
}

/** edu-loop 分片 → DSH 分片（协议翻译）。 */
function toDshChunk(chunk: EduStreamChunk): DshStreamChunk {
  switch (chunk.type) {
    case 'block-start':
      return { type: 'block-start', index: chunk.index, blockType: chunk.blockType }
    case 'text-delta':
      return { type: 'text-delta', index: chunk.index, text: chunk.text }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', index: chunk.index, text: chunk.text }
    case 'tool-call-delta':
      return {
        type: 'tool-call-delta',
        index: chunk.index,
        id: chunk.id as DshCallId,
        ...(chunk.name === undefined ? {} : { name: chunk.name }),
        argumentsDelta: chunk.argumentsDelta,
      }
    case 'block-end':
      return { type: 'block-end', index: chunk.index, block: toDshBlock(chunk.block) }
    case 'usage':
      return {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          ...(chunk.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: chunk.usage.cacheReadTokens }),
          ...(chunk.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: chunk.usage.cacheWriteTokens }),
          ...(chunk.usage.reasoningTokens === undefined ? {} : { reasoningTokens: chunk.usage.reasoningTokens }),
        },
      }
    case 'finish':
      return { type: 'finish', reason: chunk.reason as DshFinishReason }
  }
}

/**
 * 把 edu-loop 的 provider 运行时接入 DSH `LlmRuntime.registerAdapter` 的适配器。
 *
 * 注册示例：
 * ```ts
 * ctx.llm.registerAdapter([loaded.defaultProvider], new DshLlmAdapter(loaded.runtime))
 * ```
 */
export class DshLlmAdapter extends LlmAdapter {
  private readonly source: EduLlmStreamSource

  constructor(source: EduLlmStreamSource) {
    super()
    this.source = source
  }

  override async *stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    const eduOptions: EduGenerateOptions = {
      provider: options.provider,
      model: options.model,
      messages: options.messages.map(toEduMessage),
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // DSH 与 edu-loop 的 ToolSchema 结构一致，直接透传。
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }

    for await (const chunk of this.source.stream(eduOptions)) {
      yield toDshChunk(chunk)
    }
  }
}