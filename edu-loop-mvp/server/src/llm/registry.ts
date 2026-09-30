/**
 * LLM 运行时：适配器注册表 + 可拦截的流式调用 API。
 *
 * 结构对齐 DSH 的 `LlmRuntime`（`packages/llm/llm/src/index.ts`）：
 * - `registerAdapter(providers, adapter)` 返回一个 disposable 句柄，句柄带有 `replace()`；
 * - 同一 provider 路由不被两个适配器同时占用（全有或全无校验）；
 * - `stream()` 把适配器抛出的异常归一化为终止性的 `error` / `aborted` 分片。
 *
 * 本 MVP 省略了 DSH 的 remote/typert、settings 目录与瀑布式事件，只保留最小可用子集。
 *
 * @module llm/registry
 */

import { LlmError, NO_ADAPTER_CODE, failureFromUnknown } from './errors.js'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
  FinishReason,
} from './types.js'

/** 一次模型调用的适配器入口，绑定同一代（generation）的模型元信息。 */
export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * provider 线协议适配器。
 *
 * `stream()` 是唯一必须实现的方法；其余方法提供展示元信息与模型目录。
 */
export abstract class LlmAdapter {
  /** 描述本适配器拥有的一个 provider 路由。 */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /** 列出本适配器当前为该 provider 公布的模型。 */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /** 解析某个精确模型的元信息。 */
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /** 把模型元信息解析与请求分发绑定到同一代。 */
  async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options),
    }
  }

  /** 以原始分片流式产出一次模型调用。唯一必须实现的方法。 */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** `registerAdapter()` 的返回值：disposer + 对同一适配器实例的原子路由替换。 */
export interface AdapterRegistrationHandle {
  (): void
  /**
   * 用 `providers` 替换本次注册持有的路由，复用同一个适配器实例。
   * 候选集先整体校验：冲突或非法名称会抛错且不影响当前路由。
   */
  replace(providers: string[]): void
}

interface AdapterRegistration {
  adapter: LlmAdapter
  owned: Set<string>
}

/** 适配器拓扑变化事件。 */
export type AdaptersUpdatedListener = () => void

/** 抽象 `llm` 服务：适配器注册表 + 流式模型调用 API。 */
export class LlmRuntime {
  private readonly adapters = new Map<string, AdapterRegistration>()
  private readonly listeners = new Set<AdaptersUpdatedListener>()

