/**
 * 互动课堂路由：把 `openmaic.classroom` 编排服务与 `agents` 角色注册表暴露给前端。
 *
 * 对齐 OpenMAIC 的两条流：
 * - `POST /api/classroom/chat`（SSE，Director 循环）↔ OpenMAIC `POST /api/chat/pi`；
 * - `GET  /api/classroom/sessions/:id/events`（SSE tail + `Last-Event-ID`）↔
 *   OpenMAIC `GET /api/agent/sessions/[id]/events`。
 *
 * 事件帧的 `id` 即会话内 `seq`，浏览器断线重连自动带 `Last-Event-ID`，据此续传。
 * 服务未装配（降级分支）时返回 501，由前端隐藏课堂入口而不阻断五步闭环。
 *
 * @module http/routes/classroom
 */

import { Router, type Response } from 'express'
import type { AppContext } from '../../context.js'
import { newId, type AgentRecord } from '@openteach/plugin-db/repo'
import type {
  ClassroomSessionInput,
  ClassroomSessionType,
  OpenmaicClassroomService,
} from '@openteach/plugin-classroom'
import { openSse, sendError } from '../sse.js'

/** 允许的会话类型（对齐 OpenMAIC `SessionType`）。 */
const SESSION_TYPES: readonly ClassroomSessionType[] = ['qa', 'discussion', 'lecture']

/** 事件 tail 的轮询步长与空闲上限（无新事件达上限即收束，避免长挂）。 */
const TAIL_POLL_MS = 400
const TAIL_IDLE_TICKS = 300

/** 解析结果：成功给出输入与场景，失败给出 HTTP 状态与消息。 */
type ParsedInput =
  | { ok: true; input: ClassroomSessionInput }
  | { ok: false; status: number; message: string }

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

/** 从请求体取字符串字段（去空白；空串视为未提供）。 */
function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function optStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * 场景取数：优先取文档存储中该课程的 dsl Stage/Scene；无文档时回退为「每课次一场景」
 * （与 `normalizeClassroomScenes` 的 `id`/`title` 契约对齐）。
 */
async function resolveScenes(context: AppContext, body: Record<string, unknown>, courseId: string | undefined): Promise<unknown[]> {
  if (Array.isArray(body.scenes)) return body.scenes
  if (courseId === undefined) return []
  const doc = await context.storage?.docs.loadDocument(courseId)
  if (doc !== null && doc !== undefined && doc.scenes.length > 0) return doc.scenes
  return context.repo.listLessons(courseId).map(lesson => ({
    id: lesson.id,
    title: lesson.title,
    order: lesson.idx,
    type: 'slide',
    description: lesson.objective,
    keyPoints: lesson.keyPoints,
  }))
}

/** 校验并归一化建课/开课输入（含场景取数）。 */
async function parseSessionInput(context: AppContext, body: Record<string, unknown>): Promise<ParsedInput> {
  const courseId = optString(body.courseId)
  if (courseId !== undefined && context.repo.getCourse(courseId) === undefined) {
    return { ok: false, status: 404, message: '课程不存在' }
  }
  const lessonId = optString(body.lessonId)
  if (lessonId !== undefined) {
    const lesson = context.repo.getLesson(lessonId)
    if (lesson === undefined || (courseId !== undefined && lesson.courseId !== courseId)) {
      return { ok: false, status: 404, message: '课次不存在' }
    }
  }

  const sessionType = optString(body.sessionType)
  if (sessionType !== undefined && !SESSION_TYPES.includes(sessionType as ClassroomSessionType)) {
    return { ok: false, status: 400, message: `sessionType 非法；可选：${SESSION_TYPES.join('、')}` }
  }

  const scenes = await resolveScenes(context, body, courseId)
  const input: ClassroomSessionInput = {
    agentIds: optStringArray(body.agentIds) ?? [],
    ...(courseId === undefined ? {} : { courseId }),
    ...(lessonId === undefined ? {} : { lessonId }),
    ...(optString(body.stageId) === undefined ? {} : { stageId: optString(body.stageId)! }),
    ...(sessionType === undefined ? {} : { sessionType: sessionType as ClassroomSessionType }),
    ...(optString(body.message) === undefined ? {} : { message: optString(body.message)! }),
    ...(optString(body.triggerAgentId) === undefined ? {} : { triggerAgentId: optString(body.triggerAgentId)! }),
    ...(scenes.length === 0 ? {} : { scenes }),
  }
  return { ok: true, input }
}

