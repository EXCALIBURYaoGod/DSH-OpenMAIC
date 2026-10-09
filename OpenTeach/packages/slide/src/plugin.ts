/**
 * openmaic-slide 插件：把本地 `@openmaic/dsl` + `@openmaic/generation` 封装为
 * DSH 风格插件，供教学闭环把课程要点转成 slide JSON。
 *
 * 轻量接入 + 可降级：
 * - 优先动态 import 本地 @openmaic/*（需先构建 dist 且在 server 依赖中可见）。
 * - 解析失败时退化为内置最小生成器，仍产出合法 slide JSON，并把服务标记为
 *   `available: false`，不阻断五步闭环主流程（复用现有 degraded 哲学）。
 *
 * @module plugins/openmaic-slide
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OpenmaicLayoutService, LayoutPage } from '@openteach/plugin-layout'

/** 服务对外暴露的能力。 */
export interface OpenmaicSlideService {
  /** 真实 @openmaic/dsl 是否可用。 */
  available: boolean
  /** 能力来源：'openmaic' | 'builtin-fallback'。 */
  source: 'openmaic' | 'builtin-fallback'
  /** 接入的 @openmaic/dsl 版本（降级时为 null）。 */
  dslVersion: string | null
  /** 把一组课程要点/讲解文本转成 slide JSON 文档。 */
  generateSlideJson(input: SlideInput): SlideDeck
  /** 结构校验（接入真实 dsl 时用 dsl 的 validateStage；降级用内置宽松断言）。 */
  validate(deck: SlideDeck): { valid: boolean; issues?: string[] }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 课程要点 → slide JSON 生成与校验服务。 */
    'openmaic.slide': OpenmaicSlideService
  }
}

export interface SlideInput {
  title: string
  /** 每页内容（要点列表）。 */
  pages: Array<{ title: string; bullets: string[] }>
}

/** 结果，兼容 PPTist 风格 slide JSON（含 slides 数组）。 */
export interface SlideDeck {
  id?: string
  name: string
  createdAt?: number
  updatedAt?: number
  /** 接入真机 dsl 时记录的 dsl 契约版本（降级时无此字段）。 */
  __dslVersion?: string
  slides: Array<{
    id: string
    elements: Array<Record<string, unknown>>
    remark?: string
    viewportSize?: number
    viewportRatio?: number
    theme?: Record<string, unknown>
    background?: Record<string, unknown>
  }>
}

/**
 * @openmaic/dsl 运行时最小接口（类型引用由 server 实际依赖解析）。
 * specifier 动态拼装规避 tsc 静态/打包器解析为本插件外的模块。
 */
type DslValidateResult = { valid: true } | { valid: false; errors: Array<{ path: string; message: string }> }

interface LoadedDsl {
  DSL_VERSION: string
  validateStage: (doc: unknown) => DslValidateResult
}

/** 加载真机 @openmaic/dsl；无法解析时返回 null（specifier 动态拼装以规避 tsc 静态解析）。 */
async function tryLoadOpenmaic(): Promise<LoadedDsl | null> {
  try {
    const spec = ['@openmaic', 'dsl'].join('/')
    const mod = (await import(/* @vite-ignore */ spec)) as Partial<LoadedDsl>
    if (typeof mod?.validateStage !== 'function') return null
    return {
      DSL_VERSION: typeof mod.DSL_VERSION === 'string' ? mod.DSL_VERSION : 'unknown',
      validateStage: mod.validateStage,
    }
  } catch {
    return null
  }
}

/** 内置最小生成器：每页 → 一组 text 元素，产出合法 slide JSON。 */
function buildDeckBuiltin(input: SlideInput): SlideDeck {
  const size = { w: 960, h: 540 }
  return {
    name: input.title,
    slides: input.pages.map((page, pi) => ({
      id: `slide-${pi}`,
      remark: page.title,
      elements: [
        {
          type: 'text' as const,
          id: `${pi}-title`,
          left: 48,
          top: 36,
          width: size.w - 96,
          height: 64,
          fontSize: 32,
          lineHeight: 1.4,
          color: '#1f2937',
          content: page.title,
        },
        ...page.bullets.map((bullet, bi) => ({
          type: 'text' as const,
          id: `${pi}-b${bi}`,
          left: 64,
          top: 120 + bi * 46,
          width: size.w - 128,
          height: 36,
          fontSize: 20,
          lineHeight: 1.5,
          color: '#374151',
          content: bullet,
        })),
      ],
    })),
  }
}

