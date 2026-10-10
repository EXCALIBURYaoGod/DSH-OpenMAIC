/**
 * llm 插件：把 LLM 适配器运行时注册为 Cordis 服务 `eduLlm`。
 *
 * DSH 范式：命名导出 `name` / `provide` / `Config` / `apply`，无 default export，
 * 因此 `import * as llmPlugin` 得到的模块命名空间本身就是一个合法 Cordis 插件
 * （`isApplicable` 判定「有 apply 方法的对象」）；配置由 schemastery 经 Standard
 * Schema 校验后注入，缺省字段按 schema 回填。
 *
 * 命名：服务名为 `eduLlm` 而非 `llm`。原因是 DSH 的编排内核把 `llm` 这一名字绑定
 * 到它自己的 `LlmRuntime`。宿主内运行时 `eduLlm` 只是宿主 `ctx.llm` 的一层代理
 * （方案 B，见 `./dsh-host.ts`）；独立运行时才自持 provider 适配器。
 *
 * @module llm/plugin
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { loadLlm, type LoadedLlm } from './loader.js'
import { loadFromDshHost, probeDshLlm } from './dsh-host.js'
import { PROVIDER_APIS, type LlmConfigFile, type ProviderProfile } from './config.js'

/** provider profile 类型对外透出，供组装层（bundle）桥接 dsh 配置时构造路由。 */
export type { LlmConfigFile, ModelProfile, ProviderProfile } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * 已装配的 LLM 运行时（含默认路由与降级状态）。
     * 命名为 `eduLlm` 以让出 `llm` 给 DSH 编排内核（见文件头说明）。
     */
    eduLlm: LoadedLlm
  }
}

export const name = 'edu-loop:llm'
export const provide = 'eduLlm'

/** 单个模型条目的结构校验。 */
const ModelProfileSchema = z.object({
  id: z.string().required().description('传给 GenerateOptions.model 的精确模型 id'),
  name: z.string().description('选择器展示名，默认取 id'),
  description: z.string(),
  contextWindow: z.number().description('上下文容量（tokens）'),
  maxTokens: z.number().description('单次请求输出上限（tokens）'),
})

/** 单个 provider 路由的结构校验。 */
const ProviderProfileSchema = z.object({
  displayName: z.string(),
  api: z.string().description(`线协议：${PROVIDER_APIS.join(' | ')}`),
  baseURL: z.string(),
  apiKeyEnv: z.string().description('凭据引用的环境变量名，不落明文'),
  headers: z.dict(z.string()),
  extraBody: z.any().description('provider 专有请求体字段，原样并入请求'),
  timeoutMs: z.number(),
  models: z.array(ModelProfileSchema),
})

/** `llm.config.json` 的运行时配置。 */
export interface Config {
  /** 默认 provider 路由。 */
  defaultProvider?: string
  /** 默认模型 id；省略时取该 provider 的第一个模型。 */
  defaultModel?: string
  /** provider 路由字典，键即路由名。 */
  providers: Record<string, ProviderProfile>
}

/**
 * 配置结构校验。跨字段不变量（至少一个 provider、openai-completions 必须声明
 * baseURL、defaultProvider 必须已定义）由 `assertValidConfig` 把关——schema 表达
 * 结构，显式检查表达不变量。
 *
 * 注：schema 的可选字段归一化输出为 `T | null | undefined`，比 {@link Config}
 * 更宽，故此处不写 `z<Config>` 注解，由 schemastery 自行推断；`apply` 的配置
 * 形参类型仍以 {@link Config} 为准。
 */
export const Config = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  providers: z.dict(ProviderProfileSchema).required(),
})

/**
 * 装配 `eduLlm` 服务。
 *
 * **宿主优先（方案 B）**：在 dsh 宿主内运行时，`eduLlm` 反向适配宿主的 `ctx.llm`
 * （provider 路由、端点、模型目录、凭据全部由 dsh 掌管），本项目不再自持一份 LLM
 * 配置。宿主不可用（独立运行、或等待超时）时回落 {@link loadLlm}：按 `llm.config.json`
 * 或内置默认装配，无凭据的路由自动降级为 mock 适配器。
 *
 * apply 为异步：dsh 的 Loader 并行启动各条目，宿主 `ctx.llm` 可能稍后才激活，
 * {@link probeDshLlm} 会做有界等待（独立运行时无 dsh 内核，立即返回，无额外延迟）。
 */
export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const host = await probeDshLlm(ctx)
  const loaded = host === undefined
    ? loadLlm(config as LlmConfigFile)
    : await loadFromDshHost(ctx, host)
  ctx.provide('eduLlm', loaded)

  // 释放对 runtime 的引用；`eduLlm` 服务本身由 ctx.provide 的 disposer 随 fiber 回收。
  return () => {
    console.log(`[llm] 已释放 provider=${loaded.defaultProvider} 的适配器引用`)
  }
}

/** 便捷读取：从内核取已加载的 LLM。 */
export function useLlm(ctx: Context): LoadedLlm {
  return ctx.get('eduLlm')!
}