/**
 * 会话事件流（SSE tail）。
 *
 * 先补发 `afterSeq` 之后的历史事件（断线续传），随后轮询增量直至收到终态 `done`
 * 或空闲超时。帧 `id` 用 `seq`，与 `Last-Event-ID` 一一对应。
 */
function tailSessionEvents(
  service: OpenmaicClassroomService,
  sessionId: string,
  afterSeq: number,
  res: Response,
): void {
  const channel = openSse(res)
  let cursor = afterSeq
  let done = false

  const flush = (): void => {
    for (const event of service.getSessionEvents(sessionId, cursor)) {
      channel.send(event.type, event, event.seq)
      cursor = event.seq
      if (event.type === 'done') done = true
    }
  }

  flush()
  if (done || channel.closed) {
    channel.close()
    return
  }

  let idleTicks = 0
  const timer = setInterval(() => {
    if (channel.closed || done) {
      clearInterval(timer)
      return
    }
    const before = cursor
    flush()
    if (done) {
      clearInterval(timer)
      channel.close()
      return
    }
    idleTicks = cursor === before ? idleTicks + 1 : 0
    if (idleTicks >= TAIL_IDLE_TICKS) {
      clearInterval(timer)
      channel.close()
    }
  }, TAIL_POLL_MS)

  res.on('close', () => clearInterval(timer))
}

/** 请求体 → `AgentRecord`（未提供的字段给安全默认值）。 */
function parseAgentRecord(body: Record<string, unknown>, id: string): AgentRecord | null {
  const name = optString(body.name)
  if (name === undefined) return null
  const now = new Date().toISOString()
  const voiceRaw = asRecord(body.voiceConfig)
  const voiceId = optString(voiceRaw.voiceId)
  const providerId = optString(voiceRaw.providerId)
  return {
    id,
    name,
    role: optString(body.role) ?? 'student',
    persona: typeof body.persona === 'string' ? body.persona : '',
    avatar: typeof body.avatar === 'string' ? body.avatar : '',
    color: optString(body.color) ?? '#94a3b8',
    allowedActions: optStringArray(body.allowedActions) ?? [],
    priority: typeof body.priority === 'number' && Number.isFinite(body.priority) ? body.priority : 5,
    voiceConfig: voiceId !== undefined && providerId !== undefined
      ? { providerId, voiceId, ...(optString(voiceRaw.modelId) === undefined ? {} : { modelId: optString(voiceRaw.modelId)! }) }
      : null,
    isDefault: body.isDefault === true,
    isGenerated: body.isGenerated === true,
    boundStageId: optString(body.boundStageId) ?? null,
    courseId: optString(body.courseId) ?? null,
    createdAt: typeof body.createdAt === 'string' && body.createdAt.length > 0 ? body.createdAt : now,
    updatedAt: now,
  }
}

