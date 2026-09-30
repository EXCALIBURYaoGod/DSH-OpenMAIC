/**
 * 服务入口：用 Cordis-style 内核装配插件 → 启动 HTTP 服务。
 *
 * 装配顺序：llm → db → http。http 依赖 llm/repo，因此必须在它们之后加载。
 *
 * @module index
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadDotEnv } from './config/env.js'
import { assertValidConfig, type LlmConfigFile } from './llm/config.js'
import { llmPlugin } from './llm/plugin.js'
import { dbPlugin } from './db/plugin.js'
import { httpPlugin } from './http/plugin.js'
import { openmaicSlidePlugin } from './plugins/openmaic-slide/plugin.js'
import { openmaicLayoutPlugin } from './plugins/openmaic-layout/plugin.js'
import { openmaicStoragePlugin } from './plugins/openmaic-storage/plugin.js'
import { openmaicGenerationPlugin } from './plugins/openmaic-generation/plugin.js'
import { openmaicAudioPlugin } from './plugins/openmaic-tts-asr/plugin.js'
import { createKernel } from './core/kernel.js'
import type { Express } from 'express'

const ROOT = new URL('../../', import.meta.url)
const CONFIG_PATH = fileURLToPath(new URL('llm.config.json', ROOT))
const ENV_PATH = fileURLToPath(new URL('.env', ROOT))
const DB_PATH = fileURLToPath(new URL('../data/edu-loop.db', import.meta.url))
const WEB_DIST = fileURLToPath(new URL('web/dist', ROOT))

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)

function main(): void {
  loadDotEnv(ENV_PATH)

  const raw = readFileSync(CONFIG_PATH, 'utf8')
  const llmConfig = JSON.parse(raw) as LlmConfigFile
  assertValidConfig(llmConfig)

  // 内核装配（Cordis-style）。llm→db→http，openmaic 插件依赖 llm/repo。
  const kernel = createKernel()
  // 把内核自身作为服务暴露，供 http 插件输出 /api/plugins 诊断拓扑。
  kernel.root.service('kernel', kernel, 'internal')

  void bootstrap(kernel, llmConfig)
}

async function bootstrap(kernel: ReturnType<typeof createKernel>, llmConfig: LlmConfigFile): Promise<void> {
  await kernel.plugin(llmPlugin, llmConfig)
  await kernel.plugin(dbPlugin, { filePath: DB_PATH })
  await kernel.plugin(openmaicStoragePlugin)
  await kernel.plugin(openmaicGenerationPlugin)
  await kernel.plugin(openmaicLayoutPlugin)
  await kernel.plugin(openmaicSlidePlugin)
  await kernel.plugin(openmaicAudioPlugin)
  await kernel.plugin(httpPlugin, { webDist: WEB_DIST })

  const app = kernel.root.get<Express>('app')

  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`)
    const llm = kernel.root.get<import('./llm/loader.js').LoadedLlm>('llm')
    console.log(`[server] 默认 provider=${llm.defaultProvider} model=${llm.defaultModel}`)
    console.log(`[server] 已加载插件：${kernel.listPlugins().join('、')}`)
  })
}

main()