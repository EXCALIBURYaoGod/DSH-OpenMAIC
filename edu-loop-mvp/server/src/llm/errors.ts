/**
 * LLM 相关错误：携带稳定的机器可读 code，与 DSH 的 `LlmError` 语义一致。
 *
 * @module llm/errors
 */

import type { LlmFailure } from './types.js'

export interface LlmErrorOptions {
  status?: number
  cause?: unknown
}

export class LlmError extends Error {
  /** 稳定、provider 无关的机器码，例如 `PROVIDER_HTTP_ERROR`。 */
  readonly code: string
  /** 随错误保留的可序列化事实。 */
  readonly failure: LlmFailure

  constructor(message: string, code: string, options: LlmErrorOptions = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.failure = {
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
    }
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export const NO_ADAPTER_CODE = 'NO_ADAPTER'
export const PROVIDER_HTTP_ERROR_CODE = 'PROVIDER_HTTP_ERROR'
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const ABORTED_CODE = 'ABORTED'
/** 无凭据时用于说明为何走了降级适配器。 */
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'

export function failureFromUnknown(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      message: error.message,
      code: typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN',
    }
  }
  return { message: String(error), code: 'UNKNOWN' }
}