/**
 * 服务入口：用 Cordis 原生内核装配插件 → 启动 HTTP 服务。
 *
 * 装配顺序：llm → db → http。http 依赖 llm/repo，openmaic 插件依赖 llm/db/repo，
 * 因此必须在它们之后加载。所有插件均为 Cordis 原生模块（命名导出
 * `name` / `provide` / `Config` / `apply`），直接交给 `root.plugin()` 加载；
 * 服务经 `ctx.provide()` 注册，随各自 fiber 卸载自动回收。
 *
 * @module index
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { loadDotEnv } from './config/env.js'
import { resolveAppMode } from './config/mode.js'
import { assertValidConfig, type LlmConfigFile } from './llm/config.js'
import * as llmPlugin from './llm/plugin.js'
import * as dbPlugin from './db/plugin.js'
import * as httpPlugin from './http/plugin.js'
import * as openmaicSlidePlugin from './plugins/openmaic-slide/plugin.js'
import * as openmaicLayoutPlugin from './plugins/openmaic-layout/plugin.js'
import * as openmaicStoragePlugin from './plugins/openmaic-storage/plugin.js'
import * as openmaicGenerationPlugin from './plugins/openmaic-generation/plugin.js'
import * as openmaicAudioPlugin from './plugins/openmaic-tts-asr/plugin.js'

const ROOT = new URL('../../', import.meta.url)
const CONFIG_PATH = fileURLToPath(new URL('llm.config.json', ROOT))
const ENV_PATH = fileURLToPath(new URL('.env', ROOT))
const DB_PATH = fileURLToPath(new URL('../data/edu-loop.db', import.meta.url))
const WEB_DIST = fileURLToPath(new URL('web/dist', ROOT))

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)

/** 已加载插件名（来自 Cordis 插件注册表，供启动日志与诊断）。 */
function pluginNames(root: Context): string[] {
  const names: string[] = []
  for (const runtime of root.registry.values()) {
    if (runtime.name) names.push(runtime.name)
  }
  return names
}

async function main(): Promise<void> {
  loadDotEnv(ENV_PATH)

  const mode = resolveAppMode()

  const raw = readFileSync(CONFIG_PATH, 'utf8')
  const llmConfig = JSON.parse(raw) as LlmConfigFile
  assertValidConfig(llmConfig)

  // Cordis 根容器：装配 llm → db → openmaic* → http。
  const root = new Context()

  await root.plugin(llmPlugin, llmConfig)
  await root.plugin(dbPlugin, { filePath: DB_PATH })
  await root.plugin(openmaicStoragePlugin)
  await root.plugin(openmaicGenerationPlugin)
  await root.plugin(openmaicLayoutPlugin)
  await root.plugin(openmaicSlidePlugin)
  await root.plugin(openmaicAudioPlugin)
  // 仅生产模式托管前端构建产物；开发模式下前端跑在 vite（5173），由 vite 代理 /api。
  await root.plugin(httpPlugin, {
    mode,
    ...(mode === 'production' ? { webDist: WEB_DIST } : {}),
  })

  const app = root.get('app')!

  app.listen(PORT, () => {
    console.log(`[server] 运行模式=${mode} http://localhost:${PORT}`)
    if (mode === 'production') {
      if (existsSync(join(WEB_DIST, 'index.html'))) {
        console.log(`[server] 已托管前端构建产物：${WEB_DIST}`)
      } else {
        console.warn(`[server] 未找到前端构建产物（${WEB_DIST}），请先执行 pnpm build；当前仅提供 API。`)
      }
    }
    const llm = root.get('llm')!
    console.log(`[server] 默认 provider=${llm.defaultProvider} model=${llm.defaultModel}`)
    console.log(`[server] 已加载插件：${pluginNames(root).join('、')}`)
  })
}

main().catch((error) => {
  console.error('[server] 启动失败', error)
  process.exitCode = 1
})