/** 宽松结构校验：slides 为数组且每页有 elements。 */
function validateDeck(deck: SlideDeck): { valid: boolean; issues?: string[] } {
  if (!Array.isArray(deck.slides)) return { valid: false, issues: ['slides 必须为数组'] }
  const issues: string[] = []
  for (const slide of deck.slides) {
    if (!Array.isArray(slide.elements)) issues.push(`slide ${slide.id} 缺少 elements`)
  }
  return { valid: issues.length === 0, issues }
}

/**
 * 基于 `openmaic.layout` 服务生成完整 PPT 版式：调用方传入的每一页会被 layout
 * 服务做成封面/内容卡片/进度/页码等四点式布局元素。所有产出 Slide 均符合 dsl
 * 契约（viewportSize/viewportRatio/theme/background/elements）。
 */
function buildDeckWithLayout(layout: OpenmaicLayoutService, input: SlideInput): SlideDeck {
  const now = Date.now()
  const stageId = `stage-${now}`
  const pages = input.pages.map<LayoutPage>((page, pi) =>
    layout.layoutSlide({
      index: pi,
      total: input.pages.length,
      title: page.title,
      bullets: page.bullets,
      isCover: pi === 0,
      // 封面副标题取本页要点（首页即课次目标）。不能沿用 input.title——首页标题
      // 本身就是 input.title，会导致封面大标题与副标题出现同一句话。
      subtitle: page.bullets[0] ?? '',
    }),
  )

  // 对外扁平结构：slides 每项即完整契约 Slide，前端 Renderer 直接可用。
  const slides: SlideDeck['slides'] = pages.map((page) => ({
    id: page.id,
    remark: page.type === 'cover' ? input.title : page.script,
    viewportSize: page.viewportSize,
    viewportRatio: page.viewportRatio,
    theme: page.theme,
    background: page.background,
    elements: page.elements,
  }))

  const deck: SlideDeck & {
    __dslVersion?: string
    scenes?: Array<{
      type: 'slide'
      id: string
      stageId: string
      title: string
      order: number
      content: { type: 'slide'; schemaVersion: number; canvas: Record<string, unknown> }
    }>
  } = {
    id: stageId,
    name: input.title,
    createdAt: now,
    updatedAt: now,
    slides,
    scenes: pages.map((page, pi) => ({
      type: 'slide' as const,
      id: page.id,
      stageId,
      title: page.script ?? `Page ${pi + 1}`,
      order: pi,
      content: {
        type: 'slide' as const,
        schemaVersion: 1,
        canvas: {
          id: page.id,
          viewportSize: page.viewportSize,
          viewportRatio: page.viewportRatio,
          theme: page.theme,
          background: page.background,
          elements: page.elements,
        },
      },
    })),
  }
  return deck
}

/**
 * 接入真机 @openmaic/dsl 的生成器：把每个要点页包装成 dsl 的 `Scene`（type=slide，
 * content.canvas 为 PPTist 风格 {@link Slide}），并包进 `Stage` 容器文档。返回的
 * 文档既满足本服务对外契约（slides 数组），又能通过 `dsl.validateStage` / `validateScene`。
 */
