/**
 * DSH 编排内核引导插件（kernel 模块）。
 *
 * 职责：把 DeepSeek Harness（DSH）的 agent 运行时装配进 Cordis 容器。
 *
 * **宿主优先、缺失自装配**：若宿主已具备 `ctx.llm`（宿主内运行时由
 * `@openteach/plugin-llm` 反向适配宿主 `ctx.llm`，见其 `dsh-host.ts`），则直接复用，
 * 不再重复装配内核；否则按
 * `SystemPrompt→Tools→Agents→Sessions→LlmRuntime→SessionProjections→AgentLoop`
 * 自行装配最小 DSH 插件图，并把本项目的 provider 运行时（`eduLlm`）经
 * {@link DshLlmAdapter} 桥接进自装配的 `ctx.llm`。两种场景都不抛错。
 *
 * 注意：宿主已提供 `ctx.llm` 时**不得**再桥接 eduLlm，否则 eduLlm → 宿主 llm →
 * DshLlmAdapter → eduLlm 会形成递归。
 *
 * 命名收敛：DSH 的 `LlmRuntime` 以 `llm` 之名注册——其构造函数硬编码
 * `super(ctx, 'llm')`，且 `dsh-llm` 已把 `Context.llm` 声明为 `LlmRuntime`。
 * 因此本项目的 LLM 服务改名为 `eduLlm`（见 `@openteach/plugin-llm`）。
 *
 * @module kernel
 */

import type { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import DshLlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

import { DshLlmAdapter } from '@openteach/plugin-llm/dsh-adapter'
import type { LoadedLlm } from '@openteach/plugin-llm/loader'

export const name = 'openteach:kernel'
/** 依赖本项目的 provider 运行时（`eduLlm`）就绪。 */
export const inject = ['eduLlm']

/** 等待宿主内核服务的上限（dsh 并行装载，实测 0.5s 内就绪）。 */
const HOST_WAIT_MS = 8000
const POLL_MS = 25

/**
 * 判定是否复用宿主内核。
 *
 * dsh 的 Loader 并行启动各条目，本插件 apply 时宿主的 `llm` / `agents` 可能尚未
 * 激活，故做有界等待。独立运行（无 `loader` 服务）时不等待，立即判定为「需自装配」。
 * 超时后只要宿主已提供 `llm` 即按复用处理——自行装配会与宿主 `llm` 冲突。
 */
async function reuseHostKernel(ctx: Context): Promise<boolean> {
  const ready = (): boolean => ctx.get('llm') !== undefined && ctx.get('agents') !== undefined
  if (ready()) return true
  if (ctx.get('loader', false) === undefined) return false
  const deadline = Date.now() + HOST_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    if (ready()) return true
  }
  return ctx.get('llm') !== undefined
}

export async function apply(ctx: Context): Promise<void> {
  const eduLlm = ctx.get('eduLlm')! as LoadedLlm

  if (await reuseHostKernel(ctx)) {
    console.log('[dsh] 复用 dsh 宿主编排内核（eduLlm 反向适配宿主 ctx.llm，无需桥接）')
    return
  }

  // 最小插件图：逐一满足 agent-loop 的 inject。
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(DshLlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { maxParallelToolCalls: 10, agents: [] })

  // 自装配的内核：把 eduLlm 经 DshLlmAdapter 桥进 ctx.llm。
  const dshLlm = ctx.get('llm')!
  const providers = Object.keys(eduLlm.config.providers)
  dshLlm.registerAdapter(providers, new DshLlmAdapter(eduLlm.runtime))
  console.log(`[dsh] 编排内核已自行装配，已桥接 provider：${providers.join('、')}`)
}