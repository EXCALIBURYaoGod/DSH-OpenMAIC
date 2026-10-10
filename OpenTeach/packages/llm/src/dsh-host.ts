/**
 * DSH 宿主适配（方案 B）：把 DSH 编排内核的 `ctx.llm`（DSH `LlmRuntime`）**反向**
 * 适配成本项目的 provider 运行时（edu `LlmRuntime` 的一个适配器）。
 *
 * 与 `./dsh-adapter.ts` 的方向相反：那边是「edu 运行时 → 注册进 DSH 的 ctx.llm」，
 * 这里是「DSH 的 ctx.llm → 注册进创建的 edu 运行时」。在 dsh 宿主内运行时采用本方
 * 向，使 `eduLlm` 成为 `ctx.llm` 的一层薄代理——provider 路由、端点、模型目录与
 * 凭据全部由 dsh 掌管，本项目不再自持一份 LLM 配置，也不再复制凭据。
 *
 * 仅在用户层（`cordis.patch.yml`）注册本包时启用；独立运行（无 dsh 内核）时
 * {@link probeDshLlm} 立即返回 undefined，由 `plugin.ts` 回落 `loadLlm`。
 *
 * @module llm/dsh-host
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  CallId as DshCallId,
  ContentBlock as DshContentBlock,
  GenerateOptions as DshGenerateOptions,
  LlmRuntime as DshLlmRuntime,
  Message as DshMessage,
  StreamChunk as DshStreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmRuntime } from './registry.js'
import type { LoadedLlm } from './loader.js'
import type { ModelProfile, ProviderProfile } from './config.js'
import type {
  ContentBlock as EduContentBlock,
  ContentBlockType as EduContentBlockType,
  GenerateOptions as EduGenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk as EduStreamChunk,
} from './types.js'

/** system 消息的来源标记（本次适配器自造，仅供 DSH 溯源展示）。 */
const SYSTEM_SOURCE = { kind: 'plugin', plugin: 'openteach' } as const

/** 探测宿主服务的总等待上限（dsh 并行装载，实测 0.5s 内就绪）。 */
const HOST_WAIT_MS = 8000
/** 默认模型选择的额外等待上限。 */
const SELECTION_WAIT_MS = 2000
/** 轮询间隔。 */
const POLL_MS = 25

/** dsh `ctx.agentDefaultModel` 的最小结构。 */
interface DshAgentDefaultModel {
  currentSelection(): { provider: string; model: string }
}

// ---------------------------------------------------------------------------
// 协议翻译：edu ↔ DSH
// ---------------------------------------------------------------------------

/** DSH 内容块 → edu 内容块；edu 无对应槽位（如 image）的块返回 undefined。 */
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
    default:
      return undefined
  }
}

/** edu 内容块 → DSH 内容块（`tool-call` 的 id 提升为 branded `CallId`）。 */
function toDshBlock(block: EduContentBlock): DshContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return { type: 'tool-call', id: block.id as DshCallId, name: block.name, arguments: block.arguments }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: block.toolCallId as DshCallId,
        content: block.content.map(toDshBlock),
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      }
  }
}

/**
 * edu `RequestMessage` → DSH `Message`。
 *
 * DSH 的 `Message` 只能经工厂函数构造（会生成稳定 id 并冻结）；tool 角色在 DSH 里
 * 表现为 user 角色的 tool-result 消息。`provider` / `model` 用于给 assistant 消息
 * 补溯源信息。
 */
function toDshMessage(message: RequestMessage, provider: string, model: string): DshMessage {
  const content = message.content.map(toDshBlock)
  switch (message.role) {
    case 'system':
      return createMessage({ role: 'system', content, source: SYSTEM_SOURCE })
    case 'assistant': {
      // edu 把 assistant 的工具调用放在 `toolCalls` 便利字段里；内容块中缺失时补上。
      const blocks = message.toolCalls !== undefined && !content.some(block => block.type === 'tool-call')
        ? [...content, ...message.toolCalls.map(toDshBlock)]
        : content
      return createAssistantMessage({ content: blocks, source: { provider, model } })
    }
    case 'tool': {
      const result = message.content.find((block): block is Extract<EduContentBlock, { type: 'tool-result' }> =>
        block.type === 'tool-result')
      const callId = result?.toolCallId ?? message.toolCallId
      if (callId === undefined) return createUserMessage({ content, source: { kind: 'user' } })
      return createToolResultMessage({
        callId: callId as DshCallId,
        content: result === undefined ? content : result.content.map(toDshBlock),
        isError: result?.isError === true,
      })
    }
    default:
      return createUserMessage({ content, source: { kind: 'user' } })
  }
}

