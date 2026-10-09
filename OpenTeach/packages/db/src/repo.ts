/**
 * 数据访问层：把 SQLite 行映射为领域对象，并集中所有 SQL。
 *
 * @module db/repo
 */

import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from './sqlite.js'
import { bindable } from './sqlite.js'

// ---------------------------------------------------------------- 领域类型

export interface Course {
  id: string
  topic: string
  material: string | null
  title: string
  summary: string
  objectives: string[]
  provider: string
  model: string
  degraded: boolean
  createdAt: string
}

export interface Lesson {
  id: string
  courseId: string
  idx: number
  title: string
  objective: string
  keyPoints: string[]
  explanation: string | null
  explainedAt: string | null
}

export interface Question {
  id: string
  courseId: string
  lessonId: string | null
  idx: number
  type: string
  stem: string
  options: string[] | null
  answer: string
  explanation: string
  difficulty: string
}

export interface Attempt {
  id: string
  questionId: string
  courseId: string
  answer: string
  correct: boolean
  score: number
  feedback: string
  gradedBy: string
  createdAt: string
}

export interface Review {
  questionId: string
  courseId: string
  ease: number
  intervalDays: number
  repetitions: number
  dueAt: string
  lastGrade: number | null
  lastReviewedAt: string | null
}

export interface RubricCriterionLevel {
  level: string
  score: number
  descriptor: string
}

export interface RubricCriterion {
  id: string
  name: string
  weight: number
  descriptor: string
  levels: RubricCriterionLevel[]
}

export interface Rubric {
  id: string
  courseId: string
  criteria: RubricCriterion[]
  createdAt: string
}

export interface LlmCallLog {
  id: string
  provider: string
  model: string
  degraded: boolean
  task: string
  promptChars: number
  outputChars: number
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number
  status: string
  errorCode: string | null
  createdAt: string
}

/** LLM Judge 的一次评测运行结果。 */
export interface EvalRun {
  id: string
  courseId: string
  targetType: string
  targetId: string | null
  provider: string
  model: string
  degraded: boolean
  totalScore: number
  level: string
  detail: unknown
  createdAt: string
}

// ------------------------------------------ 互动课堂领域类型（Phase 3）

/** 课堂角色配置（对齐 openmaic-classroom 的 `ClassroomAgentConfig`）。 */
export interface AgentRecord {
  id: string
  name: string
  role: string
  persona: string
  avatar: string
  color: string
  allowedActions: string[]
  priority: number
  voiceConfig: { providerId: string; modelId?: string; voiceId: string } | null
  isDefault: boolean
  isGenerated: boolean
  boundStageId: string | null
  courseId: string | null
  createdAt: string
  updatedAt: string
}

/** 课堂会话（对齐 openmaic-classroom 的 `ClassroomSessionMeta`）。 */
export interface ClassroomSessionRecord {
  id: string
  courseId: string | null
  lessonId: string | null
  stageId: string | null
  sessionType: string
  status: string
  /** `ClassroomSessionInput` JSON（agentIds / message / scenes 等）。 */
  input: unknown
  /** 已产生的最大事件序号。 */
  lastSeq: number
  createdAt: string
  updatedAt: string
}

/** 课堂事件（SSE tail；`seq` 即 SSE event id，用于 `Last-Event-ID` 续传）。 */
export interface ClassroomEventRecord {
  sessionId: string
  seq: number
  type: string
  data: unknown
  createdAt: string
}

/** 白板动作流水（对齐 openmaic-classroom 的 `WhiteboardActionRecord`）。 */
export interface WhiteboardElementRecord {
  id: string
  sessionId: string | null
  /** 对应课堂事件的序号（可空）。 */
  seq: number | null
  courseId: string | null
  sceneId: string | null
  actionName: string
  agentId: string
  agentName: string
  params: Record<string, unknown>
  createdAt: string
}

/** TTS 语音产物登记（对齐 openmaic:audio 的 `TTSModelConfig` / `TTSGenerationResult`）。 */
export interface TtsAssetRecord {
  id: string
  sessionId: string | null
  messageId: string | null
  agentId: string | null
  providerId: string
  modelId: string | null
  voice: string
  speed: number | null
  format: string
  text: string
  textChars: number
  audioPath: string | null
  audioBytes: number
  status: string
  errorCode: string | null
  createdAt: string
}

