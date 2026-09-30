/**
 * openmaic-tts-asr 插件 smoke：验证 provider registry、可用性判定与
 * browser-native 桩的抛错行为，以及服务随插件卸载而移除。
 *
 * 运行：node --import tsx scripts/audio-smoke.mts
 *
 * @module scripts/audio-smoke
 */

import { strict as assert } from 'node:assert'
import { createKernel } from '../src/core/kernel.js'
import {
  openmaicAudioPlugin,
  useOpenmaicAudio,
} from '../src/plugins/openmaic-tts-asr/plugin.js'

async function run(): Promise<void> {
  const kernel = createKernel()
  const handle = await kernel.plugin(openmaicAudioPlugin)
  const { tts, asr } = useOpenmaicAudio(kernel.root)

  // --- TTS ---
  const ttsProviders = tts.listProviders()
  assert.ok(ttsProviders.some(p => p.id === 'openai-tts'), '应注册 openai-tts')
  assert.ok(ttsProviders.some(p => p.id === 'browser-native-tts'), '应注册 browser-native-tts')

  // 未配置 OPENAI_API_KEY → 可用 provider 只含 browser-native 桩。
  const available = tts.availableProviderIds()
  assert.ok(available.some(p => p === 'browser-native-tts'), 'browser-native-tts 始终可用')
  assert.ok(!available.includes('openai-tts'), '未配 key 时 openai-tts 不应可用')

  // browser-native 桩抛定向错误（客户端能力）。
  await assert.rejects(
    () => tts.generate({ providerId: 'browser-native-tts', voice: 'zh' }, '你好'),
    /Browser Native TTS/,
    'browser-native-tts 服务端应抛客户端专用错误',
  )

  // --- ASR ---
  const asrProviders = asr.listProviders()
  assert.ok(asrProviders.some(p => p.id === 'openai-whisper'), '应注册 openai-whisper')
  assert.ok(asrProviders.some(p => p.id === 'browser-native'), '应注册 browser-native')

  assert.ok(!asr.availableProviderIds().includes('openai-whisper'), '未配 key 时 whisper 不应可用')

  await assert.rejects(
    () => asr.transcribe({ providerId: 'browser-native', language: 'zh' }, Buffer.from([1, 2, 3])),
    /Browser Native ASR/,
    'browser-native ASR 服务端应抛客户端专用错误',
  )

  console.log('[audio] smoke 通过  tts=registry/available/stub=✓  asr=registry/available/stub=✓')

  handle.dispose()
  assert.equal(kernel.root.has('openmaic.tts'), false, '卸载后 openmaic.tts 应移除')
  assert.equal(kernel.root.has('openmaic.asr'), false, '卸载后 openmaic.asr 应移除')
}

run().catch(error => {
  console.error('[audio] smoke 失败', error)
  process.exitCode = 1
})