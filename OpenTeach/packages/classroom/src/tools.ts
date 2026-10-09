/**
 * 课堂工具集（移植自 OpenMAIC `lib/chat/pi/tools/*`，用 DSH `defineTool` 重述）。
 *
 * 分两层：
 * - **Director 编排工具**（{@link buildDirectorTools}）：`read_scene` / `call_agent` /
 *   `cue_user` / `close_session`，注册在 Director 智能体作用域；
 * - **子智能体动作工具**（{@link buildChildActionTools}）：`spotlight` / `laser` /
 *   `play_video` / `wb_*`，注册在子智能体作用域（native 模式），或由结构化解析器
 *   代为派发（经 {@link executeClassroomAction}）。
 *
 * 与 OpenMAIC 的差异（必要的架构适配，非语义简化）：
 * - OpenMAIC 的 `AgentTool` 定义 `execute` 直接返回 `{content, details, isError}`；
 *   DSH 的 `defineTool` 要求 `output.schema` 声明**规范值**、失败一律抛错——因此
 *   本移植把 OpenMAIC 的 `details` 提升为规范值，`isError` 场景改为抛 `Error`。
 * - `call_agent` 在 OpenMAIC 内联构建子 pi-agent；本项目把「子智能体实际运行」抽象为
 *   {@link ClassroomToolRuntime.delegateAgent} 回调（由 p2-7 的多智能体协作层注入），
 *   本文件只负责守卫、事件编排与结果归一。
 * - 参数校验以 DSH schema 为主；schema 无法表达的语义约束（表格矩阵、白板元素存在性、
 *   动作预算、幂等守卫）在 {@link executeClassroomAction} 内保持与 OpenMAIC 一致。
 *
 * @module plugins/openmaic-classroom/tools
 */

import { defineTool, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ClassroomEvent } from './plugin.js'
import {
  getActionsForRole,
  type AgentTurnSummary,
  type ClassroomAgentConfig,
  type WhiteboardActionRecord,
} from './types.js'

// ---------------------------------------------------------------------------
// 运行上下文（由 Director 循环构造；见 plugin.ts 的 runSession）
// ---------------------------------------------------------------------------

/** 场景快照（`read_scene` 取数的最小视图）。 */
export interface ClassroomSceneSnapshot {
  id: string
  order: number
  type: string
  title: string
  /** 场景大纲描述。 */
  description?: string
  /** 场景大纲要点。 */
  keyPoints?: string[]
  /** 场景内容快照（slide canvas / interactive 等），序列化为证据文本。 */
  content?: unknown
  updatedAt?: string | number
}

/** `read_scene` 产出的场景证据包（对齐 OpenMAIC `DirectorSceneEvidencePacket`）。 */
export interface DirectorSceneEvidencePacket {
  sceneId: string
  /** 供子智能体提示词使用的完整证据文本。 */
  content: string
  metadata: {
    sceneId: string
    title?: string
    sceneType?: string
    order?: number
    revision?: string
  }
}

/** `call_agent` 委派子智能体的输入。 */
export interface DelegateAgentInput {
  agent: ClassroomAgentConfig
  instruction: string
  /** `read_scene` 消费一次后附带的场景证据文本。 */
  sceneEvidence?: string
  messageId: string
  signal?: AbortSignal
}

