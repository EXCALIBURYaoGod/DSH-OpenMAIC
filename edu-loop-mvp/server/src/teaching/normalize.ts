/**
 * 模型 JSON 输出的归一化：模型（尤其是不同 provider）字段常有缺失或类型漂移，
 * 这里把外部输入收敛成内部稳定结构，避免脏数据落库。
 *
 * @module teaching/normalize
 */

import type { RubricCriterion } from '../db/repo.js'

export interface OutlineLesson {
  title: string
  objective: string
  keyPoints: string[]
}

export interface CourseOutline {
  title: string
  summary: string
  objectives: string[]
  lessons: OutlineLesson[]
}

export interface GeneratedQuestion {
  type: 'single_choice' | 'short_answer'
  stem: string
  options: string[] | null
  answer: string
  explanation: string
  difficulty: 'easy' | 'medium' | 'hard'
}

export interface GradeResult {
  correct: boolean
  score: number
  feedback: string
}

export interface EvaluateResult {
  totalScore: number
  level: string
  perCriterion: Array<{ id: string; score: number; comment: string }>
  suggestions: string[]
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item.length > 0)
    .slice(0, limit)
}

export function normalizeOutline(raw: unknown, fallbackTopic: string): CourseOutline {
  const record = (raw ?? {}) as Record<string, unknown>
  const lessonsRaw = Array.isArray(record.lessons) ? record.lessons : []
  const lessons: OutlineLesson[] = lessonsRaw.slice(0, 8).map((item, index) => {
    const lesson = (item ?? {}) as Record<string, unknown>
    return {
      title: asString(lesson.title, `第 ${index + 1} 课`),
      objective: asString(lesson.objective, `完成第 ${index + 1} 课的学习目标`),
      keyPoints: asStringArray(lesson.keyPoints, 8),
    }
  })
  if (lessons.length === 0) {
    lessons.push({
      title: `${fallbackTopic}：核心概念`,
      objective: `建立「${fallbackTopic}」的整体认知框架`,
      keyPoints: ['定义与边界', '关键术语'],
    })
  }
  return {
    title: asString(record.title, `${fallbackTopic}：微型课程`),
    summary: asString(record.summary, `围绕「${fallbackTopic}」构建的微型课程。`),
    objectives: asStringArray(record.objectives, 8),
    lessons,
  }
}

export function normalizeQuestions(raw: unknown, limit: number): GeneratedQuestion[] {
  const record = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(record.questions) ? record.questions : Array.isArray(raw) ? raw : []
  return list.slice(0, limit).map((item, index) => {
    const question = (item ?? {}) as Record<string, unknown>
    const options = Array.isArray(question.options)
      ? question.options.map(option => String(option)).filter(option => option.trim().length > 0)
      : []
    const type = question.type === 'short_answer' || options.length === 0 ? 'short_answer' : 'single_choice'
    const difficulty = question.difficulty === 'easy' || question.difficulty === 'hard'
      ? question.difficulty
      : 'medium'
    return {
      type,
      stem: asString(question.stem, `第 ${index + 1} 题`),
      options: type === 'single_choice' ? options : null,
      answer: asString(question.answer, '（模型未给出参考答案）'),
      explanation: asString(question.explanation, ''),
      difficulty,
    }
  })
}

export function normalizeGrade(raw: unknown): GradeResult {
  const record = (raw ?? {}) as Record<string, unknown>
  const scoreRaw = typeof record.score === 'number' ? record.score : Number(record.score)
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 0
  const correct = typeof record.correct === 'boolean' ? record.correct : score >= 60
  return {
    correct,
    score,
    feedback: asString(record.feedback, correct ? '回答正确。' : '回答尚未达到参考答案的要求。'),
  }
}

export function normalizeRubricCriteria(raw: unknown): RubricCriterion[] {
  const record = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(record.criteria) ? record.criteria : []
  const criteria = list.slice(0, 6).map((item, index) => {
    const criterion = (item ?? {}) as Record<string, unknown>
    const levelsRaw = Array.isArray(criterion.levels) ? criterion.levels : []
    const levels = levelsRaw.slice(0, 5).map(levelItem => {
      const level = (levelItem ?? {}) as Record<string, unknown>
      const scoreRaw = typeof level.score === 'number' ? level.score : Number(level.score)
      return {
        level: asString(level.level, '等级'),
        score: Number.isFinite(scoreRaw) ? Math.max(1, Math.min(5, Math.round(scoreRaw))) : 1,
        descriptor: asString(level.descriptor, ''),
      }
    })
    const weightRaw = typeof criterion.weight === 'number' ? criterion.weight : Number(criterion.weight)
    return {
      id: asString(criterion.id, `criterion_${index + 1}`),
      name: asString(criterion.name, `维度 ${index + 1}`),
      weight: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1,
      descriptor: asString(criterion.descriptor, ''),
      levels,
    }
  })
  if (criteria.length === 0) return []
  // 归一化权重，保证之和为 1。
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  return criteria.map(criterion => ({
    ...criterion,
    weight: Number((criterion.weight / total).toFixed(3)),
  }))
}

export function normalizeEvaluation(raw: unknown, criteria: RubricCriterion[]): EvaluateResult {
  const record = (raw ?? {}) as Record<string, unknown>
  const totalRaw = typeof record.totalScore === 'number' ? record.totalScore : Number(record.totalScore)
  const perCriterionRaw = Array.isArray(record.perCriterion) ? record.perCriterion : []
  const perCriterion = perCriterionRaw.slice(0, 8).map(item => {
    const entry = (item ?? {}) as Record<string, unknown>
    const scoreRaw = typeof entry.score === 'number' ? entry.score : Number(entry.score)
    return {
      id: asString(entry.id, 'unknown'),
      score: Number.isFinite(scoreRaw) ? Math.max(1, Math.min(5, Math.round(scoreRaw))) : 1,
      comment: asString(entry.comment, ''),
    }
  })
  return {
    totalScore: Number.isFinite(totalRaw) ? Math.max(0, Math.min(100, Math.round(totalRaw))) : 0,
    level: asString(record.level, '合格'),
    perCriterion: perCriterion.length > 0
      ? perCriterion
      : criteria.map(criterion => ({ id: criterion.id, score: 1, comment: '缺少该维度的直接证据。' })),
    suggestions: asStringArray(record.suggestions, 6),
  }
}