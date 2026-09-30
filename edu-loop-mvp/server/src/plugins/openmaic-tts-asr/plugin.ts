/**
 * openmaic-tts-asr 插件：把 OpenMAIC `lib/audio` 的语音 Provider 层（TTS/ASR）
 * 插件化到本内核。复刻 llm 插件的「config + key 注入 + 可降级」范式：
 * - `openmaic.tts`：provider 元数据注册表 + `generate(config, text)` 路由。
 * - `openmaic.asr`：provider 元数据注册表 + `transcribe(config, audio)` 路由。
 *
 * 仅接入最小可运行子集：openai-tts / openai-whisper（真实 HTTP）+ browser-native 桩。
 * 其余 provider 需要 providerId 穿透到自定义实现时，可在后续按同一 factory 扩展，
 * 不会破坏现有契约。
 *
 * @module plugins/openmaic-tts-asr
 */

import type { Context } from '../../core/context.js'
import type { Plugin } from '../../core/plugin.js'
import { resolveCredential } from '../../config/env.js'

// ---------------------------------------------------------------------------
// 契约类型（对齐 openmaic lib/audio types.ts 的最小可接入子集）
// ---------------------------------------------------------------------------

export interface TTSModelConfig {
  providerId: string
  modelId?: string
  apiKey?: string
  baseUrl?: string
  voice: string
  speed?: number
  format?: string
  signal?: AbortSignal
}

export interface TTSGenerationResult {
  audio: Uint8Array
  format: string
}

export interface TTSProviderMeta {
  id: string
  name: string
  requiresApiKey: boolean
  defaultBaseUrl?: string
  supportedFormats: string[]
}

export interface ASRModelConfig {
  providerId: string
  modelId?: string
  apiKey?: string
  baseUrl?: string
  language?: string
  signal?: AbortSignal
}

export interface ASRTranscriptionResult {
  text: string
}

export interface ASRProviderMeta {
  id: string
  name: string
  requiresApiKey: boolean
  defaultBaseUrl?: string
  supportedLanguages: string[]
}

// ---------------------------------------------------------------------------
// Provider registry（静态元数据，可按 llm.config 的 key 注入动态扩展）
// ---------------------------------------------------------------------------

const TTS_PROVIDERS: Record<string, TTSProviderMeta> = {
  'openai-tts': {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportedFormats: ['mp3', 'opus', 'aac', 'flac'],
  },
  'browser-native-tts': {
    id: 'browser-native-tts',
    name: 'Browser Native TTS',
    requiresApiKey: false,
    supportedFormats: [],
  },
}

const ASR_PROVIDERS: Record<string, ASRProviderMeta> = {
  'openai-whisper': {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportedLanguages: ['auto'],
  },
  'browser-native': {
    id: 'browser-native',
    name: 'Browser Native ASR',
    requiresApiKey: false,
    supportedLanguages: ['auto'],
  },
}

export function listTTSProviders(): TTSProviderMeta[] {
  return Object.values(TTS_PROVIDERS)
}

export function listASRProviders(): ASRProviderMeta[] {
  return Object.values(ASR_PROVIDERS)
}

// ---------------------------------------------------------------------------
// TTS provider 实现
// ---------------------------------------------------------------------------

async function generateOpenAITTS(config: TTSModelConfig, text: string): Promise<TTSGenerationResult> {
  const meta = TTS_PROVIDERS['openai-tts']!
  const apiKey = config.apiKey ?? resolveCredential('OPENAI_API_KEY')
  if (!apiKey) throw new Error(`TTS provider ${config.providerId} 需要 API Key`)
  const baseUrl = config.baseUrl ?? meta.defaultBaseUrl
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    signal: config.signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.modelId ?? 'tts-1',
      input: text,
      voice: config.voice,
      ...(config.speed === undefined ? {} : { speed: config.speed }),
      ...(config.format === undefined ? {} : { response_format: config.format }),
    }),
  })
  if (!response.ok) {
    throw new Error(`OpenAI TTS API error: ${response.status} ${response.statusText}`)
  }
  const buffer = await response.arrayBuffer()
  return { audio: new Uint8Array(buffer), format: config.format ?? 'mp3' }
}

