/**
 * openmaic-generation 插件：把 OpenMAIC `@openmaic/generation` 的两阶段生成管线
 * （outline → complete scene）插件化，注入本项目自建的 `llm` 服务作为模型出口。
 *
 * 能力与降级（延续 storage / slide 的既有哲学）：
 * - `generateSceneOutlinesFromRequirements`：用 LLM 把需求（主题/学习目标）生成课程
 *   outline；当 `llm` 处于 mock 降级态时，仍能产出结构化 outline（仅来源不同）。
 * - `buildCompleteScene`：把 outline + 讲解内容装配成一个符合 storage `docs.store`
 *   场景形状（{ id, title, content }）的不可逆场景文档。
 *
 * 输出契约对齐 OpenMAIC `SceneOutline` / `CompleteScene` 的最小可接入子集，保证
 * 上层教学闭环与持久层解耦——无论底层是真模型还是 mock，调用方无需感知差异。
 *
 * @module plugins/openmaic-generation
 */

import type { Context } from '../../core/context.js'
import type { Plugin } from '../../core/plugin.js'
import type { LoadedLlm } from '../../llm/loader.js'
import { assembleStream } from '../../llm/registry.js'

// ---------------------------------------------------------------------------
// 契约类型（对齐 @openmaic/generation 的最小可接入子集）
// ---------------------------------------------------------------------------

/** 生成请求输入（UserRequirements 的最小视图）。 */
export interface SceneGenerationInput {
  topic: string
  /** 可选学习目标描述。 */
  learningGoals?: string
  /** 可选输出语言指令。 */
  language?: string
}

/** 单页场景大纲（对齐 @openmaic/generation 的 SceneOutline）。 */
export interface SceneOutline {
  type: 'slide'
  title: string
  description?: string
  keyPoints: string[]
  order: number
}

/** 第一阶段产出（对齐 GenerationResult<GeneratedOutline>）。 */
export interface GeneratedOutline {
  courseTitle: string
  languageDirective?: string
  outlines: SceneOutline[]
}

export type GenerationResult<T> = {
  success: boolean
  data?: T
  error?: string
}

/** 完整场景（对齐 buildCompleteScene 的产物形态，兼容 storage docs.store）。 */
export interface CompleteScene {
  id: string
  title: string
  order: number
  /** 页面标题；desc 为讲解正文。 */
  desc?: string
  content: { type: 'slide' }
}

export interface OpenmaicGenerationService {
  /** 底层是否是真实 LLM 接入（非 mock 降级）。 */
  available: boolean
  /** 能力来源：'llm' | 'mock'。 */
  source: 'llm' | 'mock'
  /** 第一阶段：需求 → 课程大纲。 */
  generateSceneOutlinesFromRequirements(
    input: SceneGenerationInput,
  ): Promise<GenerationResult<GeneratedOutline>>
  /** 第二阶段：outline + 讲解内容 → 完整场景文档。 */
  buildCompleteScene(outline: SceneOutline, content: string): CompleteScene
}

// ---------------------------------------------------------------------------
// 从本内核认证的 `llm` 服务构造 generation 的最小 AICallFn
// ---------------------------------------------------------------------------

/**
 * AICallFn 适配器：把 generation 的 `(systemPrompt, userPrompt, images?)` 约定
 * 映射到 `llm.runtime.stream` 的一次调用，并装配为完整文本。
 */