  /** 订阅适配器拓扑变化，返回取消订阅函数。 */
  onAdaptersUpdated(listener: AdaptersUpdatedListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitAdaptersUpdated(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 注册表通知是非否决性的：一个监听器失败不应阻断其余监听器。
      }
    }
  }

  /**
   * 为给定 provider 路由注册适配器。
   * 若某个 provider 已被占用则抛出 `DUPLICATE_ADAPTER`（全有或全无）。
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
    const registration = this.prepareRegistration(providers, adapter, new Set())
    this.commitRoutes(registration, providers)
    this.emitAdaptersUpdated()

    let released = false
    const handle = (() => {
      if (released) return
      released = true
      this.commitRoutes(registration, [])
      this.emitAdaptersUpdated()
    }) as AdapterRegistrationHandle

    handle.replace = (next: string[]): void => {
      if (released) {
        throw new LlmError('a disposed adapter registration cannot replace its routes', 'REGISTRATION_DISPOSED')
      }
      // 候选集整体校验通过后才提交，保证不出现空窗或半提交状态。
      this.prepareRegistration(next, adapter, registration.owned)
      this.commitRoutes(registration, next)
      this.emitAdaptersUpdated()
    }

    return handle
  }

  /** 校验候选路由集合；通过则返回（新或既有）注册对象，非法则抛错且不产生副作用。 */
  private prepareRegistration(
    providers: string[],
    adapter: LlmAdapter,
    existedRoutes: ReadonlySet<string>,
  ): AdapterRegistration {
    if (providers.length === 0) {
      throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
    }
    const unique = new Set(providers)
    if (unique.size !== providers.length) {
      throw new LlmError('duplicate provider in one registration', 'INVALID_ADAPTER')
    }
    const existing = [...this.adapters.values()].find(entry => entry.adapter === adapter)
    const registration: AdapterRegistration = existing ?? { adapter, owned: new Set<string>() }
    for (const provider of unique) {
      if (provider.length === 0) throw new LlmError('provider name must be non-empty', 'INVALID_ADAPTER')
      const occupant = this.adapters.get(provider)
      if (occupant !== undefined && occupant !== registration && !existedRoutes.has(provider)) {
        throw new LlmError(`provider "${provider}" already has an adapter`, 'DUPLICATE_ADAPTER')
      }
    }
    return registration
  }

  /** 把注册对象的持有路由原子地换成 `next`。 */
  private commitRoutes(registration: AdapterRegistration, next: readonly string[]): void {
    const desired = new Set(next)
    for (const provider of registration.owned) {
      if (!desired.has(provider)) this.adapters.delete(provider)
    }
    for (const provider of desired) this.adapters.set(provider, registration)
    registration.owned.clear()
    for (const provider of desired) registration.owned.add(provider)
  }

  /** 当前已注册的全部 provider 路由。 */
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.keys()].map(provider => this.adapters.get(provider)!.adapter.providerInfo(provider))
  }

  /** 某 provider 下可公布的模型目录。 */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const registration = this.requireRegistration(provider)
    return registration.adapter.listModels(provider)
  }

  /**
   * 流式执行一次模型调用。
   * 适配器失败会被归一化为终止性的 `error` / `aborted` finish，而不是抛出。
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamInternal(options)
  }

  private async *streamInternal(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let prepared: PreparedAdapterCall
    try {
      const registration = this.requireRegistration(options.provider)
      prepared = await registration.adapter.prepareCall(options.provider, options.model)
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: failureFromUnknown(error) } }
      return
    }

    let sawFinish = false
    try {
      for await (const chunk of prepared.stream(options)) {
        if (chunk.type === 'finish') sawFinish = true
        yield chunk
        if (sawFinish) return
      }
      if (!sawFinish) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'adapter stream ended without a finish chunk', code: 'PROTOCOL_VIOLATION' } } }
      }
    } catch (error) {
      const failure = failureFromUnknown(error)
      yield {
        type: 'finish',
        reason: options.signal?.aborted
          ? { kind: 'aborted', failure }
          : { kind: 'error', failure },
      }
    }
  }

  private requireRegistration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new LlmError(`no adapter registered for provider "${provider}"`, NO_ADAPTER_CODE)
    }
    return registration
  }
}

/**
 * 把分片流装配为完整文本（块级组装的最小实现）。
 * 同时保留推理块与工具调用块的原始信息。
 */
export interface AssembledStream {
  text: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage?: TokenUsage
  finish: FinishReason
}

export async function assembleStream(chunks: AsyncIterable<StreamChunk>): Promise<AssembledStream> {
  let text = ''
  let reasoning = ''
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  const pending = new Map<number, { id: string; name: string; args: string }>()
  let usage: AssembledStream['usage']
  let finish: AssembledStream['finish'] = { kind: 'stop' }

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'reasoning-delta':
        reasoning += chunk.text
        break
      case 'tool-call-delta': {
        const entry = pending.get(chunk.index) ?? { id: chunk.id, name: chunk.name ?? '', args: '' }
        entry.args += chunk.argumentsDelta
        if (chunk.name !== undefined) entry.name = chunk.name
        pending.set(chunk.index, entry)
        break
      }
      case 'block-end':
        if (chunk.block.type === 'text') text = chunk.block.text
        if (chunk.block.type === 'reasoning') reasoning = chunk.block.text
        if (chunk.block.type === 'tool-call') {
          toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
        }
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  return { text, reasoning, toolCalls, usage, finish }
}