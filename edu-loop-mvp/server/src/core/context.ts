/**
 * Context：插件的运行时上下文 + 依赖注入容器。
 *
 * 对齐 DSH Cordis `Context` 的核心能力，但裁剪到最小：
 * - `ctx.service(name, impl)` 注册一个可注入服务；
 * - `ctx.<serviceName>` 通过 Proxy 代理读取已注册服务；
 * - `ctx.on/ctx.emit/ctx.off` 提供轻量事件总线（生命周期通知）；
 * - `ctx.get/list` 用于服务读取与拓扑枚举。
 *
 * @module core/context
 */

import { KernelError } from './errors.js'

export type ServiceName = string

export interface ServiceEntry {
  /** 服务名。 */
  name: ServiceName
  /** 服务值。 */
  value: unknown
  /** 提供该服务的插件名（未由插件提供时为内建服务或 null）。 */
  providedBy?: string
}

export type Listener = (...args: unknown[]) => void

interface EventBinding {
  handler: Listener
  once: boolean
}

export class Context {
  private readonly services = new Map<ServiceName, ServiceEntry>()
  private readonly events = new Map<string, Set<EventBinding>>()
  private readonly proxyCache = new Map<ServiceName, unknown>()

  constructor() {}

  /**
   * 注册一个服务。服务名已被占用时抛 `DUPLICATE_SERVICE`。
   * @param providedBy 提供该服务的插件名（诊断用，可省略）。
   */
  service(name: ServiceName, value: unknown, providedBy?: string): void {
    if (this.services.has(name)) {
      const occupant = this.services.get(name)!
      throw new KernelError(
        'DUPLICATE_SERVICE',
        `service "${name}" 已被占用（由 ${occupant.providedBy ?? '内建'} 提供）`,
      )
    }
    this.services.set(name, { name, value, providedBy })
    this.proxyCache.delete(name)
  }

  /**
   * 删除一个服务。仅当当前值仍等于 `expectedValue` 才删除（避免误删被后续
   * 插件覆盖的同名服务）。返回是否真的删除。
   */
  unservice(name: ServiceName, expectedValue: unknown): boolean {
    const entry = this.services.get(name)
    if (entry === undefined || entry.value !== expectedValue) return false
    this.services.delete(name)
    this.proxyCache.delete(name)
    return true
  }

  /** 读取一个服务，未注册时抛 `MISSING_DEPENDENCY`。 */
  get<T = unknown>(name: ServiceName): T {
    const entry = this.services.get(name)
    if (entry === undefined) {
      throw new KernelError('MISSING_DEPENDENCY', `service "${name}" 未注册`)
    }
    return entry.value as T
  }

  /** 尝试读取服务，未注册时返回 `undefined`（不抛错）。 */
  getOrNull<T = unknown>(name: ServiceName): T | undefined {
    return this.services.get(name)?.value as T | undefined
  }

  /** 按名读取但携带类型（仅作为 IDE 提示用，行为与 get 相同）。 */
  require<T = unknown>(name: ServiceName): T {
    return this.get<T>(name)
  }

  /** 枚举全部已注册服务。 */
  list(): ServiceEntry[] {
    return [...this.services.values()]
  }

  /** 是否已注册某服务。 */
  has(name: ServiceName): boolean {
    return this.services.has(name)
  }

  /** 已注册的服务名清单。 */
  names(): string[] {
    return [...this.services.keys()]
  }

  /** 订阅事件，返回取消订阅函数。 */
  on(event: string, handler: Listener, once = false): () => void {
    const set = this.events.get(event) ?? new Set<EventBinding>()
    const binding: EventBinding = { handler, once }
    set.add(binding)
    this.events.set(event, set)
    return () => {
      set.delete(binding)
      if (set.size === 0) this.events.delete(event)
    }
  }

  /** 一次性订阅。 */
  once(event: string, handler: Listener): () => void {
    return this.on(event, handler, true)
  }

  /** 触发事件，所有监听器带参调用；监听器抛错不阻断其余监听器。 */
  emit(event: string, ...args: unknown[]): void {
    const set = this.events.get(event)
    if (set === undefined) return
    for (const binding of [...set]) {
      if (binding.once) set.delete(binding)
      try {
        binding.handler(...args)
      } catch (error) {
        // 非否决性：一个监听器失败不应阻断其余监听器。
        console.error(`[kernel] event "${event}" listener threw`, error)
      }
    }
    if (set.size === 0) this.events.delete(event)
  }

  /** 通过代理读取服务：`ctx.db` 等价于 `ctx.get('db')`。 */
  get proxy(): Context {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string' && target.services.has(prop)) {
          return target.services.get(prop)!.value
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as unknown as Context
  }
}

/** 便捷：把某个值以指定名注册到一个 Context 上。 */
export function registerService(ctx: Context, name: string, value: unknown, providedBy?: string): void {
  ctx.service(name, value, providedBy)
}