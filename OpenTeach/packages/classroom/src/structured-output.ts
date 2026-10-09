/**
 * 结构化输出解析器（移植自 OpenMAIC `lib/orchestration/stateless-generate.ts` 的解析部分）。
 *
 * 子智能体被要求只返回一个 JSON 数组，数组项在「自然语音」与「静默动作」之间自由交织：
 * ```
 * [{"type":"action","name":"spotlight","params":{"elementId":"img_1"}},
 *  {"type":"text","content":"看这里，这一步是后面机制成立的关键。"}, ...]
 * ```
 *
 * 本模块在**流式**过程中增量解析该数组：完整项立即发出（action→动作事件，
 * text→文本增量），末尾未完成的 text 项则持续吐出文本增量（边生成边说）。
 *
 * 与 OpenMAIC 原实现的差异：原实现依赖 `partial-json` + `jsonrepair` 两个 npm 包。
 * 本移植改为**自包含**的字符扫描器（跟踪字符串/转义/嵌套深度），对同一契约做等价
 * 增量解析——避免新增依赖，并使行为在无外部包时完全确定、可测。
 *
 * @module plugins/openmaic-classroom/structured-output
 */

/** 解析出的静默动作（对齐 OpenMAIC `ParsedAction`）。 */
export interface ParsedAction {
  actionId: string
  actionName: string
  params: Record<string, unknown>
}

/** 增量解析状态（在多次 `parseStructuredChunk` 调用间复用）。 */
export interface ParserState {
  /** 累积的原始文本。 */
  buffer: string
  /** 是否已定位到数组起始的 `[`。 */
  jsonStarted: boolean
  /** 已发出的完整数组项个数。 */
  emittedItemCount: number
  /** 末尾未完成 text 项已流式吐出的字符数（含其项索引）。 */
  streamedPartial: { index: number; length: number } | null
  /** 是否解析完成（已见闭合 `]`）。 */
  isDone: boolean
}

/** 单次解析产出。 */
export interface ParseResult {
  /** 本次新增的文本增量（按出现顺序）。 */
  textChunks: string[]
  /** 本次新增的完整动作。 */
  actions: ParsedAction[]
  /** 是否已见数组闭合。 */
  isDone: boolean
  /** 文本与动作的原始交织顺序（index 指向本次 result 内的数组下标）。 */
  ordered: Array<{ type: 'text'; index: number } | { type: 'action'; index: number }>
}

/** 创建初始解析状态。 */
export function createParserState(): ParserState {
  return {
    buffer: '',
    jsonStarted: false,
    emittedItemCount: 0,
    streamedPartial: null,
    isDone: false,
  }
}

// ---------------------------------------------------------------------------
// 字符扫描：定位顶层数组项的边界
// ---------------------------------------------------------------------------

interface ItemBoundary {
  start: number
  end: number
}

interface ArrayScan {
  /** 已闭合的顶层项边界（按顺序）。 */
  items: ItemBoundary[]
  /** 末尾未闭合项的起始下标（无则 null）。 */
  partialStart: number | null
  /** 是否已见顶层数组的闭合 `]`。 */
  arrayClosed: boolean
}

/**
 * 扫描形如 `[...]` 的 buffer，返回顶层项的完整边界、末尾未完成项起点、以及
 * 是否闭合。正确处理字符串内的引号/转义与任意层级的嵌套 `{}`/`[]`。
 *
 * 约定：调用前 buffer 已被裁到以 `[` 开头。
 */
function scanArray(buffer: string): ArrayScan {
  const items: ItemBoundary[] = []
  let partialStart: number | null = null
  let arrayClosed = false

  let depth = 1 // 已进入顶层数组
  let inString = false
  let escape = false
  let itemStart = -1

  for (let i = 1; i < buffer.length; i++) {
    const ch = buffer[i] as string
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      if (depth === 1 && itemStart === -1) itemStart = i
      depth++
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      if (depth === 1) {
        // 恰好闭合一个顶层项
        if (itemStart !== -1) {
          items.push({ start: itemStart, end: i + 1 })
          itemStart = -1
        }
      } else if (depth === 0) {
        // 闭合顶层数组
        arrayClosed = true
        break
      }
    }
  }

  if (!arrayClosed && itemStart !== -1) {
    partialStart = itemStart
  }

  return { items, partialStart, arrayClosed }
}