// ---------------------------------------------------------------- 工具

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** NULL 安全取字符串列。 */
function optString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** NULL 安全取数值列。 */
function optNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

// ---------------------------------------------------------------- Repository

export class Repository {
  constructor(private readonly db: SqliteDatabase) {}

  // ---- courses ----
  insertCourse(course: Course): void {
    this.db.prepare(
      `INSERT INTO courses (id, topic, material, title, summary, objectives, provider, model, degraded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      course.id, course.topic, bindable(course.material), course.title, course.summary,
      JSON.stringify(course.objectives), course.provider, course.model,
      bindable(course.degraded), course.createdAt,
    )
  }

  getCourse(id: string): Course | undefined {
    const row = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(id)
    return row === undefined ? undefined : mapCourse(row)
  }

  listCourses(): Course[] {
    return this.db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all().map(mapCourse)
  }

  // ---- lessons ----
  insertLessons(lessons: Lesson[]): void {
    const statement = this.db.prepare(
      `INSERT INTO lessons (id, course_id, idx, title, objective, key_points, explanation, explained_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const lesson of lessons) {
      statement.run(
        lesson.id, lesson.courseId, lesson.idx, lesson.title, lesson.objective,
        JSON.stringify(lesson.keyPoints), bindable(lesson.explanation), bindable(lesson.explainedAt),
        new Date().toISOString(),
      )
    }
  }

  getLesson(id: string): Lesson | undefined {
    const row = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id)
    return row === undefined ? undefined : mapLesson(row)
  }

  listLessons(courseId: string): Lesson[] {
    return this.db
      .prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY idx ASC')
      .all(courseId)
      .map(mapLesson)
  }

  setLessonExplanation(lessonId: string, explanation: string, explainedAt: string): void {
    this.db
      .prepare('UPDATE lessons SET explanation = ?, explained_at = ? WHERE id = ?')
      .run(explanation, explainedAt, lessonId)
  }

