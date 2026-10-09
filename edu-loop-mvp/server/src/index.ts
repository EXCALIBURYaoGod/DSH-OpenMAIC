/**
 * 服务入口：加载 OpenTeach bundle（组装层）→ 启动 HTTP 服务。
 *
 * 本入口只加载 **一个** OpenTeach bundle；由 bundle 的组装清单按
 * llm → db → kernel → storage → generation → layout → slide → audio → classroom → http
 * 装载各模块插件（等价于改造前逐个加载插件），各模块经 `ctx.provide()` 注册服务。
 *
 * 前端已拆为独立包（仓库根的 `OpenTeach-frontend`，即 `@openteach/frontend`），
 * 它是一个自带 Next.js 服务的应用，通过 `/api/*` 重写代理到本后端（见其
 * `next.config.ts` 的 `OPENTEACH_API_BASE`）。因此本后端只提供 API，不再静态托管前端。
 *
 * @module index
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
// 从源码入口加载（`@openteach/bundle/src`）：宿主直接跑 TS 源码，无需先构建 lib。
import * as openTeach from '@openteach/bundle/src'

const ROOT = new URL('../../', import.meta.url)
const CONFIG_PATH = fileURLToPath(new URL('llm.config.json', ROOT))
const ENV_PATH = fileURLToPath(new URL('.env', ROOT))
const DB_PATH = fileURLToPath(new URL('../data/edu-loop.db', import.meta.url))

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const MODE = process.env.NODE_ENV === 'production' ? 'production' : 'development'

/** 已加载插件名（来自 Cordis 插件注册表，供启动日志与诊断）。 */
function pluginNames(root: Context): string[] {
  const names: string[] = []
  for (const runtime of root.registry.values()) {
    if (runtime.name) names.push(runtime.name)
  }
  return names
}

async function main(): Promise<void> {
  const llmConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

  // Cordis 根容器：仅加载 OpenTeach bundle；各模块插件由 bundle 按依赖顺序组装，
  // `.env` 由 bundle 在装配前载入（凭据经环境变量注入 provider）。
  const root = new Context()
  await root.plugin(openTeach, {
    llm: llmConfig,
    dbFilePath: DB_PATH,
    envPath: ENV_PATH,
    mode: MODE,
  })

  const app = root.get('app')!

  app.listen(PORT, () => {
    console.log(`[server] 运行模式=${MODE} http://localhost:${PORT}`)
    const llm = root.get('eduLlm')!
    console.log(`[server] 默认 provider=${llm.defaultProvider} model=${llm.defaultModel}`)
    console.log(`[server] 已加载插件：${pluginNames(root).join('、')}`)
    console.log('[server] 前端为独立应用（OpenTeach-frontend），请单独启动并在其中配置 OPENTEACH_API_BASE 指向本后端。')
  })
}

main().catch((error) => {
  console.error('[server] 启动失败', error)
  process.exitCode = 1
})