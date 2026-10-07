/**
 * 运行模式：区分开发与生产两套启动方式。
 *
 * - `development`：前端跑 vite dev server（5173，带 HMR 与 /api 代理），后端 tsx watch 跑源码，
 *   需要放开跨域。
 * - `production`：前端已构建，由后端单端口静态托管，同源访问无需跨域。
 *
 * @module config/mode
 */

export type AppMode = 'development' | 'production'

/** 由 `NODE_ENV` 解析运行模式，未显式设置时按开发模式处理。 */
export function resolveAppMode(): AppMode {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
}
