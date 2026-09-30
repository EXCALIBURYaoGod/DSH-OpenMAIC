/**
 * 内核：装配插件、解析依赖、管理生命周期。
 *
 * `createKernel()` 创建根 Context，`kernel.plugin()` 按声明解析 `inject` /
 * `provide`，先整体校验（全有或全无），通过后加载 `apply` 并记录 disposer。
 * 卸载插件时调用 disposer 并按值删除其提供的服务。
 *
 * @module core/kernel
 */

import { Context } from './context.js'
import { KernelError } from './errors.js'
import type { Plugin, PluginRegistration } from './plugin.js'

export interface PluginHandle {
  /** 插件名。 */
  name: string
  /** 卸载插件（调用其 disposer）。幂等。 */
  dispose(): void
}

export interface Kernel {
  /** 根 Context：持有 service()/on()/emit() 等能力。 */
  readonly root: Context
  /** 加载一个插件（支持同步/异步 apply）。 */
  plugin<T>(plugin: Plugin<T> | PluginRegistration<T>, config?: T): Promise<PluginHandle>
  /** 列出已加载插件名。 */
  listPlugins(): string[]
  /** 列出已注册服务（供健康检查/诊断暴露）。 */
  listServices(): ReturnType<Context['list']>
}

function normalizeProvide(provide: string | string[] | undefined): string[] {
  if (provide === undefined) return []
  return Array.isArray(provide) ? provide : [provide]
}

export function createKernel(): Kernel {
  const root = new Context()
  const loaded = new Map<string, PluginHandle & { disposer: (() => void) | undefined; services: string[] }>()

  function plugin<T>(declaration: Plugin<T> | PluginRegistration<T>, rawConfig?: T): Promise<PluginHandle> {
    const name = declaration.name

    // 1) 配置合并与校验。
    const defaultConfig = (declaration as PluginRegistration<T>).defaultConfig
    const config: T = defaultConfig !== undefined && rawConfig === undefined
      ? defaultConfig
      : rawConfig ?? ({} as T)
    if (declaration.Config !== undefined && !declaration.Config(config)) {
      return Promise.reject(new KernelError('INVALID_CONFIG', `plugin "${name}" 的配置校验未通过`))
    }

    // 2) 依赖校验：任一 inject 服务缺失即失败。
    for (const dep of declaration.inject ?? []) {
      if (!root.has(dep)) {
        return Promise.reject(
          new KernelError('MISSING_DEPENDENCY', `plugin "${name}" 依赖 service "${dep}"，但尚未注册`),
        )
      }
    }

    // 3) provide 提前校验：任一目标名已被占用即失败（全有或全无）。
    const provides = normalizeProvide(declaration.provide)
    const occupied = provides.find(svc => root.has(svc))
    if (occupied !== undefined) {
      return Promise.reject(
        new KernelError('DUPLICATE_SERVICE', `plugin "${name}" 欲提供 service "${occupied}"，但已被占用`),
      )
    }

    // 4) 应用插件（可异步）；失败则不留下任何注册。
    return Promise.resolve()
      .then(() => declaration.apply(root, config))
      .then(result => {
        const disposer = typeof result === 'function' ? result : undefined

        // 记录 apply 里注册的服务值，供卸载时精准释放。
        const providedValues = new Map<string, unknown>()
        for (const svc of provides) providedValues.set(svc, root.getOrNull(svc))

        let disposed = false
        const handle: PluginHandle = {
          name,
          dispose() {
            if (disposed) return
            disposed = true
            if (disposer !== undefined) {
              try {
                disposer()
              } catch (error) {
                console.error(`[kernel] plugin "${name}" 卸载时 disposer 抛错`, error)
              }
            }
            for (const svc of provides) root.unservice(svc, providedValues.get(svc))
            loaded.delete(name)
            root.emit('plugin.disposed', name)
          },
        }

        loaded.set(name, Object.assign(handle, { disposer, services: provides }))
        root.emit('plugin.loaded', name)
        return handle
      })
      .catch(error => {
        // 应用中途失败：回滚本插件已新增的服务。
        for (const svc of provides) root.unservice(svc, root.getOrNull(svc))
        throw error
      })
  }

  return {
    root,
    plugin,
    listPlugins: () => [...loaded.keys()],
    listServices: () => root.list(),
  }
}