/**
 * 插件契约与元数据。
 *
 * 这是 DSH「一切皆插件」的最小裁剪：一个插件声明它依赖哪些服务（`inject`）、
 * 提供哪些服务（`provide`），并在 `apply` 里装配能力、返回 disposer。
 *
 * @module core/plugin
 */

import type { Context } from './context.js'

/** 插件配置校验：任意返回布尔/抛错的校验函数，true 表示通过。 */
export type ConfigValidator<T> = (config: T) => boolean

/**
 * 一个插件单元。
 *
 * `apply(ctx, config)` 返回：
 * - `void`：不持有需要释放的资源；
 * - 一个函数：插件卸载时调用（disposer），用于清理 adapter、关库、取消订阅等。
 */
export interface Plugin<T = Record<string, unknown>> {
  /** 插件展示名，用于诊断与日志。 */
  name: string
  /** 配置校验器；缺省则不校验。 */
  Config?: ConfigValidator<T>
  /** 依赖的服务名；任一缺失则该插件不加载（由内核装配顺序保障）。 */
  inject?: string[]
  /** 本插件提供的服务名（可多个）。 */
  provide?: string | string[]
  /** 装配入口。可同步返回 disposer，也可返回 Promise（异步装配）。 */
  apply: (ctx: Context, config: T) => void | (() => void) | Promise<void | (() => void)>
}

/** 插件在应用中显式注册用的声明：支持 Config 默认合并的便捷形态。 */
export interface PluginRegistration<T = Record<string, unknown>> extends Plugin<T> {
  /** 当调用方未显式传 config 时使用的默认配置。 */
  defaultConfig?: T
}