/** DSH 分片 → edu 分片（协议翻译）；无法表达的分片返回 undefined。 */
function toEduChunk(chunk: DshStreamChunk): EduStreamChunk | undefined {
  switch (chunk.type) {
    case 'block-start':
      return { type: 'block-start', index: chunk.index, blockType: chunk.blockType as EduContentBlockType }
    case 'text-delta':
      return { type: 'text-delta', index: chunk.index, text: chunk.text }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', index: chunk.index, text: chunk.text }
    case 'tool-call-delta':
      return {
        type: 'tool-call-delta',
        index: chunk.index,
        id: chunk.id,
        ...(chunk.name === undefined ? {} : { name: chunk.name }),
        argumentsDelta: chunk.argumentsDelta,
      }
    case 'block-end': {
      const block = toEduBlock(chunk.block)
      return block === undefined ? undefined : { type: 'block-end', index: chunk.index, block }
    }
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
      return { type: 'finish', reason: chunk.reason }
  }
}

// ---------------------------------------------------------------------------
// 宿主适配器
// ---------------------------------------------------------------------------

/**
 * 把 DSH 的 `ctx.llm` 适配为 edu `LlmAdapter`：`stream` 转发请求并回译分片，
 * 元信息查询（provider / listModels / resolveModel）直接代理宿主。
 */
export class DshHostLlmAdapter extends LlmAdapter {
  private readonly host: DshLlmRuntime
  private readonly names: ReadonlyMap<string, string>

  constructor(host: DshLlmRuntime, names: ReadonlyMap<string, string>) {
    super()
    this.host = host
    this.names = names
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.names.get(provider) ?? provider }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.host.listModels(provider)
    return models.map(model => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = await this.host.resolveModelInfo(provider, model)
    return {
      provider: info.provider,
      id: info.id,
      name: info.name,
      ...(info.description === undefined ? {} : { description: info.description }),
      ...(info.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
      ...(info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens }),
    }
  }

  override async *stream(options: EduGenerateOptions): AsyncIterable<EduStreamChunk> {
    const dshOptions: DshGenerateOptions = {
      provider: options.provider,
      model: options.model,
      messages: options.messages.map(message => toDshMessage(message, options.provider, options.model)),
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }

    for await (const chunk of this.host.stream(dshOptions)) {
      const mapped = toEduChunk(chunk)
      if (mapped !== undefined) yield mapped
    }
  }
}

// ---------------------------------------------------------------------------
// 宿主探测与装配
// ---------------------------------------------------------------------------

/**
 * 读取一个 dsh 宿主服务，必要时做有界等待。
 *
 * `ctx.get('loader', false) === undefined` 判定「无 dsh 内核」（独立运行）：立即返回
 * undefined，不引入启动延迟。`ready` 抛错视为未就绪（服务可能仍在初始化）。
 */