function makeAiCall(loaded: LoadedLlm) {
  return async (
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> => {
    const assembled = await assembleStream(
      loaded.runtime.stream({
        provider: loaded.defaultProvider,
        model: loaded.defaultModel,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    )
    if (assembled.finish.kind === 'error' || assembled.finish.kind === 'aborted') {
      throw new Error(`generation: LLM 调用失败 (${assembled.finish.kind}: ${assembled.finish.failure.message})`)
    }
    return assembled.text
  }
}

/** 从模型返回文本中提取第一个 JSON 对象（宽松解析，抓取首尾大括号）。 */
function extractJson<T>(text: string): T | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 内置 outline 生成器：无真实模型凭据时退化为确定性结构（source='mock'）
// ---------------------------------------------------------------------------

function builtinOutline(input: SceneGenerationInput): GeneratedOutline {
  const topic = input.topic || '未命名主题'
  const titles = [
    `${topic}：核心概念与地图`,
    `${topic}：典型方法与步骤`,
    `${topic}：综合应用与迁移`,
  ]
  return {
    courseTitle: `${topic}：从入门到实践`,
    languageDirective: input.language ?? 'zh',
    outlines: titles.map((title, order) => ({
      type: 'slide' as const,
      title,
      description: `本页围绕「${title}」展开，为学习路径的关键一环。`,
      keyPoints: ['定义与边界', '关键术语', '与相邻概念的关系'],
      order,
    })),
  }
}

/** 把 mock(llm-降级) 返回的提纲平面化到统一契约（mock 返回 {title,summary,lessons}）。 */
function normalizeMockOutline(data: Record<string, unknown>, input: SceneGenerationInput): GeneratedOutline {
  const lessons = Array.isArray(data.lessons) ? data.lessons : []
  return {
    courseTitle: typeof data.title === 'string' ? data.title : `${input.topic}：从入门到实践`,
    languageDirective: input.language ?? 'zh',
    outlines: lessons.map((lesson, order) => {
      const rec = lesson as Record<string, unknown>
      return {
        type: 'slide' as const,
        title: typeof rec.title === 'string' ? rec.title : `第 ${order + 1} 页`,
        description: typeof rec.objective === 'string' ? rec.objective : undefined,
        keyPoints: Array.isArray(rec.keyPoints)
          ? (rec.keyPoints as string[])
          : ['要点 1', '要点 2', '要点 3'],
        order,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export interface GenerationConfig {
  /** 模型不可用时回退：true 时始终走内置生成器（不发起 LLM 调用）。 */
  forceMock?: boolean
}

export const openmaicGenerationPlugin: Plugin<GenerationConfig> = {
  name: 'openmaic:generation',
  inject: ['llm'],
  provide: 'openmaic.generation',
  apply(ctx: Context, config?: GenerationConfig) {
    const loaded = ctx.get<LoadedLlm>('llm')
    const forceMock = config?.forceMock ?? false
    // 以默认路由是否被 mock 顶替为「真实 LLM」信号；降级 provider 越多越可能为 mock。
    const source: OpenmaicGenerationService['source'] =
      forceMock || loaded.degradedProviders.has(loaded.defaultProvider) ? 'mock' : 'llm'

    const aiCall = makeAiCall(loaded)

    const service: OpenmaicGenerationService = {
      available: source === 'llm',
      source,
      async generateSceneOutlinesFromRequirements(input) {
        try {
          // 强制 mock 或确认降级态时：直接走内置生成器，避免无效调用。
          if (source === 'mock') {
            const data = builtinOutline(input)
            return { success: true, data }
          }

          const systemPrompt =
            '你是资深教学设计专家。请把用户需求拆解为一门课程的多页大纲。' +
            '只用 JSON 输出，不要附加任何解释或代码围栏。'
          const userPrompt =
            `[[task:course_outline]]\n主题：${input.topic}` +
            (input.learningGoals ? `\n学习目标：${input.learningGoals}` : '') +
            (input.language ? `\n语言：${input.language}` : '')

          const raw = await aiCall(systemPrompt, userPrompt)
          const parsed = extractJson<Record<string, unknown>>(raw)
          // 模型可能直接返回统一契约（有 outlines），也可能是 mock 风格（有 lessons）。
          const data: GeneratedOutline = parsed && Array.isArray(parsed.outlines)
            ? {
                courseTitle: typeof parsed.courseTitle === 'string' ? parsed.courseTitle : input.topic,
                languageDirective: typeof parsed.languageDirective === 'string' ? parsed.languageDirective : input.language,
                outlines: (parsed.outlines as unknown[]).map((o, order) => {
                  const rec = o as Record<string, unknown>
                  return {
                    type: 'slide' as const,
                    title: String(rec.title ?? `第 ${order + 1} 页`),
                    description: typeof rec.description === 'string' ? rec.description : undefined,
                    keyPoints: Array.isArray(rec.keyPoints)
                      ? (rec.keyPoints as string[])
                      : ['要点 1', '要点 2', '要点 3'],
                    order,
                  }
                }),
              }
            : parsed
              ? normalizeMockOutline(parsed, input)
              : builtinOutline(input) // 严格解析失败也回退，保证闭环可跑。
          return { success: true, data }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      buildCompleteScene(outline, content) {
        return {
          id: `scene-${outline.order}`,
          title: outline.title,
          order: outline.order,
          desc: content,
          content: { type: 'slide' },
        }
      },
    }

    ctx.service('openmaic.generation', service, 'openmaic:generation')

    if (source === 'mock') {
      console.warn('[openmaic] generation 未接入真实模型凭据，降级为内置 outline 生成器（不阻断闭环）。')
    }

    return () => {
      console.log(`[openmaic] generation 插件停止（source=${service.source}）`)
    }
  },
}

/** 便捷读取。 */
export function useOpenmaicGeneration(ctx: Context): OpenmaicGenerationService {
  return ctx.get<OpenmaicGenerationService>('openmaic.generation')
}