  // ---- questions ----
  insertQuestions(questions: Question[]): void {
    const statement = this.db.prepare(
      `INSERT INTO questions (id, course_id, lesson_id, idx, type, stem, options, answer, explanation, difficulty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const question of questions) {
      statement.run(
        question.id, question.courseId, bindable(question.lessonId), question.idx, question.type,
        question.stem, question.options === null ? null : JSON.stringify(question.options),
        question.answer, question.explanation, question.difficulty, new Date().toISOString(),
      )
    }
  }

  listQuestions(courseId: string): Question[] {
    return this.db
      .prepare('SELECT * FROM questions WHERE course_id = ? ORDER BY idx ASC')
      .all(courseId)
      .map(mapQuestion)
  }

  getQuestion(id: string): Question | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id)
    return row === undefined ? undefined : mapQuestion(row)
  }

  countQuestions(courseId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM questions WHERE course_id = ?')
      .get(courseId)
    return Number(row?.n ?? 0)
  }

  // ---- attempts ----
  insertAttempt(attempt: Attempt): void {
    this.db.prepare(
      `INSERT INTO attempts (id, question_id, course_id, answer, correct, score, feedback, graded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attempt.id, attempt.questionId, attempt.courseId, attempt.answer,
      bindable(attempt.correct), attempt.score, attempt.feedback, attempt.gradedBy, attempt.createdAt,
    )
  }

  listAttempts(courseId: string): Attempt[] {
    return this.db
      .prepare('SELECT * FROM attempts WHERE course_id = ? ORDER BY created_at DESC')
      .all(courseId)
      .map(mapAttempt)
  }

  /** 每题取最近一次作答，返回 { attempted, correct, accuracy }。 */
  attemptStats(courseId: string): { attempted: number; correct: number; accuracy: number } {
    const rows = this.db.prepare(
      `SELECT question_id, correct, created_at FROM attempts WHERE course_id = ? ORDER BY created_at ASC`,
    ).all(courseId)
    const latest = new Map<string, boolean>()
    for (const row of rows) latest.set(String(row.question_id), Number(row.correct) === 1)
    const attempted = latest.size
    const correct = [...latest.values()].filter(Boolean).length
    return {
      attempted,
      correct,
      accuracy: attempted === 0 ? 0 : Math.round((correct / attempted) * 100),
    }
  }

  // ---- reviews（间隔重复调度） ----
  getReview(questionId: string): Review | undefined {
    const row = this.db.prepare('SELECT * FROM reviews WHERE question_id = ?').get(questionId)
    return row === undefined ? undefined : mapReview(row)
  }

  upsertReview(review: Review): void {
    this.db.prepare(
      `INSERT INTO reviews (question_id, course_id, ease, interval_days, repetitions, due_at, last_grade, last_reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(question_id) DO UPDATE SET
         ease = excluded.ease,
         interval_days = excluded.interval_days,
         repetitions = excluded.repetitions,
         due_at = excluded.due_at,
         last_grade = excluded.last_grade,
         last_reviewed_at = excluded.last_reviewed_at`,
    ).run(
      review.questionId, review.courseId, review.ease, review.intervalDays, review.repetitions,
      review.dueAt, bindable(review.lastGrade), bindable(review.lastReviewedAt), new Date().toISOString(),
    )
  }

  listDueReviews(courseId: string | undefined, nowIso: string, limit = 50): Review[] {
    const sql = courseId === undefined
      ? 'SELECT * FROM reviews WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?'
      : 'SELECT * FROM reviews WHERE course_id = ? AND due_at <= ? ORDER BY due_at ASC LIMIT ?'
    const rows = courseId === undefined
      ? this.db.prepare(sql).all(nowIso, limit)
      : this.db.prepare(sql).all(courseId, nowIso, limit)
    return rows.map(mapReview)
  }

  listReviews(courseId: string): Review[] {
    return this.db
      .prepare('SELECT * FROM reviews WHERE course_id = ? ORDER BY due_at ASC')
      .all(courseId)
      .map(mapReview)
  }

  // ---- rubrics ----
  insertRubric(rubric: Rubric): void {
    this.db
      .prepare('INSERT INTO rubrics (id, course_id, criteria, created_at) VALUES (?, ?, ?, ?)')
      .run(rubric.id, rubric.courseId, JSON.stringify(rubric.criteria), rubric.createdAt)
  }

  latestRubric(courseId: string): Rubric | undefined {
    const row = this.db
      .prepare('SELECT * FROM rubrics WHERE course_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(courseId)
    return row === undefined ? undefined : mapRubric(row)
  }

  insertRubricEvaluation(evaluation: {
    id: string
    courseId: string
    rubricId: string
    totalScore: number
    level: string
    detail: unknown
    createdAt: string
  }): void {
    this.db.prepare(
      `INSERT INTO rubric_evaluations (id, course_id, rubric_id, total_score, level, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evaluation.id, evaluation.courseId, evaluation.rubricId,
      evaluation.totalScore, evaluation.level, JSON.stringify(evaluation.detail), evaluation.createdAt,
    )
  }

  latestEvaluation(courseId: string): { id: string; totalScore: number; level: string; detail: unknown; createdAt: string } | undefined {
    const row = this.db
      .prepare('SELECT * FROM rubric_evaluations WHERE course_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(courseId)
    if (row === undefined) return undefined
    return {
      id: String(row.id),
      totalScore: Number(row.total_score),
      level: String(row.level),
      detail: parseJson<unknown>(row.detail, {}),
      createdAt: String(row.created_at),
    }
  }

  // ---- LLM 调用日志 ----
  insertLlmLog(log: LlmCallLog): void {
    this.db.prepare(
      `INSERT INTO llm_call_logs
         (id, provider, model, degraded, task, prompt_chars, output_chars, input_tokens, output_tokens, latency_ms, status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      log.id, log.provider, log.model, bindable(log.degraded), log.task, log.promptChars,
      log.outputChars, bindable(log.inputTokens), bindable(log.outputTokens), log.latencyMs,
      log.status, bindable(log.errorCode), log.createdAt,
    )
  }

  // ---- LLM Judge 评测运行 ----
  insertEvalRun(run: EvalRun): void {
    this.db.prepare(
      `INSERT INTO eval_runs
         (id, course_id, target_type, target_id, judge_provider, judge_model, degraded, total_score, level, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id, run.courseId, run.targetType, bindable(run.targetId),
      run.provider, run.model, bindable(run.degraded), run.totalScore, run.level,
      JSON.stringify(run.detail), run.createdAt,
    )
  }

  listEvalRuns(courseId: string, targetType?: string, limit = 50): EvalRun[] {
    const sql = targetType === undefined
      ? 'SELECT * FROM eval_runs WHERE course_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM eval_runs WHERE course_id = ? AND target_type = ? ORDER BY created_at DESC LIMIT ?'
    const rows = targetType === undefined
      ? this.db.prepare(sql).all(courseId, limit)
      : this.db.prepare(sql).all(courseId, targetType, limit)
    return rows.map(mapEvalRun)
  }

  /** 每个 target_type 各取最近一次评测，用于前端快捷展示。 */
  latestEvalPerType(courseId: string): Record<string, EvalRun> {
    const all = this.listEvalRuns(courseId, undefined, 500)
    const latest = new Map<string, EvalRun>()
    for (const run of all) {
      if (latest.has(run.targetType)) continue
      latest.set(run.targetType, run)
    }
    return Object.fromEntries(latest)
  }

  listLlmLogs(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM llm_call_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(row => ({
        id: row.id,
        provider: row.provider,
        model: row.model,
        degraded: Number(row.degraded) === 1,
        task: row.task,
        promptChars: Number(row.prompt_chars),
        outputChars: Number(row.output_chars),
        inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
        outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
        latencyMs: Number(row.latency_ms),
        status: row.status,
        errorCode: row.error_code,
        createdAt: row.created_at,
      }))
  }

  // ---- agents（课堂角色配置）----
  upsertAgent(agent: AgentRecord): void {
    this.db.prepare(
      `INSERT INTO agents (id, name, role, persona, avatar, color, allowed_actions, priority, voice_config,
                           is_default, is_generated, bound_stage_id, course_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         persona = excluded.persona,
         avatar = excluded.avatar,
         color = excluded.color,
         allowed_actions = excluded.allowed_actions,
         priority = excluded.priority,
         voice_config = excluded.voice_config,
         is_default = excluded.is_default,
         is_generated = excluded.is_generated,
         bound_stage_id = excluded.bound_stage_id,
         course_id = excluded.course_id,
         updated_at = excluded.updated_at`,
    ).run(
      agent.id, agent.name, agent.role, agent.persona, agent.avatar, agent.color,
      JSON.stringify(agent.allowedActions), agent.priority,
      agent.voiceConfig === null ? null : JSON.stringify(agent.voiceConfig),
      bindable(agent.isDefault), bindable(agent.isGenerated), bindable(agent.boundStageId),
      bindable(agent.courseId), agent.createdAt, agent.updatedAt,
    )
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
    return row === undefined ? undefined : mapAgent(row)
  }

  listAgents(courseId?: string): AgentRecord[] {
    const rows = courseId === undefined
      ? this.db.prepare('SELECT * FROM agents ORDER BY priority DESC, id ASC').all()
      : this.db.prepare('SELECT * FROM agents WHERE course_id = ? ORDER BY priority DESC, id ASC').all(courseId)
    return rows.map(mapAgent)
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  // ---- classroom_sessions（课堂会话）----
  upsertClassroomSession(session: ClassroomSessionRecord): void {
    this.db.prepare(
      `INSERT INTO classroom_sessions (id, course_id, lesson_id, stage_id, session_type, status, input, last_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         input = excluded.input,
         last_seq = excluded.last_seq,
         updated_at = excluded.updated_at`,
    ).run(
      session.id, bindable(session.courseId), bindable(session.lessonId), bindable(session.stageId),
      session.sessionType, session.status, JSON.stringify(session.input ?? {}), session.lastSeq,
      session.createdAt, session.updatedAt,
    )
  }

  getClassroomSession(id: string): ClassroomSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM classroom_sessions WHERE id = ?').get(id)
    return row === undefined ? undefined : mapClassroomSession(row)
  }

  listClassroomSessions(courseId?: string): ClassroomSessionRecord[] {
    const rows = courseId === undefined
      ? this.db.prepare('SELECT * FROM classroom_sessions ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM classroom_sessions WHERE course_id = ? ORDER BY created_at DESC').all(courseId)
    return rows.map(mapClassroomSession)
  }

  /** 仅更新会话状态与游标（每次事件落库后调用，避免整行重写）。 */
  updateClassroomSessionState(sessionId: string, status: string, lastSeq: number, updatedAt: string): void {
    this.db
      .prepare('UPDATE classroom_sessions SET status = ?, last_seq = ?, updated_at = ? WHERE id = ?')
      .run(status, lastSeq, updatedAt, sessionId)
  }

  // ---- classroom_events（课堂事件流）----
  appendClassroomEvent(event: ClassroomEventRecord): void {
    this.db.prepare(
      `INSERT INTO classroom_events (session_id, seq, type, data, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET type = excluded.type, data = excluded.data`,
    ).run(event.sessionId, event.seq, event.type, JSON.stringify(event.data ?? {}), event.createdAt)
  }

  appendClassroomEvents(events: ClassroomEventRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO classroom_events (session_id, seq, type, data, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET type = excluded.type, data = excluded.data`,
    )
    for (const event of events) {
      statement.run(event.sessionId, event.seq, event.type, JSON.stringify(event.data ?? {}), event.createdAt)
    }
  }

  /** 读取会话事件（`afterSeq` 之前的跳过，用于 SSE `Last-Event-ID` 续传）。 */
  listClassroomEvents(sessionId: string, afterSeq = 0): ClassroomEventRecord[] {
    return this.db
      .prepare('SELECT * FROM classroom_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC')
      .all(sessionId, afterSeq)
      .map(mapClassroomEvent)
  }

  // ---- whiteboard_elements（白板动作流水）----
  appendWhiteboardElements(records: WhiteboardElementRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO whiteboard_elements (id, session_id, seq, course_id, scene_id, action_name, agent_id, agent_name, params, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET params = excluded.params`,
    )
    for (const record of records) {
      statement.run(
        record.id, bindable(record.sessionId), bindable(record.seq), bindable(record.courseId),
        bindable(record.sceneId), record.actionName, record.agentId, record.agentName,
        JSON.stringify(record.params ?? {}), record.createdAt,
      )
    }
  }

  listWhiteboardElements(sessionId: string): WhiteboardElementRecord[] {
    return this.db
      .prepare('SELECT * FROM whiteboard_elements WHERE session_id = ? ORDER BY seq ASC, created_at ASC')
      .all(sessionId)
      .map(mapWhiteboardElement)
  }

  // ---- tts_assets（语音产物登记）----
  insertTtsAsset(asset: TtsAssetRecord): void {
    this.db.prepare(
      `INSERT INTO tts_assets (id, session_id, message_id, agent_id, provider_id, model_id, voice, speed,
                               format, text, text_chars, audio_path, audio_bytes, status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.id, bindable(asset.sessionId), bindable(asset.messageId), bindable(asset.agentId),
      asset.providerId, bindable(asset.modelId), asset.voice, bindable(asset.speed), asset.format,
      asset.text, asset.textChars, bindable(asset.audioPath), asset.audioBytes, asset.status,
      bindable(asset.errorCode), asset.createdAt,
    )
  }

  listTtsAssets(sessionId?: string): TtsAssetRecord[] {
    const rows = sessionId === undefined
      ? this.db.prepare('SELECT * FROM tts_assets ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM tts_assets WHERE session_id = ? ORDER BY created_at DESC').all(sessionId)
    return rows.map(mapTtsAsset)
  }
}

// ---------------------------------------------------------------- 行映射

function mapCourse(row: Record<string, unknown>): Course {
  return {
    id: String(row.id),
    topic: String(row.topic),
    material: row.material === null ? null : String(row.material),
    title: String(row.title),
    summary: String(row.summary),
    objectives: parseJson<string[]>(row.objectives, []),
    provider: String(row.provider),
    model: String(row.model),
    degraded: Number(row.degraded) === 1,
    createdAt: String(row.created_at),
  }
}

function mapLesson(row: Record<string, unknown>): Lesson {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    idx: Number(row.idx),
    title: String(row.title),
    objective: String(row.objective),
    keyPoints: parseJson<string[]>(row.key_points, []),
    explanation: row.explanation === null ? null : String(row.explanation),
    explainedAt: row.explained_at === null ? null : String(row.explained_at),
  }
}

function mapQuestion(row: Record<string, unknown>): Question {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    lessonId: row.lesson_id === null ? null : String(row.lesson_id),
    idx: Number(row.idx),
    type: String(row.type),
    stem: String(row.stem),
    options: row.options === null ? null : parseJson<string[] | null>(row.options, null),
    answer: String(row.answer),
    explanation: String(row.explanation),
    difficulty: String(row.difficulty),
  }
}

function mapAttempt(row: Record<string, unknown>): Attempt {
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    courseId: String(row.course_id),
    answer: String(row.answer),
    correct: Number(row.correct) === 1,
    score: Number(row.score),
    feedback: String(row.feedback),
    gradedBy: String(row.graded_by),
    createdAt: String(row.created_at),
  }
}

function mapReview(row: Record<string, unknown>): Review {
  return {
    questionId: String(row.question_id),
    courseId: String(row.course_id),
    ease: Number(row.ease),
    intervalDays: Number(row.interval_days),
    repetitions: Number(row.repetitions),
    dueAt: String(row.due_at),
    lastGrade: row.last_grade === null ? null : Number(row.last_grade),
    lastReviewedAt: row.last_reviewed_at === null ? null : String(row.last_reviewed_at),
  }
}

function mapRubric(row: Record<string, unknown>): Rubric {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    criteria: parseJson<RubricCriterion[]>(row.criteria, []),
    createdAt: String(row.created_at),
  }
}

function mapEvalRun(row: Record<string, unknown>): EvalRun {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    targetType: String(row.target_type),
    targetId: row.target_id === null ? null : String(row.target_id),
    provider: String(row.judge_provider),
    model: String(row.judge_model),
    degraded: Number(row.degraded) === 1,
    totalScore: Number(row.total_score),
    level: String(row.level),
    detail: parseJson<unknown>(row.detail, {}),
    createdAt: String(row.created_at),
  }
}

function mapAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    persona: String(row.persona),
    avatar: String(row.avatar),
    color: String(row.color),
    allowedActions: parseJson<string[]>(row.allowed_actions, []),
    priority: Number(row.priority),
    voiceConfig: row.voice_config === null || row.voice_config === undefined
      ? null
      : parseJson<AgentRecord['voiceConfig']>(row.voice_config, null),
    isDefault: Number(row.is_default) === 1,
    isGenerated: Number(row.is_generated) === 1,
    boundStageId: optString(row.bound_stage_id),
    courseId: optString(row.course_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapClassroomSession(row: Record<string, unknown>): ClassroomSessionRecord {
  return {
    id: String(row.id),
    courseId: optString(row.course_id),
    lessonId: optString(row.lesson_id),
    stageId: optString(row.stage_id),
    sessionType: String(row.session_type),
    status: String(row.status),
    input: parseJson<unknown>(row.input, {}),
    lastSeq: Number(row.last_seq),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapClassroomEvent(row: Record<string, unknown>): ClassroomEventRecord {
  return {
    sessionId: String(row.session_id),
    seq: Number(row.seq),
    type: String(row.type),
    data: parseJson<unknown>(row.data, {}),
    createdAt: String(row.created_at),
  }
}

function mapWhiteboardElement(row: Record<string, unknown>): WhiteboardElementRecord {
  return {
    id: String(row.id),
    sessionId: optString(row.session_id),
    seq: optNumber(row.seq),
    courseId: optString(row.course_id),
    sceneId: optString(row.scene_id),
    actionName: String(row.action_name),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name),
    params: parseJson<Record<string, unknown>>(row.params, {}),
    createdAt: String(row.created_at),
  }
}

function mapTtsAsset(row: Record<string, unknown>): TtsAssetRecord {
  return {
    id: String(row.id),
    sessionId: optString(row.session_id),
    messageId: optString(row.message_id),
    agentId: optString(row.agent_id),
    providerId: String(row.provider_id),
    modelId: optString(row.model_id),
    voice: String(row.voice),
    speed: optNumber(row.speed),
    format: String(row.format),
    text: String(row.text),
    textChars: Number(row.text_chars),
    audioPath: optString(row.audio_path),
    audioBytes: Number(row.audio_bytes),
    status: String(row.status),
    errorCode: optString(row.error_code),
    createdAt: String(row.created_at),
  }
}