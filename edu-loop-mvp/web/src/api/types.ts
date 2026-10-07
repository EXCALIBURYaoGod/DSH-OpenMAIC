/**
 * 与后端 API 共享的类型定义。
 *
 * @module api/types
 */

/** 运行模式：与后端 `NODE_ENV` 解析结果一致。 */
export type AppMode = 'development' | 'production'

/** `/api/health` 响应；用于前端感知当前运行模式。 */
export interface HealthResponse {
  ok: boolean
  mode: AppMode
  defaultProvider: string
  defaultModel: string
}

export interface ProviderModel {
  provider: string
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderInfo {
  id: string
  name: string
  /** 无凭据时回退到本地 mock 适配器。 */
  degraded: boolean
  models: ProviderModel[]
}

export interface ProvidersResponse {
  defaultProvider: string
  defaultModel: string
  providers: ProviderInfo[]
}

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
  type: 'single_choice' | 'short_answer'
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

export interface Evaluation {
  totalScore: number
  level: string
  perCriterion: Array<{ id: string; score: number; comment: string }>
  suggestions: string[]
}

export interface AttemptStats {
  attempted: number
  correct: number
  accuracy: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

export interface CourseDetail {
  course: Course
  lessons: Lesson[]
  stats: AttemptStats
  questionCount: number
}

export type EvalTarget = 'outline' | 'explain' | 'quiz' | 'grade'

export interface JudgeCriterion {
  id: string
  name: string
  weight: number
  anchor5: string
  anchor1: string
}

export interface JudgeResult {
  totalScore: number
  level: string
  perCriterion: Array<{ id: string; name: string; score: number; comment: string }>
  review: string
  suggestions: string[]
}

export interface EvalRun {
  id: string
  courseId: string
  targetType: EvalTarget
  targetId: string | null
  provider: string
  model: string
  degraded: boolean
  totalScore: number
  level: string
  detail: JudgeResult
  createdAt: string
}

export interface EvalOverview {
  targets: Array<{ target: EvalTarget; label: string; criteria: JudgeCriterion[] }>
  latest: Record<string, EvalRun>
  runs: EvalRun[]
}

// ---------------------------------------------------------------- 幻灯片

/** slide 元素（宽松结构，兼容 openmaic-slide 产出的 PPTist 风格）。 */
export interface SlideElement {
  type: string
  id: string
  left: number
  top: number
  width: number
  height: number
  fontSize?: number
  lineHeight?: number
  color?: string
  content?: string
  [key: string]: unknown
}

/** 单页幻灯片。 */
export interface Slide {
  id: string
  elements: SlideElement[]
  remark?: string
  [key: string]: unknown
}

/** openmaic-slide 服务产出的 PPTist 风格 SlideDeck。 */
export interface SlideDeck {
  id?: string
  name?: string
  createdAt?: number
  updatedAt?: number
  slides: Slide[]
  [key: string]: unknown
}

/** 幻灯片接口响应。 */
export interface SlideDeckResponse {
  deck: SlideDeck
  available: boolean
  source: 'openmaic' | 'builtin-fallback'
  dslVersion: string | null
}