/** 聚合 TTS 路由。 */
async function generateTTS(config: TTSModelConfig, text: string): Promise<TTSGenerationResult> {
  switch (config.providerId) {
    case 'openai-tts':
      return generateOpenAITTS(config, text)
    case 'browser-native-tts':
      throw new Error('Browser Native TTS 需在浏览器侧通过 Web Speech API 调用，服务端不支持。')
    default:
      throw new Error(`暂不支持的 TTS provider: ${config.providerId}`)
  }
}

// ---------------------------------------------------------------------------
// ASR provider 实现
// ---------------------------------------------------------------------------

async function transcribeOpenAIWhisper(
  config: ASRModelConfig,
  audio: Buffer,
): Promise<ASRTranscriptionResult> {
  const meta = ASR_PROVIDERS['openai-whisper']!
  const apiKey = config.apiKey ?? resolveCredential('OPENAI_API_KEY')
  if (!apiKey) throw new Error(`ASR provider ${config.providerId} 需要 API Key`)
  const baseUrl = config.baseUrl ?? meta.defaultBaseUrl
  const form = new FormData()
  form.set('file', new Blob([audio], { type: 'audio/webm' }), 'audio.webm')
  form.set('model', config.modelId ?? 'whisper-1')
  if (config.language && config.language !== 'auto') form.set('language', config.language)
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    signal: config.signal,
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  })
  if (!response.ok) {
    throw new Error(`OpenAI Whisper API error: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as { text?: string }
  return { text: data.text ?? '' }
}

/** 聚合 ASR 路由。 */
async function transcribeASR(config: ASRModelConfig, audio: Buffer): Promise<ASRTranscriptionResult> {
  switch (config.providerId) {
    case 'openai-whisper':
      return transcribeOpenAIWhisper(config, audio)
    case 'browser-native':
      throw new Error('Browser Native ASR 需在浏览器侧通过 Web Speech API 调用，服务端不支持。')
    default:
      throw new Error(`暂不支持的 ASR provider: ${config.providerId}`)
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface OpenmaicTtsService {
  listProviders(): TTSProviderMeta[]
  /** 可用 provider（requiresApiKey=false 的始终可用；需 key 的看是否注入/可解析）。 */
  availableProviderIds(): string[]
  generate(config: TTSModelConfig, text: string): Promise<TTSGenerationResult>
}

export interface OpenmaicAsrService {
  listProviders(): ASRProviderMeta[]
  availableProviderIds(): string[]
  transcribe(config: ASRModelConfig, audio: Buffer): Promise<ASRTranscriptionResult>
}

export const openmaicAudioPlugin: Plugin = {
  name: 'openmaic:audio',
  provide: ['openmaic.tts', 'openmaic.asr'],
  apply(ctx: Context) {
    const hasOpenKey = resolveCredential('OPENAI_API_KEY') !== undefined

    const tts: OpenmaicTtsService = {
      listProviders: listTTSProviders,
      availableProviderIds() {
        return listTTSProviders()
          .filter(p => !p.requiresApiKey || hasOpenKey)
          .map(p => p.id)
      },
      generate(config, text) {
        return generateTTS(config, text)
      },
    }

    const asr: OpenmaicAsrService = {
      listProviders: listASRProviders,
      availableProviderIds() {
        return listASRProviders()
          .filter(p => !p.requiresApiKey || hasOpenKey)
          .map(p => p.id)
      },
      transcribe(config, audio) {
        return transcribeASR(config, audio)
      },
    }

    ctx.service('openmaic.tts', tts, 'openmaic:audio')
    ctx.service('openmaic.asr', asr, 'openmaic:audio')

    if (!hasOpenKey) {
      console.warn('[openmaic] 未配置 OPENAI_API_KEY，audio 仅开放 browser-native 桩；配置后可用 openai-tts / openai-whisper。')
    }

    return () => {
      console.log('[openmaic] audio 插件停止')
    }
  },
}

/** 便捷读取。 */
export function useOpenmaicAudio(ctx: Context): {
  tts: OpenmaicTtsService
  asr: OpenmaicAsrService
} {
  return {
    tts: ctx.get<OpenmaicTtsService>('openmaic.tts'),
    asr: ctx.get<OpenmaicAsrService>('openmaic.asr'),
  }
}