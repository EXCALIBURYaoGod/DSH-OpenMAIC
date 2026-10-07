/**
 * openmaic-layout 插件：用本地 @openmaic/dsl 的 PPTElement 契约，生成「完整 PPT
 * 绘制」的四点式布局（封面 / 内容卡片 / 进度 / 页码），作为独立内核插件对外暴露
 * `openmaic.layout` 服务。
 *
 * 设计要点（延续内核插件化 + degraded 哲学）：
 * - 不依赖 LLM，也不引入 @openmaic/generation 全依赖树；纯确定性布局生成。
 * - 元素全部符合 dsl 契约：
 *   - text.content 为 HTML 字符串（renderer 经 dangerouslySetInnerHTML 渲染）；
 *   - shape 用 viewBox + path 绘制主题色条/装饰块；
 *   - 每页 Slide 带 viewportSize/viewportRatio/theme/background。
 * - `openmaic-slide` 通过 `ctx.getOrNull('openmaic.layout')` 消费；本服务缺失时
 *   slide 降级为原线性 text 布局，不阻断闭环。
 *
 * @module plugins/openmaic-layout
 */

import type { Context } from '../../core/context.js'
import type { Plugin } from '../../core/plugin.js'

/** 一页布局的输入（由调用方从课程/课次提取）。 */
export interface LayoutPageInput {
  index: number
  /** 总页数（用于页码与进度）。 */
  total: number
  title: string
  bullets: string[]
  /** true 时渲染封面版式（居中大标题 + 副标题）。 */
  isCover?: boolean
  /** 可选副标题（封面用）。 */
  subtitle?: string
}

/** 布局产出的一页（符合 dsl Slide 契约的可渲染子集）。 */
export interface LayoutPage {
  id: string
  viewportSize: number
  viewportRatio: number
  theme: {
    backgroundColor: string
    themeColors: string[]
    fontColor: string
    fontName: string
  }
  background: { type: 'solid'; color: string }
  elements: Array<Record<string, unknown>>
  type?: string
  script?: string
}

export interface OpenmaicLayoutService {
  available: boolean
  /** 生成一页 PPT 布局（元素 + 主题 + 背景）。 */
  layoutSlide(input: LayoutPageInput): LayoutPage
}

// ---------------------------------------------------------------------------
// 布局常量
// ---------------------------------------------------------------------------

const VIEWPORT_W = 960
const VIEWPORT_H = 540
const RATIO = VIEWPORT_H / VIEWPORT_W // 0.5625

const THEME = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
}

/** 圆角矩形色条 path（viewBox 100x100，顶部细条/侧条经缩放）。 */
const ACCENT_BAR_PATH = 'M0,0H100V100H0Z'

/** 文本元素的内层 content 会被渲染端加上 10px 内边距，估算盒高时需一并计入。 */
const TEXT_PADDING = 20

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

/**
 * 估算文本在给定宽度下的折行数（CJK 按全宽、ASCII 按半宽）。
 *
 * 渲染端不提供自动撑高：文本框高度不足时内容会向下溢出并与下方元素叠字，
 * 因此这里按字号/行高预估所需高度，给每个文本框留出足够空间。
 */
function estimateLines(text: string, boxWidth: number, fontSize: number): number {
  const capacity = Math.max(1, Math.floor(boxWidth / fontSize))
  let units = 0
  for (const ch of text) units += ch.charCodeAt(0) < 0x100 ? 0.5 : 1
  return Math.max(1, Math.ceil(units / capacity))
}

/** 文本块渲染所需高度（含行高与内边距）。 */
function textBlockHeight(text: string, boxWidth: number, fontSize: number, lineHeight: number): number {
  return Math.ceil(estimateLines(text, boxWidth, fontSize) * fontSize * lineHeight) + TEXT_PADDING
}

/** 生成一个主题色条（shape 元素，契约要求 viewBox/fixedRatio/fill）。 */
function accentBar(left: number, top: number, w: number, h: number, color: string): Record<string, unknown> {
  return {
    type: 'shape',
    id: nextId('bar'),
    left,
    top,
    width: w,
    height: h,
    rotate: 0,
    viewBox: [100, 100],
    path: ACCENT_BAR_PATH,
    fixedRatio: false,
    fill: color,
  }
}

/**
 * 生成一个文本元素。content 为 HTML 串；fill 作为整盒背景。
 *
 * 注意：渲染端（@openmaic/renderer 的 BaseTextElement）只应用 content 的内联样式，
 * `PPTTextElement` 契约中并没有元素级 fontSize，写了也不生效。因此这里把
 * fontSize/lineHeight/color 一并内联进 content，否则文本会退回宿主页面默认字号。
 */
function textBox(
  id: string,
  left: number,
  top: number,
  w: number,
  h: number,
  html: string,
  opts: { color?: string; fill?: string; fontSize?: number; lineHeight?: number; textType?: string } = {},
): Record<string, unknown> {
  const color = opts.color ?? THEME.fontColor
  const fontSize = opts.fontSize ?? 24
  const lineHeight = opts.lineHeight ?? 1.5
  const content = `<div style="font-size:${fontSize}px;line-height:${lineHeight};color:${color};">${html}</div>`
  return {
    type: 'text',
    id,
    left,
    top,
    width: w,
    height: h,
    rotate: 0,
    content,
    defaultFontName: THEME.fontName,
    defaultColor: color,
    fill: opts.fill,
    lineHeight,
    textType: opts.textType,
  }
}

