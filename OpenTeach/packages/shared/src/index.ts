/**
 * @openteach/shared：跨模块共用的零依赖工具（环境变量与运行模式）。
 *
 * 这些工具被 llm / audio 模块与 bundle 组装层共同使用，置于独立内部包避免重复。
 *
 * @module shared
 */

export { loadDotEnv, resolveCredential } from './env.js'
export { resolveAppMode, type AppMode } from './mode.js'