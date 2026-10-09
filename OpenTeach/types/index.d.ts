/**
 * `@openteach/bundle` 的对外类型声明。
 *
 * 运行时实现是 `lib/index.js`（由 tsdown 把本包组装层与 11 个 `@openteach/*` 模块
 * 插件内联打包而成）。之所以不自动生成声明，见 `tsdown.config.ts` 中 `dts: false`
 * 的说明：内联的裸 `.ts` 模块会让 rolldown-plugin-dts 命中 TS2742。
 *
 * 本文件是刻意手写的**窄接口**：只声明 dsh Loader / 宿主真正会触碰的三样东西 ——
 * 插件名、配置结构、装载函数，且只依赖宿主 peer 包（cordis / schemastery），不引用
 * 不对外发布的 `@openteach/*` 内部类型，避免声明悬空。业务类型由各模块插件自行暴露。
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** bundle 插件名（dsh 装载时用于标识）。 */
export declare const name: 'openteach'

/** bundle 组装配置；除 `llm` 外全部可省略，缺省时按环境变量与内置默认解析。 */
export interface Config {
  /** 已解析的 `llm.config.json` 内容（provider 路由与默认模型）。 */
  llm?: unknown
  /** `llm.config.json` 路径；提供时从中读取 provider 配置。 */
  llmConfigPath?: string
  /** SQLite 库文件路径（db 模块）。省略时读 `OPENTEACH_DB_PATH`。 */
  dbFilePath?: string
  /** `.env` 文件路径；提供时在装配前载入（凭据经环境变量注入 provider）。 */
  envPath?: string
  /** 运行模式；省略时按 `NODE_ENV` 解析。 */
  mode?: 'development' | 'production'
  /** 生产模式下托管的前端构建产物目录（仅 production 生效）。 */
  webDist?: string
  /** generation 模块配置。 */
  generation?: unknown
  /** classroom 模块配置。 */
  classroom?: unknown
  /** 装载后自行监听 HTTP 端口（独立安装到 dsh 时用）。 */
  listen?: boolean
  /** 监听端口；省略时读 `OPENTEACH_PORT`，再退到 8787。 */
  port?: number
}

/** 配置结构校验（宿主包保持 external，由 dsh Loader 校验本 schema）。 */
export declare const Config: z<Config>

/**
 * 按依赖顺序装载各模块插件。
 *
 * @returns `config.listen` 为真时返回关闭 HTTP 服务的 disposer，否则 void。
 */
export declare function apply(ctx: Context, config?: Config): Promise<void | (() => void)>