// ---------------------------------------------------------------------------
// 单项解析（含轻量修复）
// ---------------------------------------------------------------------------

/** 对完整项做 JSON.parse；失败时做轻量修复（控制字符、尾随逗号）后再试。 */
function parseItemLenient(raw: string): Record<string, unknown> | null {
  const atomic = (text: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(text) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  return (
    atomic(raw)
    // 字符串内的裸控制字符（模型偶发未转义换行）→ 置为空格
    ?? atomic(raw.replace(/[\u0000-\u001f]/g, ' '))
    // 尾随逗号
    ?? atomic(raw.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]/g, ' '))
  )
}

/** 把解析出的单项写入结果（处理「末尾曾被流式吐出」的增量补偿）。 */
function emitItem(
  obj: Record<string, unknown>,
  result: ParseResult,
  state: ParserState,
  index: number,
): void {
  if (obj.type === 'text') {
    const content = typeof obj.content === 'string' ? obj.content : ''
    let value = content
    if (state.streamedPartial && state.streamedPartial.index === index) {
      // 该项此前作为末尾碎片被增量吐出，只补发剩余部分，避免重复。
      value = content.slice(state.streamedPartial.length)
      state.streamedPartial = null
    }
    if (value) {
      result.textChunks.push(value)
      result.ordered.push({ type: 'text', index: result.textChunks.length - 1 })
    }
    return
  }
  if (obj.type === 'action') {
    const actionName = (obj.name ?? obj.tool_name) as string | undefined
    if (!actionName) return
    const action: ParsedAction = {
      actionId:
        (obj.action_id as string)
        ?? `action-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actionName,
      params: (obj.params ?? obj.parameters ?? {}) as Record<string, unknown>,
    }
    result.actions.push(action)
    result.ordered.push({ type: 'action', index: result.actions.length - 1 })
  }
}

// ---------------------------------------------------------------------------
// 末尾未完成 text 项的增量文本提取
// ---------------------------------------------------------------------------

/** 读取 JSON 字符串字面量的前缀（处理转义；遇未完成转义即停）。 */
function readJsonStringPrefix(source: string, start: number): string {
  let out = ''
  for (let i = start; i < source.length; i++) {
    const ch = source[i] as string
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === undefined) break // 转义序列未完成
      switch (next) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case 'u': {
          const hex = source.slice(i + 2, i + 6)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16))
            i += 4
          } else {
            i = source.length // 非法 \u，停止
          }
          break
        }
        default: out += next
      }
      i++ // 跳过被转义字符
      continue
    }
    if (ch === '"') return out
    out += ch
  }
  return out
}

/**
 * 从未完成的顶层项片段里提取 `content` 的可流式前缀。
 * 仅当该项已明确是 `type:"text"` 时才返回（否则返回 null，避免误吐动作 JSON）。
 */
function extractPartialTextContent(itemFragment: string): string | null {
  if (!/"type"\s*:\s*"text"/.test(itemFragment)) return null
  const match = /"content"\s*:\s*"/.exec(itemFragment)
  if (!match) return null
  return readJsonStringPrefix(itemFragment, match.index + match[0].length)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 增量解析一个流式 chunk。`state` 会被就地更新。 */
export function parseStructuredChunk(chunk: string, state: ParserState): ParseResult {
  const result: ParseResult = { textChunks: [], actions: [], isDone: false, ordered: [] }
  if (state.isDone) return result

  state.buffer += chunk

  // 定位起始 `[`（丢弃其前的 markdown 围栏/说明文字）。
  if (!state.jsonStarted) {
    const bracket = state.buffer.indexOf('[')
    if (bracket === -1) return result
    state.buffer = state.buffer.slice(bracket)
    state.jsonStarted = true
  }

  const scan = scanArray(state.buffer)

  // 发出新闭合的完整项。
  for (let index = state.emittedItemCount; index < scan.items.length; index++) {
    const boundary = scan.items[index]!
    const obj = parseItemLenient(state.buffer.slice(boundary.start, boundary.end))
    if (obj) emitItem(obj, result, state, index)
  }
  state.emittedItemCount = scan.items.length

  // 末尾未完成项：若为 text，则持续吐出文本增量。
  if (!scan.arrayClosed && scan.partialStart !== null && scan.items.length === state.emittedItemCount) {
    const partial = extractPartialTextContent(state.buffer.slice(scan.partialStart))
    if (partial !== null) {
      const index = state.emittedItemCount
      const prev =
        state.streamedPartial && state.streamedPartial.index === index
          ? state.streamedPartial.length
          : 0
      if (partial.length > prev) {
        const delta = partial.slice(prev)
        if (delta) {
          result.textChunks.push(delta)
          result.ordered.push({ type: 'text', index: result.textChunks.length - 1 })
        }
        state.streamedPartial = { index, length: partial.length }
      }
    }
  }

  if (scan.arrayClosed) {
    state.isDone = true
    state.streamedPartial = null
    result.isDone = true
  }

  return result
}

/**
 * 判断一段残留文本是否是「结构化输出残渣」（裸对象/数组，或截断后的无括号片段
 * 如 `type":"text","content":"..."`），而非自然语言。用于流结束时的兜底抑制，
 * 避免把原始 JSON 泄漏到可见语音里。
 *
 * 锚定到起始位置：既能命中残渣，又不会误伤仅在句中提到 JSON 示例的自然语句
 * （例如「我们用对象 {"name":"树"} 表示一棵树。」）。
 */
export function looksLikeStructuredFragment(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  const hasSchemaKey =
    /^"?type"?\s*:\s*"(text|action)"/.test(trimmed)
    || /^"(content|name|params|action_id)"\s*:/.test(trimmed)
  if (hasSchemaKey) return true
  return /^[[{]\s*([[{"\]}]|$)/.test(trimmed)
}

/** 严格解析裸对象/数组中的 `{type:'text'}` 项，提取可见文本（其余一律不产出）。 */
function extractCleanStructuredText(raw: string): { matched: boolean; texts: string[] } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { matched: false, texts: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { matched: false, texts: [] }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const allTyped = items.every(
    item => item && typeof item === 'object' && 'type' in (item as object),
  )
  if (!allTyped) return { matched: false, texts: [] }
  const texts: string[] = []
  for (const item of items) {
    const obj = item as Record<string, unknown>
    if (obj.type === 'text' && typeof obj.content === 'string' && obj.content.trim()) {
      texts.push(obj.content)
    }
  }
  return { matched: true, texts }
}

/**
 * 流结束后的收尾：模型若始终未产出合法 JSON 数组，则做结构化恢复——
 * 能提取可见文本就提取，其余残渣一律抑制（不泄漏原始 JSON）。
 */
export function finalizeParser(state: ParserState): ParseResult {
  const result: ParseResult = { textChunks: [], actions: [], isDone: true, ordered: [] }
  if (state.isDone) return result

  const content = state.buffer.trim()
  if (!content) {
    state.isDone = true
    return result
  }

  const pushText = (value: string): void => {
    if (!value) return
    result.textChunks.push(value)
    result.ordered.push({ type: 'text', index: result.textChunks.length - 1 })
  }

  if (!state.jsonStarted) {
    const structured = extractCleanStructuredText(content)
    if (structured.matched) {
      structured.texts.forEach(pushText)
    } else if (!looksLikeStructuredFragment(content)) {
      pushText(content)
    }
    // 其余情况：结构化残渣，抑制。
  } else {
    // 数组已开始但未闭合：冲刷增量解析器尚能恢复的部分。
    const flushed = parseStructuredChunk('', state)
    result.textChunks.push(...flushed.textChunks)
    result.actions.push(...flushed.actions)
    result.ordered.push(...flushed.ordered)
  }

  state.isDone = true
  return result
}