/** 工具集运行上下文（生命周期＝一轮课堂会话）。 */
export interface ClassroomToolRuntime {
  /** 事件出口：写入会话事件流。 */
  send: (event: ClassroomEvent) => Promise<void> | void
  /** 本轮参与的角色配置（Director 从中选择发言人）。 */
  agentConfigs: ClassroomAgentConfig[]
  /** 场景快照。 */
  scenes: ClassroomSceneSnapshot[]
  /** 当前场景 id。 */
  currentSceneId?: string | null
  /** 单轮最大子智能体发言轮数。 */
  maxAgentTurns: number
  /** 单个子智能体每轮最大动作数。 */
  maxActionsPerAgent: number
  /** 是否允许白板类动作（对齐 OpenMAIC `enableWhiteboardTools`）。 */
  enableWhiteboardTools: boolean
  /** 白板运行态（跨子智能体回合累计）。 */
  whiteboard: ClassroomWhiteboardState
  /** 委派子智能体执行一轮；缺省时 `call_agent` 判定为不可用（p2-7 注入）。 */
  delegateAgent?: (input: DelegateAgentInput) => Promise<AgentTurnSummary>
  /** 本轮已完成的子智能体发言摘要。 */
  getAgentResponses: () => AgentTurnSummary[]
  /** 本轮累计的白板动作台账（供子智能体提示词的 Whiteboard Ledger 段使用）。 */
  getWhiteboardLedger?: () => WhiteboardActionRecord[]
  /** 记录一次子智能体发言。 */
  onAgentTurn: (summary: AgentTurnSummary) => void
  /** 记录一次动作（白板动作入 ledger）。 */
  onAction: (record?: WhiteboardActionRecord) => void
  /** 暂存 `read_scene` 证据，待下一次 `call_agent` 消费。 */
  recordSceneEvidence: (packet: DirectorSceneEvidencePacket) => void
  /** 取走待附加的场景证据（消费一次）。 */
  takeSceneEvidence: () => DirectorSceneEvidencePacket | undefined
  /** 把发言权交还用户。返回 false 表示已交还过。 */
  cueUser: (data: { fromAgentId?: string; prompt?: string }) => Promise<boolean>
  /** 结束本轮课堂会话。返回 false 表示已结束或已交还用户。 */
  closeSession: (data: { endReason?: string }) => Promise<boolean>
  isUserCued: () => boolean
  isSessionClosed: () => boolean
}

// ---------------------------------------------------------------------------
// 白板运行态（移植 classroom-actions.ts 的 PiWhiteboardRuntimeState）
// ---------------------------------------------------------------------------

export interface ClassroomWhiteboardState {
  open: boolean
  visibleElementCount: number
  knownElementIds: Set<string>
  codeLineIdsByElementId: Map<string, Set<string>>
}

