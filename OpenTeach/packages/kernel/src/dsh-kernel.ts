/**
 * DSH 编排内核引导插件（kernel 模块）。
 *
 * 职责：把 DeepSeek Harness（DSH）的 agent 运行时装配进 Cordis 容器，并把本项目的
 * provider 运行时（`eduLlm`）经 {@link DshLlmAdapter} 桥接进 DSH 的 `ctx.llm`
 * （`LlmRuntime`）。
 *
 * **宿主优先、缺失自装配**：若宿主已具备 `ctx.llm` 与 `ctx.agents`，则直接复用，
 * 不再重复装配内核；否则按
 * `SystemPrompt→Tools→Agents→Sessions→LlmRuntime→SessionProjections→AgentLoop`
 * 自行装配最小 DSH 插件图。两种场景都不抛错。
 *
 * 命名收敛：DSH 的 `LlmRuntime` 以 `llm` 之名注册——其构造函数硬编码
 * `super(ctx, 'llm')`，且 `dsh-llm` 已把 `Context.llm` 声明为 `LlmRuntime`。
 * 因此本项目的 LLM 服务改名为 `eduLlm`（见 `@openteach/plugin-llm`）：`llm` 归 DSH
 * 编排内核，`eduLlm` 仍是 provider 的真实出口。
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

export async function apply(ctx: Context): Promise<void> {
  const eduLlm = ctx.get('eduLlm')! as LoadedLlm

  // 宿主优先：探测宿主是否已装配 DSH 内核。两个服务（`llm` / `agents`）同时存在才
  // 视为「复用宿主」，避免只满足一半时误判。
  const reused = ctx.get('llm') !== undefined && ctx.get('agents') !== undefined

  if (!reused) {
    // 最小插件图：逐一满足 agent-loop 的 inject。
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(DshLlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { maxParallelToolCalls: 10, agents: [] })
  }

  // 把 eduLlm 经 DshLlmAdapter 桥进 ctx.llm。仅注册尚未被占用的 provider 路由，
  // 兼容「宿主已自带部分 provider」的场景。
  const dshLlm = ctx.get('llm')!
  const occupied = new Set(dshLlm.listProviders().map(info => info.id))
  const providers = Object.keys(eduLlm.config.providers).filter(provider => !occupied.has(provider))
  if (providers.length > 0) {
    dshLlm.registerAdapter(providers, new DshLlmAdapter(eduLlm.runtime))
  }

  const bridged = providers.length > 0 ? providers.join('、') : '（全部已存在，无需桥接）'
  console.log(reused
    ? `[dsh] 复用宿主编排内核，已桥接 provider：${bridged}`
    : `[dsh] 编排内核已装配，已桥接 provider：${bridged}`)
}