async function waitForService<T>(
  ctx: Context,
  name: string,
  ready: (service: T) => boolean,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const service = ctx.get(name) as T | undefined
    if (service !== undefined) {
      try {
        if (ready(service)) return service
      } catch {
        // 视为未就绪，继续等待。
      }
    }
    if (ctx.get('loader', false) === undefined || Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

/**
 * 探测 dsh 宿主的 `ctx.llm`：存在且已注册至少一个 provider 路由时才视为可用。
 * 宿主不可用（独立运行或超时）时返回 undefined，调用方回落本地配置。
 */
export function probeDshLlm(ctx: Context): Promise<DshLlmRuntime | undefined> {
  return waitForService<DshLlmRuntime>(ctx, 'llm', service => service.listProviders().length > 0, HOST_WAIT_MS)
}

/**
 * 用 dsh 宿主的 `ctx.llm` 装配 `LoadedLlm`：为宿主每个 provider 路由注册一个
 * {@link DshHostLlmAdapter}，并从宿主（含 `agentDefaultModel`）解析默认路由/模型，
 * 同时合成一份最小 `config` 供 `resolveContextWindow` 读取上下文容量。
 *
 * dsh 的 provider 路由是**陆续注册**的（`llm-pi-ai` 晚于 `llm` 服务就绪），首次快照
 * 可能只含最早的一条。故订阅宿主的 `llm/adapters-updated` 事件：拓扑变化时用
 * `handle.replace()` 同步 edu 侧路由，并刷新 `config.providers` 与默认路由/模型，
 * 使冷启动竞态与运行期热插拔都能正确传播。
 *
 * 宿主实际拥有真实凭据与端点，故 `degradedProviders` 为空集。
 */
export async function loadFromDshHost(ctx: Context, host: DshLlmRuntime): Promise<LoadedLlm> {
  const initial = host.listProviders()
  let routes = initial.map(info => info.id)
  const names = new Map(initial.map(info => [info.id, info.name]))
  // names 由适配器持有（providerInfo 实时读），后续同步就地更新即可。

  const runtime = new LlmRuntime()
  const handle = runtime.registerAdapter(routes, new DshHostLlmAdapter(host, names))

  const providers: Record<string, ProviderProfile> = {}
  const loaded: LoadedLlm = {
    runtime,
    defaultProvider: routes[0]!,
    defaultModel: routes[0]!,
    degradedProviders: new Set<string>(),
    config: { defaultProvider: routes[0]!, defaultModel: routes[0]!, providers },
  }

  let selectionService = await waitForService<DshAgentDefaultModel>(
    ctx,
    'agentDefaultModel',
    () => true,
    SELECTION_WAIT_MS,
  )

  /** 按宿主当前拓扑与默认模型选择刷新 edu 侧状态。 */
  async function sync(): Promise<void> {
    const latest = host.listProviders()
    const next = latest.map(info => info.id)
    if (next.length === 0) return
    for (const info of latest) names.set(info.id, info.name)

    if (next.length !== routes.length || next.some(id => !routes.includes(id))) {
      handle.replace(next)
      routes = next
    }
    for (const route of next) {
      const profile = providers[route] ?? { displayName: names.get(route) ?? route, models: [] }
      profile.displayName = names.get(route) ?? route
      providers[route] = profile
    }
    for (const route of Object.keys(providers)) {
      if (!next.includes(route)) delete providers[route]
    }
    await fillCatalog(host, providers, next)

    selectionService = (ctx.get('agentDefaultModel') as DshAgentDefaultModel | undefined) ?? selectionService
    let chosen: { provider: string; model: string } | undefined
    try {
      chosen = selectionService?.currentSelection()
    } catch {
      chosen = undefined
    }
    const defaultProvider = chosen !== undefined && providers[chosen.provider] !== undefined ? chosen.provider : next[0]!
    const known = providers[defaultProvider]!.models ?? []
    const defaultModel = chosen !== undefined && chosen.provider === defaultProvider
      && known.some(model => model.id === chosen!.model)
      ? chosen.model
      : known[0]?.id ?? defaultProvider

    loaded.defaultProvider = defaultProvider
    loaded.defaultModel = defaultModel
    loaded.config.defaultProvider = defaultProvider
    loaded.config.defaultModel = defaultModel
    await fillContextWindow(host, defaultProvider, providers[defaultProvider]!, defaultModel)
  }

  // 串行化同步：运行期事件可能在首轮同步未完成时到达，避免交错改路由。
  let inFlight = false
  let again = false
  async function runSync(): Promise<void> {
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    try {
      do {
        again = false
        await sync()
      } while (again)
    } finally {
      inFlight = false
    }
  }

  // 注册后立即订阅：此后任何拓扑变化都会再同步一次，覆盖「快照之后的补注册」。
  ctx.on('llm/adapters-updated', () => {
    void runSync().catch(() => {
      // 拓扑同步失败不应影响 `eduLlm` 的可用性：下次事件会重试。
    })
  })
  await runSync()

  console.log(`[llm] 已沿用 dsh 宿主的 LLM 配置：provider=${loaded.defaultProvider} model=${loaded.defaultModel} routes=${routes.join('、')}`)

  return loaded
}

/** 为尚无目录的路由拉取模型列表（路由仍可用，目录是咨询性的，失败不阻断）。 */
async function fillCatalog(
  host: DshLlmRuntime,
  providers: Record<string, ProviderProfile>,
  routes: readonly string[],
): Promise<void> {
  for (const route of routes) {
    const profile = providers[route]!
    if ((profile.models ?? []).length > 0) continue
    try {
      profile.models = (await host.listModels(route)).map(toModelProfile)
    } catch {
      // 忽略：目录缺失时 `resolveModel` 仍可解析精确模型。
    }
  }
}

/** edu 模型信息 → 配置条目（`resolveContextWindow` 依此读上下文容量）。 */
function toModelProfile(model: LlmModelInfo): ModelProfile {
  return {
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }
}

/** 补齐默认模型的 `contextWindow`（压缩器按它计算触发阈值；缺失时回落 128k）。 */
async function fillContextWindow(
  host: DshLlmRuntime,
  route: string,
  profile: ProviderProfile,
  modelId: string,
): Promise<void> {
  const models = profile.models ?? []
  const target = models.find(model => model.id === modelId)
  if (target === undefined || target.contextWindow !== undefined) return
  try {
    const info = await host.resolveModelInfo(route, modelId)
    const contextWindow = info.context?.contextWindow
    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
      const filled: ModelProfile = { ...target, contextWindow }
      profile.models = models.map(model => (model.id === modelId ? filled : model))
    }
  } catch {
    // 解析失败时留空，由消费方回落默认值。
  }
}