export function createClassroomRouter(context: AppContext): Router {
  const router = Router()

  const service = (): OpenmaicClassroomService | undefined => context.classroom

  // ---- 建课：登记一次课堂会话（不启动编排），返回会话与解析后的场景/角色 ----
  router.post('/sessions', async (req, res) => {
    const classroom = service()
    if (classroom === undefined) {
      sendError(res, 501, '互动课堂服务不可用')
      return
    }
    const body = asRecord(req.body)
    const parsed = await parseSessionInput(context, body)
    if (!parsed.ok) {
      sendError(res, parsed.status, parsed.message)
      return
    }

    const sessionId = optString(body.sessionId) ?? newId('cls')
    const now = new Date().toISOString()
    context.repo.upsertClassroomSession({
      id: sessionId,
      courseId: parsed.input.courseId ?? null,
      lessonId: parsed.input.lessonId ?? null,
      stageId: parsed.input.stageId ?? null,
      sessionType: parsed.input.sessionType ?? 'qa',
      status: 'active',
      input: parsed.input,
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    })

    res.status(201).json({
      sessionId,
      status: 'active',
      source: classroom.source,
      available: classroom.available,
      input: parsed.input,
      scenes: parsed.input.scenes ?? [],
    })
  })

  // ---- 会话列表（可选按课程过滤）----
  router.get('/sessions', (req, res) => {
    const courseId = optString(req.query.courseId)
    const classroom = service()
    const sessions = courseId === undefined
      ? context.repo.listClassroomSessions()
      : context.repo.listClassroomSessions(courseId)
    res.json({
      sessions,
      source: classroom?.source ?? 'fallback',
      available: classroom?.available ?? false,
    })
  })

  // ---- 开课：Director 循环（SSE，逐条下发课堂事件）----
  router.post('/chat', async (req, res) => {
    const classroom = service()
    if (classroom === undefined) {
      sendError(res, 501, '互动课堂服务不可用')
      return
    }
    const body = asRecord(req.body)
    // 续聊：以库内既有会话输入为底，请求体覆盖之。
    const requestedId = optString(body.sessionId)
    let base: ClassroomSessionInput | undefined
    if (requestedId !== undefined) {
      const stored = context.repo.getClassroomSession(requestedId)
      if (stored !== undefined) base = stored.input as ClassroomSessionInput
    }
    const parsed = await parseSessionInput(context, base === undefined ? body : { ...base, ...body })
    if (!parsed.ok) {
      sendError(res, parsed.status, parsed.message)
      return
    }

    const sessionId = requestedId ?? newId('cls')
    const controller = new AbortController()
    res.on('close', () => controller.abort())

    const channel = openSse(res)
    channel.send('meta', {
      sessionId,
      provider: context.llm.defaultProvider,
      model: context.llm.defaultModel,
      source: classroom.source,
      available: classroom.available,
    })

    try {
      for await (const event of classroom.runSession(parsed.input, { sessionId, signal: controller.signal })) {
        channel.send(event.type, event, event.seq)
        if (event.type === 'done') break
      }
    } catch (error) {
      channel.send('error', { message: error instanceof Error ? error.message : String(error), sessionId })
    } finally {
      channel.close()
    }
  })

  // ---- 事件 tail：补发历史 + 轮询增量（支持 Last-Event-ID 断点续传）----
  router.get('/sessions/:id/events', (req, res) => {
    const classroom = service()
    if (classroom === undefined) {
      sendError(res, 501, '互动课堂服务不可用')
      return
    }
    const sessionId = req.params.id
    const known =
      classroom.listSessions().some(meta => meta.sessionId === sessionId) ||
      context.repo.getClassroomSession(sessionId) !== undefined
    if (!known) {
      sendError(res, 404, '会话不存在')
      return
    }

    const headerId = req.get('Last-Event-ID')
    const queryAfter = Number.parseInt(String(req.query.afterSeq ?? ''), 10)
    const afterSeq = Number.isFinite(queryAfter)
      ? queryAfter
      : (headerId === undefined ? 0 : Number.parseInt(headerId, 10))
    tailSessionEvents(classroom, sessionId, Number.isFinite(afterSeq) ? afterSeq : 0, res)
  })

  // ---- 场景取数：某课程的 dsl Stage/Scene（无文档时回退课次要点）----
  router.get('/:courseId/scenes', async (req, res) => {
    const courseId = req.params.courseId
    const course = context.repo.getCourse(courseId)
    if (course === undefined) {
      sendError(res, 404, '课程不存在')
      return
    }
    const doc = await context.storage?.docs.loadDocument(courseId)
    const scenes = doc !== null && doc !== undefined && doc.scenes.length > 0
      ? doc.scenes
      : await resolveScenes(context, {}, courseId)
    res.json({
      courseId,
      stage: doc?.stage ?? null,
      scenes,
      dslAvailable: context.storage?.dslAvailable ?? false,
      dslVersion: context.storage?.dslVersion ?? null,
    })
  })

  // ---- 压缩轨迹：Director 上下文压缩诊断 ----
  router.get('/compaction', (_req, res) => {
    const classroom = service()
    if (classroom === undefined) {
      sendError(res, 501, '互动课堂服务不可用')
      return
    }
    res.json(classroom.getCompactionTrace())
  })

  return router
}

/** 角色 CRUD：课堂智能体配置（`agents` 表）。 */
export function createAgentsRouter(context: AppContext): Router {
  const router = Router()

  router.get('/', (req, res) => {
    const courseId = optString(req.query.courseId)
    res.json({ agents: context.repo.listAgents(courseId) })
  })

  router.post('/', (req, res) => {
    const body = asRecord(req.body)
    const id = optString(body.id) ?? newId('agent')
    const record = parseAgentRecord(body, id)
    if (record === null) {
      sendError(res, 400, 'name 不能为空')
      return
    }
    context.repo.upsertAgent(record)
    res.status(201).json({ agent: record })
  })

  router.delete('/:id', (req, res) => {
    const existing = context.repo.getAgent(req.params.id)
    if (existing === undefined) {
      sendError(res, 404, '角色不存在')
      return
    }
    context.repo.deleteAgent(req.params.id)
    res.status(204).end()
  })

  return router
}