/** 要点文本转义，避免要点里的 `<` `&` 破坏 content 的 HTML 结构。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 要点 → HTML 卡片列表（内联样式，renderer 直接渲染）。 */
function bulletsHtml(bullets: string[]): string {
  return bullets
    .map((b) => {
      const esc = escapeHtml(b)
      return `
<div style="display:flex;align-items:center;gap:10px;background:#f4f7fb;border-left:4px solid ${THEME.themeColors[0]};border-radius:4px;padding:10px 14px;margin-bottom:10px;">
  <div style="width:8px;height:8px;border-radius:50%;background:${THEME.themeColors[0]};flex:none;"></div>
  <div style="font-size:20px;line-height:1.5;color:#3b4756;">${esc}</div>
</div>`
    })
    .join('')
}

/**
 * 封面版式：大标题 + 副标题 + 上下主题色条。
 *
 * 标题/副标题按实际折行数计算盒高，并在画布内整体垂直居中——固定盒高会让
 * 长标题向下溢出、与副标题叠字。
 */
function coverElements(input: LayoutPageInput): Array<Record<string, unknown>> {
  const color = THEME.themeColors[0]
  const width = VIEWPORT_W - 160
  const titleFontSize = 44
  const titleHeight = textBlockHeight(input.title, width, titleFontSize, 1.3)
  const subtitle = input.subtitle ?? ''
  const subFontSize = 22
  const subHeight = subtitle.length > 0 ? textBlockHeight(subtitle, width, subFontSize, 1.5) : 0
  const gap = 24

  const total = titleHeight + (subHeight > 0 ? gap + subHeight : 0)
  const startTop = Math.round((VIEWPORT_H - total) / 2)

  const elements: Array<Record<string, unknown>> = [
    accentBar(0, 0, VIEWPORT_W, 8, color),
    accentBar(0, VIEWPORT_H - 8, VIEWPORT_W, 8, color),
    textBox(nextId('cover-title'), 80, startTop, width, titleHeight, escapeHtml(input.title), {
      color: '#1f2a3a',
      fontSize: titleFontSize,
      lineHeight: 1.3,
      textType: 'title',
    }),
  ]
  if (subHeight > 0) {
    elements.push(
      textBox(
        nextId('cover-sub'),
        80,
        startTop + titleHeight + gap,
        width,
        subHeight,
        escapeHtml(subtitle),
        { color: '#5b6776', fontSize: subFontSize, textType: 'subtitle' },
      ),
    )
  }
  return elements
}

/** 内容版式：顶部标题栏 + 要点卡片 + 底部页码 + 进度条。 */
function contentElements(input: LayoutPageInput): Array<Record<string, unknown>> {
  const color = THEME.themeColors[0]
  const titleWidth = VIEWPORT_W - 80
  const titleTop = 32
  const titleHeight = textBlockHeight(input.title, titleWidth, 30, 1.2)
  const title = textBox(nextId('title'), 40, titleTop, titleWidth, titleHeight, escapeHtml(input.title), {
    color: '#1f2a3a',
    fontSize: 30,
    lineHeight: 1.2,
    textType: 'title',
  })
  // 下划线/正文依次排在标题实际高度之后，避免长标题压到它们。
  const underlineTop = titleTop + titleHeight + 8
  const underline = accentBar(40, underlineTop, 96, 5, color)
  const bodyTop = underlineTop + 28
  const body = textBox(
    nextId('body'),
    56,
    bodyTop,
    VIEWPORT_W - 112,
    VIEWPORT_H - bodyTop - 64,
    bulletsHtml(input.bullets),
  )
  const page = textBox(nextId('page'), VIEWPORT_W - 110, VIEWPORT_H - 44, 70, 24, String(input.index + 1), {
    color: '#8b95a3',
    fontSize: 16,
    textType: 'footer',
  })
  // 进度条：按页码在底部铺一段主题色细条。
  const progressW = Math.max(24, Math.round((VIEWPORT_W - 80) * ((input.index + 1) / input.total)))
  const progress = accentBar(40, VIEWPORT_H - 34, progressW, 4, color)
  return [title, underline, body, page, progress]
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export const openmaicLayoutPlugin: Plugin = {
  name: 'openmaic:layout',
  inject: [],
  provide: 'openmaic.layout',
  apply(ctx: Context) {
    const service: OpenmaicLayoutService = {
      available: true,
      layoutSlide(input) {
        const isCover = input.isCover === true || input.index === 0
        const elements = isCover ? coverElements(input) : contentElements(input)
        return {
          id: nextId('slide'),
          viewportSize: VIEWPORT_W,
          viewportRatio: RATIO,
          theme: { ...THEME },
          background: { type: 'solid', color: THEME.backgroundColor },
          elements,
          type: isCover ? 'cover' : 'content',
          script: input.bullets.join('；'),
        }
      },
    }

    ctx.service('openmaic.layout', service, 'openmaic:layout')
    console.log('[openmaic] layout 插件已加载（完整 PPT 布局生成器）')

    return () => {
      console.log('[openmaic] layout 插件停止')
    }
  },
}

/** 便捷读取（调用方可 getOrNull 判断是否存在）。 */
export function useOpenmaicLayout(ctx: Context): OpenmaicLayoutService {
  return ctx.get<OpenmaicLayoutService>('openmaic.layout')
}