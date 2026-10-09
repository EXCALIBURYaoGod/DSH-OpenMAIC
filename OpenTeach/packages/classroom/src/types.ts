/**
 * openmaic-classroom 共享类型与常量。
 *
 * 移植自 OpenMAIC（只读参考）的两处：
 * - `lib/orchestration/registry/types.ts`：`AgentConfig`、角色→动作映射；
 * - `lib/orchestration/types.ts`：`AgentTurnSummary`、`WhiteboardActionRecord`；
 * - `lib/orchestration/tool-schemas.ts`：`getActionDescriptions`（动作文本描述，
 *   供结构化输出的子智能体提示词使用）。
 *
 * 仅保留本项目编排所需的最小可接入子集，字段语义与 OpenMAIC 保持一致，
 * 便于后续（Phase 3 落库、Phase 5 前端播放器）对齐。
 *
 * @module plugins/openmaic-classroom/types
 */

/** 课堂角色。 */
export type ClassroomAgentRole = 'teacher' | 'assistant' | 'student'

/** 课堂会话类型（对齐 OpenMAIC `SessionType`）。 */
export type ClassroomSessionType = 'qa' | 'discussion' | 'lecture'

/**
 * 单个课堂智能体的配置（对齐 OpenMAIC `AgentConfig`）。
 * Phase 3 将落库到 SQLite `agents` 表。
 */
export interface ClassroomAgentConfig {
  /** 唯一 id（Director 的 `call_agent` 以此寻址）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 角色：teacher / assistant / student。 */
  role: ClassroomAgentRole | string
  /** 完整系统提示词（人格与职责）。 */
  persona: string
  /** emoji 或图片 URL。 */
  avatar: string
  /** UI 主题色（hex）。 */
  color: string
  /** 该智能体允许使用的动作类型。 */
  allowedActions: string[]
  /** Director 选择优先级（1-10，越大越优先）。 */
  priority: number
  /** 每角色 TTS 音色选择（Phase 6 接入语音讲解）。 */
  voiceConfig?: { providerId: string; modelId?: string; voiceId: string }
  /** 是否为内置默认模板。 */
  isDefault?: boolean
  /** 是否由 LLM 生成。 */
  isGenerated?: boolean
  /** 生成该角色的 stage id。 */
  boundStageId?: string
}

/** 白板动作记录（对齐 OpenMAIC `WhiteboardActionRecord`）。 */
export interface WhiteboardActionRecord {
  actionName: string
  agentId: string
  agentName: string
  params: Record<string, unknown>
}

/** 单轮内某智能体的发言摘要（对齐 OpenMAIC `AgentTurnSummary`）。 */
export interface AgentTurnSummary {
  agentId: string
  agentName: string
  contentPreview: string
  actionCount: number
  whiteboardActions: WhiteboardActionRecord[]
}

/**
 * Director 跨请求累积的状态（对齐 OpenMAIC `DirectorState`）。
 * 客户端持有并在每轮请求回传，后端保持无状态。
 */
export interface ClassroomDirectorState {
  turnCount: number
  agentResponses: AgentTurnSummary[]
  whiteboardLedger: WhiteboardActionRecord[]
}

// ---------------------------------------------------------------------------
// 角色 → 动作映射（移植 registry/types.ts）
// ---------------------------------------------------------------------------

export const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
]

/** 仅幻灯片类动作（教师专属的视觉引导）。 */
export const SLIDE_ACTIONS = ['spotlight', 'laser', 'play_video']

/** 教师可控制幻灯片与白板；其余角色仅白板。 */
export const ROLE_ACTIONS: Record<string, string[]> = {
  teacher: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
  assistant: [...WHITEBOARD_ACTIONS],
  student: [...WHITEBOARD_ACTIONS],
}

/** 取某角色的默认动作集；未知角色回退为仅白板。 */
export function getActionsForRole(role: string): string[] {
  return ROLE_ACTIONS[role] ?? [...WHITEBOARD_ACTIONS]
}

// ---------------------------------------------------------------------------
// 动作文本描述（移植 tool-schemas.ts 的 getActionDescriptions）
// ---------------------------------------------------------------------------

const WHITEBOARD_DRAW_ACTIONS = [
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
]

