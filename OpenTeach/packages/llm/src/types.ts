/**
 * LLM 契约类型。
 *
 * 本文件刻意对齐 DeepSeek Harness（DSH）`@deepseek-ai/dsh-llm` 的最小适配器契约，
 * 以便把 DSH 的「配置驱动 provider + 适配器注册表 + 流式分片协议」这一设计搬到
 * 一个可独立运行的全栈 MVP 中。与 DSH 的差异（本 MVP 有意收窄的部分）：
 * - `RequestMessage` 保留内容块数组语义，但扁平化为单条带 role 的消息
 *   （DSH 用 `MessageSource` 区分 user/model/tool 来源）；
 * - 省略 `toolHistory` / `reasoningEffort` / `purpose` 等一对一场景用不到的字段。
 *
 * @module llm/types
 */

/** 工具调用 id（DSH 使用 branded string，此处简化为 string）。 */
export type ToolCallId = string

/** 文本内容块。 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 推理/思考内容块，与可见文本区分。 */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** 模型请求的工具调用。 */
export interface ToolCallBlock {
  type: 'tool-call'
  id: ToolCallId
  name: string
  /** 模型产出的原始 JSON 字符串。 */
  arguments: string
}

/** 一次工具调用的结果，回灌给模型（对齐 DSH `ToolResultBlock`）。 */
export interface ToolResultBlock {
  type: 'tool-result'
  /** 对应 `ToolCallBlock.id`，用于把结果与调用关联。 */
  toolCallId: ToolCallId
  /** 工具结果的原始内容块（通常为一个 text 块）。 */
  content: ContentBlock[]
  isError?: boolean
}

export interface ContentBlockMap {
  text: TextBlock
  reasoning: ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

/** 内容块类型标签词表（与 DSH 一样可扩展）。 */
export type ContentBlockType = keyof ContentBlockMap

/** 任意已知内容块。 */
export type ContentBlock = ContentBlockMap[ContentBlockType]

/** 模型响应停止原因（与 DSH 的 FinishReasonMap 对齐）。 */
export interface FinishReasonMap {
  stop: { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  aborted: { kind: 'aborted'; failure: LlmFailure }
  error: { kind: 'error'; failure: LlmFailure }
}

export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/** 可序列化的失败事实，随错误一起保留。 */
export interface LlmFailure {
  message: string
  code: string
  status?: number
}

/**
 * 一次模型调用的 token 统计。
 * 计数为互斥语义：`inputTokens` 仅表示未命中缓存的输入。
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * 适配器产生的原始流式协议。
 * 每个 `block-start` 必须配对 `block-end`；`usage` 必须在 `finish` 之前产出；
 * `finish` 必须是最后一个分片。
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** 发送给模型的工具 JSON-schema 描述。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次请求中的消息（对齐 DSH 的内容块数组语义）。 */
export interface RequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 模型可见的内容块，按顺序拼接。 */
  content: ContentBlock[]
  /** assistant 发起的工具调用，便于 provider 线序列化为 `tool_calls`。 */
  toolCalls?: ToolCallBlock[]
  /** `role:'tool'` 时，本消息回执对应的调用 id。 */
  toolCallId?: ToolCallId
}

/** 一次完整装配后的模型请求。 */
export interface GenerateOptions {
  /** 已注册的 provider 路由，用于选择适配器实例。 */
  provider: string
  model: string
  messages: RequestMessage[]
  /** 一次性调用方的系统提示词；会在 `messages` 之前映射到 provider 的 system 槽位。 */
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
}

/** provider 路由的展示元信息。 */
export interface LlmProviderInfo {
  id: string
  name: string
  /**
   * 是否为降级适配器（无凭据时回退到确定性 mock）。
   * DSH 契约中没有该字段；它是本 MVP 为「无 Key 也能本地跑通」新增的标记。
   */
  degraded?: boolean
}

/** 一个模型条目。 */
export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
}

/** 精确 provider/model 路由的解析结果。 */
export interface LlmResolvedModelInfo extends LlmModelInfo {}