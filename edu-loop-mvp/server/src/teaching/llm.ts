/**
 * 教学流程的 LLM 调用层：统一负责提示词下发、分片转发、日志落库与错误归一化。
 *
 * @module teaching/llm
 */

import { assembleStream, type LlmRuntime } from '../llm/registry.js'
import type { FinishReason, GenerateOptions, TokenUsage } from '../llm/types.js'
import { newId, type LlmCallLog, type Repository } from '../db/repo.js'

export interface LlmTaskContext {
  runtime: LlmRuntime
  repo: Repository
  provider: string
  model: string
  degraded: boolean
  temperature?: number
}

export interface RunLlmInput {
  /** 日志用任务名，例如 `course_outline`。 */
  task: string
  system?: string
  prompt: string
  /** 每收到一个文本增量回调一次（用于 SSE 转发）。 */
  onDelta?: (text: string) => void
  signal?: AbortSignal
}

export interface RunLlmResult {
  text: string
  reasoning: string
  usage?: TokenUsage
  finish: FinishReason
  /** 非空表示本次调用失败。 */
  errorCode?: string
  errorMessage?: string
}

/** 执行一次 LLM 调用，把流式文本边转发边装配，并写入调用日志。 */
export async function runLlm(context: LlmTaskContext, input: RunLlmInput): Promise<RunLlmResult> {
  const startedAt = Date.now()
  const options: GenerateOptions = {
    provider: context.provider,
    model: context.model,
    messages: [{ role: 'user', content: input.prompt }],
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(context.temperature === undefined ? {} : { temperature: context.temperature }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }

  const chunks = context.runtime.stream(options)
  let text = ''
  const wrapped = (async function* () {
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        input.onDelta?.(chunk.text)
      }
      yield chunk
    }
  })()

  const assembled = await assembleStream(wrapped)
  const finalText = assembled.text.length > 0 ? assembled.text : text
  const failed = assembled.finish.kind === 'error' || assembled.finish.kind === 'aborted'
  const failure = failed && 'failure' in assembled.finish ? assembled.finish.failure : undefined

  const log: LlmCallLog = {
    id: newId('log'),
    provider: context.provider,
    model: context.model,
    degraded: context.degraded,
    task: input.task,
    promptChars: input.prompt.length,
    outputChars: finalText.length,
    inputTokens: assembled.usage?.inputTokens ?? null,
    outputTokens: assembled.usage?.outputTokens ?? null,
    latencyMs: Date.now() - startedAt,
    status: failed ? 'error' : 'ok',
    errorCode: failure?.code ?? null,
    createdAt: new Date().toISOString(),
  }
  context.repo.insertLlmLog(log)

  return {
    text: finalText,
    reasoning: assembled.reasoning,
    ...(assembled.usage === undefined ? {} : { usage: assembled.usage }),
    finish: assembled.finish,
    ...(failure === undefined ? {} : { errorCode: failure.code, errorMessage: failure.message }),
  }
}

/** 执行一次 LLM 调用并要求返回 JSON；失败时抛出带可读信息的错误。 */
export async function runLlmJson<T>(
  context: LlmTaskContext,
  input: RunLlmInput,
  parse: (text: string) => T,
): Promise<{ value: T; result: RunLlmResult }> {
  const result = await runLlm(context, input)
  if (result.errorCode !== undefined) {
    throw new Error(`LLM 调用失败（${result.errorCode}）：${result.errorMessage ?? '未知错误'}`)
  }
  return { value: parse(result.text), result }
}