/** 判断动作集中是否含白板绘制类动作。 */
export function hasWhiteboardDraw(actions: string[]): boolean {
  return actions.some(action => WHITEBOARD_DRAW_ACTIONS.includes(action))
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  spotlight:
    'Focus attention on a single key element by dimming everything else. Use sparingly — max 1-2 per response. Parameters: { elementId: string, dimOpacity?: number }',
  laser:
    'Point at an element with a laser pointer effect. Parameters: { elementId: string, color?: string }',
  wb_open:
    'Open the whiteboard for hand-drawn explanations, formulas, diagrams, or step-by-step derivations. Creates a new whiteboard if none exists. Call this before adding elements. Parameters: {}',
  wb_draw_text:
    'Add text to the whiteboard. Use for writing steps or key points. Use wb_draw_latex for mathematical equations and scientific notation. Parameters: { content: string, x: number, y: number, width?: number, height?: number, fontSize?: number, color?: string, elementId?: string }',
  wb_draw_shape:
    'Add a shape to the whiteboard. Use for diagrams and visual explanations. Parameters: { shape: "rectangle"|"circle"|"triangle", x: number, y: number, width: number, height: number, fillColor?: string, elementId?: string }',
  wb_draw_chart:
    'Add a chart to the whiteboard. Use for data visualization (bar charts, line graphs, pie charts, etc.). Parameters: { chartType: "bar"|"column"|"line"|"pie"|"ring"|"area"|"radar"|"scatter", x: number, y: number, width: number, height: number, data: { labels: string[], legends: string[], series: number[][] }, themeColors?: string[], elementId?: string }',
  wb_draw_latex:
    'Add a LaTeX formula to the whiteboard. Use for mathematical equations and scientific notation. Parameters: { latex: string, x: number, y: number, width?: number, height?: number, color?: string, elementId?: string }',
  wb_draw_table:
    'Add a table to the whiteboard. Use for structured data display and comparisons. Parameters: { x: number, y: number, width: number, height: number, data: string[][] (first row is header), outline?: { width: number, style: string, color: string }, theme?: { color: string }, elementId?: string }',
  wb_draw_line:
    'Add a line or arrow to the whiteboard. Use for connecting elements, drawing relationships, flow diagrams, or annotations. Parameters: { startX: number, startY: number, endX: number, endY: number, color?: string (default "#333333"), width?: number (line thickness, default 2), style?: "solid"|"dashed" (default "solid"), points?: [startMarker, endMarker] where marker is ""|"arrow" (default ["",""]), elementId?: string }',
  wb_draw_code:
    'Add a code block to the whiteboard with syntax highlighting. The code block has a header bar (~32px) showing the file name and language label, so the actual code area starts below that. When positioning, account for this: the effective code area top is about y+32. Use for demonstrating code, algorithms, or programming concepts. Parameters: { language: string (e.g. "python", "javascript", "typescript", "json", "go", "rust", "java", "c", "cpp"), code: string (source code, use \\n for newlines), x: number, y: number, width?: number (default 500), height?: number (default 300, includes ~32px header), fileName?: string (e.g. "main.py"), elementId?: string }',
  wb_edit_code:
    'Edit an existing code block on the whiteboard by inserting, deleting, or replacing lines. Each line has a stable ID (e.g. "L1", "L2") shown in the whiteboard state. Use this for step-by-step code demonstrations: first draw a code block, then incrementally add/modify lines with speech in between. Parameters: { elementId: string (target code block), operation: "insert_after"|"insert_before"|"delete_lines"|"replace_lines", lineId?: string (reference line for insert), lineIds?: string[] (target lines for delete/replace), content?: string (new code for insert/replace, use \\n for newlines) }',
  wb_clear:
    'Clear all elements from the whiteboard. Use when whiteboard is too crowded before adding new elements. Parameters: {}',
  wb_delete:
    'Delete a specific element from the whiteboard by its ID. Use to remove an outdated, incorrect, or overlapping element without clearing the entire board. Parameters: { elementId: string }',
  wb_close:
    'Close the whiteboard and return to the slide view. Do not close merely because your own drawing is complete. Keep it open when the current instruction or a later classroom agent still needs the board. Close only when explicitly requested, or before returning to slide-only actions such as spotlight or laser. Parameters: {}',
  play_video:
    'Start playback of a video element on the current slide. Synchronous — blocks until the video finishes playing. Use a speech action before this to introduce the video. Parameters: { elementId: string }',
}

/** 生成动作集中每个动作的文本描述（供子智能体提示词使用）。 */
export function getActionDescriptions(allowedActions: string[]): string {
  if (allowedActions.length === 0) {
    return 'You have no actions available. You can only speak to students.'
  }
  return allowedActions
    .filter(action => ACTION_DESCRIPTIONS[action])
    .map(action => `- ${action}: ${ACTION_DESCRIPTIONS[action]}`)
    .join('\n')
}