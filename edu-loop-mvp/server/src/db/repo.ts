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