/** 创建白板运行态；可由场景快照的初始元素集初始化。 */
export function createClassroomWhiteboardState(init?: {
  open?: boolean
  elementIds?: readonly string[]
  codeLineIdsByElementId?: Record<string, readonly string[]>
}): ClassroomWhiteboardState {
  const knownElementIds = new Set(init?.elementIds ?? [])
  const codeLineIdsByElementId = new Map<string, Set<string>>()
  for (const [elementId, lines] of Object.entries(init?.codeLineIdsByElementId ?? {})) {
    codeLineIdsByElementId.set(elementId, new Set(lines))
  }
  return {
    open: init?.open ?? false,
    visibleElementCount: knownElementIds.size,
    knownElementIds,
    codeLineIdsByElementId,
  }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

let idSeq = 0
/** 生成会话内唯一 id（对齐 OpenMAIC 的 nanoid 用法）。 */
function newId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`
}

function isStringMatrix(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false
  const columnCount = Array.isArray(value[0]) ? (value[0] as unknown[]).length : 0
  return (
    columnCount > 0 &&
    value.every(
      row =>
        Array.isArray(row) &&
        row.length === columnCount &&
        row.every(cell => typeof cell === 'string'),
    )
  )
}

// ---------------------------------------------------------------------------
// read_scene
// ---------------------------------------------------------------------------

const MAX_SCENE_EVIDENCE_CHARS = 24_000

/** 把任意值安全序列化为有界文本。 */
function serializeBounded(value: unknown, maxLength: number): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

/** 构建场景证据文本（精简版：大纲 + 场景内容快照）。 */
function buildSceneEvidence(scene: ClassroomSceneSnapshot): string {
  const outline = [
    `Outline description: ${scene.description || '(none)'}`,
    `Outline key points: ${(scene.keyPoints ?? []).join('; ') || '(none)'}`,
  ].join('\n')
  const content =
    scene.content === undefined
      ? '(no scene content snapshot)'
      : serializeBounded(scene.content, MAX_SCENE_EVIDENCE_CHARS)
  return [
    '# Current State',
    `Current scene: "${scene.title}" (${scene.type}, id: ${scene.id})`,
    outline,
    'Scene content snapshot:',
    content,
  ].join('\n')
}

/**
 * `read_scene`：按精确 sceneId 读取一个课程场景，产出可供委派的证据。
 * 与 OpenMAIC 一致——证据被暂存，下一次 `call_agent` 自动附带并消费一次。
 */
export function buildReadSceneTool(runtime: ClassroomToolRuntime): ToolDefinition {
  return defineTool({
    name: 'read_scene',
    description:
      'Read one course scene by its exact sceneId before delegating a scene-dependent task. ' +
      'Returns source-grounded scene evidence from the request-start course snapshot. ' +
      'Use the course outline to select the id; do not guess ids.',
    parameters: {
      sceneId: {
        type: 'string',
        description: 'Exact sceneId from the course outline in the Director system prompt.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          sceneId: { type: 'string', required: true },
          title: { type: 'string' },
          sceneType: { type: 'string' },
          order: { type: 'number' },
          revision: { type: 'string' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.content ?? '') }],
    },
    async execute(args) {
      const scene = runtime.scenes.find(candidate => candidate.id === args.sceneId)
      if (!scene) {
        throw new Error(
          `Scene ${JSON.stringify(args.sceneId)} was not found in the request-start course snapshot. ` +
            'Select an exact sceneId from the outline.',
        )
      }
      const evidence = buildSceneEvidence(scene)
      if (evidence.length > MAX_SCENE_EVIDENCE_CHARS) {
        throw new Error(
          `Scene ${JSON.stringify(scene.id)} is too large for read_scene (${evidence.length} characters). ` +
            'The result was not silently truncated.',
        )
      }
      const revision = String(scene.updatedAt ?? 'request-start')
      const content = [
        `Scene evidence (sceneId=${scene.id}, revision=${revision}, source=request_start_snapshot):`,
        evidence,
      ].join('\n')
      runtime.recordSceneEvidence({
        sceneId: scene.id,
        content,
        metadata: {
          sceneId: scene.id,
          title: scene.title,
          sceneType: scene.type,
          order: scene.order,
          revision,
        },
      })
      return {
        status: 'ok',
        sceneId: scene.id,
        title: scene.title,
        sceneType: scene.type,
        order: scene.order,
        revision,
        content,
      }
    },
  })
}

// ---------------------------------------------------------------------------
// call_agent
// ---------------------------------------------------------------------------

/** `call_agent` 的跳过结果（对齐 OpenMAIC 的 `details.skipped` 分支）。 */
function skipCallAgent(reason: string, text: string): {
  text: string
  skipped: boolean
  reason: string
} {
  return { text, skipped: true, reason }
}

/**
 * `call_agent`：委派一个课堂智能体产出下一段课内发言。
 *
 * 守卫（与 OpenMAIC 逐条对齐）：会话已关 / 已交还用户 / 尝试次数硬上限 /
 * 发言轮数上限 / 连续空回合上限 / 未知 agentId。子智能体实际运行由
 * {@link ClassroomToolRuntime.delegateAgent} 承担。
 */
export function buildCallAgentTool(runtime: ClassroomToolRuntime): ToolDefinition {
  // 与 OpenMAIC 一致的空回合/尝试次数守卫：模型若反复产出空回合，
  // 不能让 maxAgentTurns 守卫失效。
  const MAX_CONSECUTIVE_EMPTY_TURNS = 2
  const maxAgentAttempts = Math.max(runtime.maxAgentTurns * 3, runtime.maxAgentTurns + 3)
  let consecutiveEmptyTurns = 0
  let totalAgentAttempts = 0

  return defineTool({
    name: 'call_agent',
    description:
      'Ask one classroom agent to produce the next in-class response. Use this before giving your final director decision. ' +
      `Hard limit: at most ${runtime.maxAgentTurns} classroom agent turns in this server-side loop. ` +
      'Once the limit is reached, finish with cue_user or close_session.',
    parameters: {
      agentId: {
        type: 'string',
        description: 'ID of the classroom agent that should speak next.',
        required: true,
      },
      instruction: {
        type: 'string',
        description: 'Specific instruction and context for the selected agent response.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          agentId: { type: 'string' },
          agentName: { type: 'string' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.skipped
            ? `call_agent skipped: ${value.reason ?? 'unknown'}`
            : `${value.agentName ?? ''}: ${value.text}`,
        },
      ],
    },
    async execute(args, exec) {
      if (totalAgentAttempts >= maxAgentAttempts) {
        return skipCallAgent(
          'agent_attempt_cap',
          `Reached the hard call_agent attempt cap (${maxAgentAttempts}). Finish with cue_user or close_session.`,
        )
      }
      totalAgentAttempts += 1

      if (runtime.isSessionClosed()) {
        return skipCallAgent(
          'session_closed',
          'The classroom session is already closed. Finish the director loop without calling another agent.',
        )
      }
      if (runtime.isUserCued()) {
        return skipCallAgent(
          'user_already_cued',
          'The user has already been cued. Finish the director loop without calling another agent.',
        )
      }

      const agent = runtime.agentConfigs.find(candidate => candidate.id === args.agentId)
      if (!agent) {
        const available = runtime.agentConfigs.map(candidate => candidate.id).join(', ')
        return skipCallAgent(
          'invalid_agent_id',
          `Agent "${args.agentId}" is not available. Available agents: ${available || 'none'}.`,
        )
      }

      if (runtime.getAgentResponses().length >= runtime.maxAgentTurns) {
        return skipCallAgent(
          'agent_turn_limit',
          `Agent turn limit (${runtime.maxAgentTurns}) reached. Finish the director loop with cue_user or close_session.`,
        )
      }
      if (consecutiveEmptyTurns >= MAX_CONSECUTIVE_EMPTY_TURNS) {
        return skipCallAgent(
          'consecutive_empty_turns',
          `Classroom agents returned empty responses ${consecutiveEmptyTurns} times in a row. Stop calling agents and finish with cue_user or close_session.`,
        )
      }
      if (!runtime.delegateAgent) {
        return skipCallAgent(
          'delegate_unavailable',
          'No child-agent runtime is available in this deployment; finish with cue_user or close_session.',
        )
      }

      const messageId = newId('msg')
      const sceneEvidence = runtime.takeSceneEvidence()
      await runtime.send({
        type: 'agent_start',
        data: {
          messageId,
          agentId: agent.id,
          agentName: agent.name,
          agentAvatar: agent.avatar,
          agentColor: agent.color,
        },
      })

      let summary: AgentTurnSummary
      try {
        summary = await runtime.delegateAgent({
          agent,
          instruction: args.instruction,
          sceneEvidence: sceneEvidence?.content,
          messageId,
          signal: exec.signal,
        })
      } catch (error) {
        // 子智能体失败也要收束发言（对齐 OpenMAIC：失败仍记为空回合）。
        await runtime.send({ type: 'agent_end', data: { messageId, agentId: agent.id } })
        consecutiveEmptyTurns += 1
        throw error
      }

      const hasContent = summary.contentPreview.trim().length > 0 || summary.actionCount > 0
      consecutiveEmptyTurns = hasContent ? 0 : consecutiveEmptyTurns + 1
      await runtime.send({ type: 'agent_end', data: { messageId, agentId: agent.id } })
      runtime.onAgentTurn(summary)

      return {
        text: summary.contentPreview || '(no visible response)',
        agentId: agent.id,
        agentName: agent.name,
        skipped: false,
      }
    },
  })
}

// ---------------------------------------------------------------------------
// cue_user / close_session
// ---------------------------------------------------------------------------

/** 是否已存在「实质教学发言」（教师/助教且有点内容或动作）。 */
function hasTeachingSubstantiveTurn(runtime: ClassroomToolRuntime): boolean {
  return runtime.getAgentResponses().some(summary => {
    const agent = runtime.agentConfigs.find(candidate => candidate.id === summary.agentId)
    const isTeaching = agent?.role === 'teacher' || agent?.role === 'assistant'
    return Boolean(
      isTeaching && (summary.contentPreview.trim().length > 0 || summary.actionCount > 0),
    )
  })
}

/** 是否已存在可见发言（任意角色有可见文本）。 */
function hasVisibleAgentTurn(runtime: ClassroomToolRuntime): boolean {
  return runtime.getAgentResponses().some(summary => summary.contentPreview.trim().length > 0)
}

/** `cue_user`：把发言权交还用户。 */
export function buildCueUserTool(runtime: ClassroomToolRuntime): ToolDefinition {
  return defineTool({
    name: 'cue_user',
    description:
      'Hand the classroom turn back to the user after the useful classroom agent turns are complete.',
    parameters: {
      prompt: {
        type: 'string',
        description: 'Optional short prompt for handing the turn back to the user.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { emitted: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.emitted
            ? 'The user has been cued for the next classroom turn.'
            : 'The user was not cued for this classroom turn.',
        },
      ],
    },
    async execute(args) {
      if (runtime.isSessionClosed()) return { emitted: false }
      if (!hasTeachingSubstantiveTurn(runtime)) {
        return { emitted: false }
      }
      const responses = runtime.getAgentResponses()
      const emitted = await runtime.cueUser({
        fromAgentId: responses[responses.length - 1]?.agentId,
        prompt: args.prompt,
      })
      return { emitted }
    },
  })
}

/** `close_session`：结束本轮课堂会话。 */
export function buildCloseSessionTool(runtime: ClassroomToolRuntime): ToolDefinition {
  return defineTool({
    name: 'close_session',
    description:
      'Explicitly close the classroom session after a clear ending, goodbye, or lesson wrap-up.',
    parameters: {
      endReason: {
        type: 'string',
        enum: ['user_goodbye', 'user_done', 'back_to_lesson', 'lesson_complete'],
        description:
          'Machine-readable reason for ending the classroom session. Use user_done for satisfied/no-more-questions acknowledgments and back_to_lesson for resume-lesson requests.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { emitted: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.emitted
            ? 'The classroom session has been marked for closure.'
            : 'The classroom session was not marked for closure.',
        },
      ],
    },
    async execute(args) {
      if (runtime.isUserCued()) return { emitted: false }
      if (!hasVisibleAgentTurn(runtime)) return { emitted: false }
      const emitted = await runtime.closeSession({ endReason: args.endReason })
      return { emitted }
    },
  })
}

/** 组装 Director 编排工具集（注册在 Director 智能体作用域）。 */
export function buildDirectorTools(runtime: ClassroomToolRuntime): ToolDefinition[] {
  return [
    buildReadSceneTool(runtime),
    buildCallAgentTool(runtime),
    buildCueUserTool(runtime),
    buildCloseSessionTool(runtime),
  ]
}

// ---------------------------------------------------------------------------
// 子智能体动作工具（spotlight / laser / play_video / wb_*）
// ---------------------------------------------------------------------------

/** 一次子智能体回合内的动作执行上下文。 */
export interface ClassroomActionContext {
  runtime: ClassroomToolRuntime
  agent: ClassroomAgentConfig
  messageId: string
  /** 本回合动作预算（对齐 OpenMAIC `maxActionsPerAgent`）。 */
  actionBudget: { used: number; max: number }
}

/** 动作执行结果（对齐 OpenMAIC 的 `details` 形状）。 */
export interface ClassroomActionResult {
  actionName: string
  actionId?: string
  skipped?: boolean
  reason?: string
  /** 归一化后的实际动作参数（含自动补全的 elementId / lineIds），供委派层记录台账。 */
  params?: Record<string, unknown>
}

function skipAction(actionName: string, reason: string): ClassroomActionResult {
  return { actionName, skipped: true, reason }
}

/**
 * 执行（或跳过）一个课堂动作：校验语义约束 → 发出 `action` 事件 → 更新白板运行态。
 *
 * 白板元素存在性、动作预算、幂等守卫与 OpenMAIC `classroom-actions.ts` 保持一致。
 */
export async function executeClassroomAction(
  name: string,
  params: Record<string, unknown>,
  ctx: ClassroomActionContext,
): Promise<ClassroomActionResult> {
  const { runtime, agent } = ctx
  const board = runtime.whiteboard

  const allowedActions =
    agent.allowedActions.length > 0 ? agent.allowedActions : getActionsForRole(agent.role)
  if (!allowedActions.includes(name)) {
    return skipAction(name, 'action_not_allowed')
  }

  if (name === 'wb_open' && board.open) return skipAction(name, 'whiteboard_already_open')
  if ((name === 'wb_clear' || name === 'wb_delete') && board.visibleElementCount === 0) {
    return skipAction(name, 'whiteboard_empty')
  }
  if (ctx.actionBudget.used >= ctx.actionBudget.max) return skipAction(name, 'action_budget')

  const actionParams: Record<string, unknown> = { ...params }

  if (name.startsWith('wb_draw_') && !actionParams.elementId) {
    actionParams.elementId = newId('el')
  }

  if (name === 'wb_draw_table' && !isStringMatrix(actionParams.data)) {
    return skipAction(name, 'whiteboard_invalid_table')
  }

  if (name.startsWith('wb_draw_')) {
    const elementId = actionParams.elementId
    if (typeof elementId === 'string' && elementId && board.knownElementIds.has(elementId)) {
      return skipAction(name, 'whiteboard_element_id_conflict')
    }
  }

  if (name === 'wb_delete' && !board.knownElementIds.has(String(actionParams.elementId ?? ''))) {
    return skipAction(name, 'whiteboard_element_not_found')
  }

  if (name === 'wb_edit_code') {
    const elementId = String(actionParams.elementId ?? '')
    const knownLineIds = board.codeLineIdsByElementId.get(elementId)
    if (!knownLineIds) return skipAction(name, 'whiteboard_code_element_not_found')
    const operation = actionParams.operation
    const targetLineIds =
      operation === 'insert_after' || operation === 'insert_before'
        ? [String(actionParams.lineId ?? '')]
        : Array.isArray(actionParams.lineIds)
          ? actionParams.lineIds.map(String)
          : []
    const missingLineId = targetLineIds.find(lineId => !knownLineIds.has(lineId))
    if (missingLineId) return skipAction(name, 'whiteboard_code_line_not_found')
  }

  if (name === 'wb_draw_code') {
    actionParams.lineIds = String(actionParams.code ?? '')
      .split('\n')
      .map((_line, index) => `L${index + 1}`)
  }
  if (name === 'wb_edit_code') {
    const operation = actionParams.operation
    if (
      operation === 'insert_after' ||
      operation === 'insert_before' ||
      operation === 'replace_lines'
    ) {
      const contentLineCount = String(actionParams.content ?? '').split('\n').length
      const replacedLineIds =
        operation === 'replace_lines' && Array.isArray(actionParams.lineIds)
          ? actionParams.lineIds.map(String)
          : []
      actionParams.newLineIds = Array.from(
        { length: contentLineCount },
        (_unused, index) => replacedLineIds[index] ?? newId('L'),
      )
    }
  }

  const actionId = newId('act')
  ctx.actionBudget.used += 1
  await runtime.send({
    type: 'action',
    data: { actionId, actionName: name, params: actionParams, agentId: agent.id, messageId: ctx.messageId },
  })

  // 白板运行态演进（移植 classroom-actions.ts 的 post-emit 更新）。
  if (name === 'wb_open') board.open = true
  if (name === 'wb_close') board.open = false
  if (name === 'wb_clear') {
    board.open = true
    board.visibleElementCount = 0
    board.knownElementIds.clear()
    board.codeLineIdsByElementId.clear()
  }
  if (name.startsWith('wb_draw_')) {
    board.open = true
    board.visibleElementCount += 1
    const elementId = actionParams.elementId
    if (typeof elementId === 'string' && elementId) {
      board.knownElementIds.add(elementId)
      if (name === 'wb_draw_code') {
        board.codeLineIdsByElementId.set(elementId, new Set((actionParams.lineIds as string[]) ?? []))
      }
    }
  }
  if (name === 'wb_delete') {
    board.open = true
    const elementId = String(actionParams.elementId)
    board.knownElementIds.delete(elementId)
    board.visibleElementCount = Math.max(board.visibleElementCount - 1, 0)
    board.codeLineIdsByElementId.delete(elementId)
  }
  if (name === 'wb_edit_code') {
    const elementId = String(actionParams.elementId)
    const lineIds = board.codeLineIdsByElementId.get(elementId)
    const operation = actionParams.operation
    if (lineIds && (operation === 'delete_lines' || operation === 'replace_lines')) {
      const targetLineIds = (actionParams.lineIds as string[]) ?? []
      targetLineIds.forEach(lineId => lineIds.delete(lineId))
      if (operation === 'replace_lines') {
        ;((actionParams.newLineIds as string[]) ?? []).forEach(lineId => lineIds.add(lineId))
      }
    } else if (lineIds && (operation === 'insert_after' || operation === 'insert_before')) {
      ;((actionParams.newLineIds as string[]) ?? []).forEach(lineId => lineIds.add(lineId))
    }
  }

  runtime.onAction(
    name.startsWith('wb_')
      ? { actionName: name, agentId: agent.id, agentName: agent.name, params: actionParams }
      : undefined,
  )

  return { actionName: name, actionId, skipped: false, params: actionParams }
}

/**
 * 把一个动作语义包装成 DSH 工具。`parameters` 由调用方以字面量传入（经 `as const`
 * 保持字面类型，供 `defineTool` 推导参数类型）。
 */
function defineActionTool(
  name: string,
  description: string,
  parameters: ParameterSchemaSpec,
  actionCtx: ClassroomActionContext,
): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          actionName: { type: 'string', required: true },
          actionId: { type: 'string' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.skipped
            ? `Action ${value.actionName} skipped: ${value.reason ?? 'unknown'}`
            : `Action ${value.actionName} was sent to the client.`,
        },
      ],
    },
    // 参数已由 DSH schema 校验；此处只需转成动作执行器的通用入参。
    execute: (args: unknown) =>
      executeClassroomAction(name, args as Record<string, unknown>, actionCtx),
  })
}

// --- 参数 schema（对齐 classroom-actions.ts 的 TypeBox 定义） ----------------

const SPOTLIGHT_PARAMS = {
  elementId: { type: 'string', required: true },
  dimOpacity: { type: 'number' },
} as const

const LASER_PARAMS = {
  elementId: { type: 'string', required: true },
  color: { type: 'string' },
} as const

const PLAY_VIDEO_PARAMS = { elementId: { type: 'string', required: true } } as const

const EMPTY_PARAMS = {} as const

const WB_DELETE_PARAMS = { elementId: { type: 'string', required: true } } as const

const WB_DRAW_TEXT_PARAMS = {
  content: { type: 'string', required: true },
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  width: { type: 'number' },
  height: { type: 'number' },
  fontSize: { type: 'number' },
  color: { type: 'string' },
  elementId: { type: 'string' },
} as const

const WB_DRAW_SHAPE_PARAMS = {
  shape: { type: 'string', enum: ['rectangle', 'circle', 'triangle'], required: true },
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  width: { type: 'number', required: true },
  height: { type: 'number', required: true },
  fillColor: { type: 'string' },
  elementId: { type: 'string' },
} as const

const WB_DRAW_CHART_PARAMS = {
  chartType: {
    type: 'string',
    enum: ['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter'],
    required: true,
  },
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  width: { type: 'number', required: true },
  height: { type: 'number', required: true },
  data: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: {
      labels: { type: 'array', items: { type: 'string' }, required: true },
      legends: { type: 'array', items: { type: 'string' }, required: true },
      series: { type: 'array', items: { type: 'array', items: { type: 'number' } }, required: true },
    },
  },
  themeColors: { type: 'array', items: { type: 'string' } },
  elementId: { type: 'string' },
} as const

const WB_DRAW_LATEX_PARAMS = {
  latex: { type: 'string', required: true },
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  width: { type: 'number' },
  height: { type: 'number' },
  color: { type: 'string' },
  elementId: { type: 'string' },
} as const

const WB_DRAW_TABLE_PARAMS = {
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  width: { type: 'number', required: true },
  height: { type: 'number', required: true },
  data: { type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true },
  outline: {
    type: 'object',
    additionalProperties: false,
    properties: {
      width: { type: 'number', required: true },
      style: { type: 'string', required: true },
      color: { type: 'string', required: true },
    },
  },
  theme: {
    type: 'object',
    additionalProperties: false,
    properties: { color: { type: 'string', required: true } },
  },
  elementId: { type: 'string' },
} as const

const WB_DRAW_LINE_PARAMS = {
  startX: { type: 'number', required: true },
  startY: { type: 'number', required: true },
  endX: { type: 'number', required: true },
  endY: { type: 'number', required: true },
  color: { type: 'string' },
  width: { type: 'number' },
  style: { type: 'string', enum: ['solid', 'dashed'] },
  points: { type: 'array', items: { type: 'string' } },
  elementId: { type: 'string' },
} as const

const WB_DRAW_CODE_PARAMS = {
  language: { type: 'string', required: true },
  code: { type: 'string', required: true },
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  width: { type: 'number' },
  height: { type: 'number' },
  fileName: { type: 'string' },
  elementId: { type: 'string' },
} as const

const WB_EDIT_CODE_PARAMS = {
  elementId: { type: 'string', required: true },
  operation: {
    type: 'string',
    enum: ['insert_after', 'insert_before', 'delete_lines', 'replace_lines'],
    required: true,
  },
  lineId: { type: 'string' },
  lineIds: { type: 'array', items: { type: 'string' } },
  content: { type: 'string' },
} as const

/** 白板类的可变更动作（受 `enableWhiteboardTools` 门控）。 */
const WHITEBOARD_MUTATION_ACTIONS = [
  'wb_open',
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
  'wb_close',
]

/**
 * 组装子智能体的动作工具集（注册在子智能体作用域）。
 *
 * 可用动作 = 角色动作集 ∩ 部署允许集（白板开关 + 当前场景是否幻灯片）。
 * 与 OpenMAIC `buildChildActionTools` 的 allowlist 逻辑一致。
 */
export function buildChildActionTools(actionCtx: ClassroomActionContext): ToolDefinition[] {
  const { runtime, agent } = actionCtx
  const currentScene = runtime.currentSceneId
    ? runtime.scenes.find(scene => scene.id === runtime.currentSceneId)
    : undefined
  const slideOnlyActions = currentScene?.type === 'slide' ? ['play_video'] : []
  const deploymentAllowlist = runtime.enableWhiteboardTools
    ? ['spotlight', 'laser', ...slideOnlyActions, ...WHITEBOARD_MUTATION_ACTIONS]
    : ['spotlight', 'laser', ...slideOnlyActions]
  const allowed = (
    agent.allowedActions.length > 0 ? agent.allowedActions : getActionsForRole(agent.role)
  ).filter(name => deploymentAllowlist.includes(name))

  const tools: ToolDefinition[] = []
  const add = (actionName: string, description: string, parameters: ParameterSchemaSpec): void => {
    if (allowed.includes(actionName)) {
      tools.push(defineActionTool(actionName, description, parameters, actionCtx))
    }
  }

  add('spotlight', 'Focus attention on one slide element by elementId.', SPOTLIGHT_PARAMS)
  add('laser', 'Point at one slide element by elementId.', LASER_PARAMS)
  add('play_video', 'Start playback of a video element on the current slide by elementId.', PLAY_VIDEO_PARAMS)
  add('wb_open', 'Open the classroom whiteboard.', EMPTY_PARAMS)
  add('wb_draw_text', 'Draw concise text, equations, or key steps on the whiteboard.', WB_DRAW_TEXT_PARAMS)
  add('wb_draw_shape', 'Draw a rectangle, circle, or triangle on the whiteboard.', WB_DRAW_SHAPE_PARAMS)
  add('wb_draw_chart', 'Draw a chart on the whiteboard for data or comparisons.', WB_DRAW_CHART_PARAMS)
  add('wb_draw_latex', 'Draw a LaTeX formula on the whiteboard.', WB_DRAW_LATEX_PARAMS)
  add('wb_draw_table', 'Draw a table on the whiteboard for structured data.', WB_DRAW_TABLE_PARAMS)
  add('wb_draw_line', 'Draw a line or arrow on the whiteboard.', WB_DRAW_LINE_PARAMS)
  add('wb_draw_code', 'Draw a syntax-highlighted code block on the whiteboard.', WB_DRAW_CODE_PARAMS)
  add('wb_edit_code', 'Edit an existing code block on the whiteboard.', WB_EDIT_CODE_PARAMS)
  add('wb_clear', 'Clear all elements from the classroom whiteboard.', EMPTY_PARAMS)
  add('wb_delete', 'Delete one whiteboard element by elementId.', WB_DELETE_PARAMS)
  add('wb_close', 'Close the whiteboard and return to the slide.', EMPTY_PARAMS)

  return tools
}