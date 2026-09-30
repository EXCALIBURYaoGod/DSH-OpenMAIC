/**
 * 内核错误类型。
 *
 * 对齐 DSH Cordis 的「全有或全无」语义：重复提供、依赖缺失都应在装配期
 * 立刻失败，而不是静默吞掉。
 *
 * @module core/errors
 */

/** 可序列化的错误编码。 */
export type KernelErrorCode =
  /** 某个服务名已被上一个插件占用。 */
  | 'DUPLICATE_SERVICE'
  /** 插件声明的依赖服务尚未被任何插件提供。 */
  | 'MISSING_DEPENDENCY'
  /** 插件配置校验失败。 */
  | 'INVALID_CONFIG'

export class KernelError extends Error {
  readonly code: KernelErrorCode

  constructor(code: KernelErrorCode, message: string) {
    super(message)
    this.name = 'KernelError'
    this.code = code
  }
}