function buildDeckDsl(dsl: LoadedDsl): (input: SlideInput) => SlideDeck {
  return (input: SlideInput): SlideDeck => {
    const now = Date.now()
    const stageId = `stage-${now}`
    const size = { w: 960, h: 540 }
    // 契约要求的 viewport 与主题（renderer 的 SlideCanvas 依赖这些字段做自适应与配色）。
    const viewportRatio = size.h / size.w
    const theme = {
      backgroundColor: '#ffffff',
      themeColors: ['#409eff'],
      fontColor: '#374151',
      fontName: 'Microsoft YaHei',
    }
    const background = { type: 'solid' as const, color: '#ffffff' }

    // 每页元素：text 元素按 PPTTextElement 契约补 defaultColor/defaultFontName/rotate。
    const pages = input.pages.map((page, pi) => ({
      id: `scene-${pi}`,
      remark: page.title,
      viewportSize: size.w,
      viewportRatio,
      theme,
      background,
      elements: [
        {
          type: 'text' as const,
          id: `${pi}-title`,
          left: 48,
          top: 36,
          width: size.w - 96,
          height: 64,
          rotate: 0,
          fontSize: 32,
          lineHeight: 1.4,
          color: '#1f2937',
          defaultColor: '#1f2937',
          defaultFontName: theme.fontName,
          content: page.title,
        },
        ...page.bullets.map((bullet, bi) => ({
          type: 'text' as const,
          id: `${pi}-b${bi}`,
          left: 64,
          top: 120 + bi * 46,
          width: size.w - 128,
          height: 36,
          rotate: 0,
          fontSize: 20,
          lineHeight: 1.5,
          color: '#374151',
          defaultColor: '#374151',
          defaultFontName: theme.fontName,
          content: bullet,
        })),
      ],
    }))

    // 对外扁平结构：slides 每项即完整契约 Slide（含 viewportSize/theme 等），前端 Renderer 直接可用。
    const slides: SlideDeck['slides'] = pages.map(page => ({
      id: page.id,
      remark: page.remark,
      viewportSize: page.viewportSize,
      viewportRatio: page.viewportRatio,
      theme: page.theme,
      background: page.background,
      elements: page.elements,
    }))

    // 组装符合 dsl Stage / Scene 契约的容器文档（除 TypeScript 结构外，字段也满足
    // validateStage 与 validateScene 的必填约束）。
    const deck = {
      id: stageId,
      name: input.title,
      createdAt: now,
      updatedAt: now,
      slides,
      __dslVersion: dsl.DSL_VERSION,
      scenes: pages.map((page, pi) => ({
        type: 'slide' as const,
        id: page.id,
        stageId,
        title: page.remark,
        order: pi,
        content: {
          type: 'slide' as const,
          schemaVersion: 1,
          canvas: {
            id: page.id,
            viewportSize: page.viewportSize,
            viewportRatio: page.viewportRatio,
            theme: page.theme,
            background: page.background,
            elements: page.elements,
          },
        },
      })),
    }
    return deck
  }
}

// ---------------------------------------------------------------------------
// 插件（Cordis 原生：命名导出 name / provide / inject / apply）
// ---------------------------------------------------------------------------

export const name = 'openmaic:slide'
export const inject = ['eduLlm', 'repo']
export const provide = 'openmaic.slide'

export async function apply(ctx: Context): Promise<() => void> {
  // 依赖由 Cordis 经 inject 保障：进入 apply 时 eduLlm / repo 已就绪。
  void ctx.get('eduLlm')
  void ctx.get('repo')

  const dsl = await tryLoadOpenmaic()
  // 优先消费 openmaic.layout 服务（完整 PPT 布局生成器）；缺失时降级 dsl/内置。
  const layout = ctx.get('openmaic.layout') ?? null

  // 接入真实 @openmaic/dsl：产出符合 dsl Stage/Scene 契约的文档并用其校验。
  const generate = layout
    ? (input: SlideInput): SlideDeck => buildDeckWithLayout(layout, input)
    : dsl
      ? buildDeckDsl(dsl)
      : buildDeckBuiltin
  const validate = dsl
    ? (deck: SlideDeck): { valid: boolean; issues?: string[] } => {
        const result = dsl.validateStage(deck)
        return result.valid
          ? { valid: true }
          : { valid: false, issues: result.errors.map((e) => `${e.path}: ${e.message}`) }
      }
    : validateDeck

  const service: OpenmaicSlideService = {
    available: dsl !== null,
    source: dsl ? 'openmaic' : 'builtin-fallback',
    dslVersion: dsl?.DSL_VERSION ?? null,
    generateSlideJson(input) {
      return generate(input)
    },
    validate(deck) {
      return validate(deck)
    },
  }

  ctx.provide('openmaic.slide', service)

  if (!dsl) {
    console.warn('[openmaic] 未解析到 @openmaic/dsl 产物，slide 能力降级为内置生成器（不阻断闭环）。')
  }

  return () => {
    console.log(`[openmaic] slide 插件停止（source=${service.source}）`)
  }
}

/** 便捷读取（可能降级，调用方需看 available）。 */
export function useOpenmaicSlide(ctx: Context): OpenmaicSlideService {
  return ctx.get('openmaic.slide')!
}