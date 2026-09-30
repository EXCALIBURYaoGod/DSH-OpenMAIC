/**
 * LLM Judge：对 MVP 自身产生的教学产物进行打分。
 *
 * 运行流程：
 *   1. 从仓库收集某一类型的产物（如某道题、某篇讲解）；
 *   2. 组装判分提示词，要求 Judge 按维度给出 1-5 分与评语；
 *   3. 归一化结果，按权重加权得到 0-100 总分与等级；
 *   4. 落库为一条 eval_runs，供指标聚合与迭代对比。
 *
 * @module eval/judge
 */

import { extractJson } from '../teaching/json.js'
import { runLlm } from '../teaching/llm.js'
import { newId, type EvalRun, type Repository } from '../db/repo.js'
import { levelForScore, metricsFor, type EvalTarget, type JudgeCriterion } from './metrics.js'
import type { LlmTaskContext } from '../teaching/llm.js'

export const JUDGE_SYSTEM = [
  '你是一名严谨的教学评估专家（LLM Judge）。',
  '你的任务是评估教学系统生成的教学产物质量，而不是评估学习者。',
  '请严格依据各维度的锚点打分，避免光环效应：优秀的维度给高分、有明显缺陷的维度给低分。',
  '只输出 JSON，不要输出解释文字。',
].join('\n')

export interface JudgeArtifact {
  label: string
  content: string
}

export interface JudgeCriterionScore {
  id: string
  name: string
  score: number
  comment: string
}

export interface JudgeResult {
  totalScore: number
  level: string
  perCriterion: JudgeCriterionScore[]
  review: string
  suggestions: string[]
}

function judgePrompt(artifact: JudgeArtifact, criteria: JudgeCriterion[]): string {
  const lines = [
    '[[task:eval_judge]]',
    `评估对象：${artifact.label}`,
    '',
    '请对下面这份教学产物按以下维度打分（每维 1-5 分），并**只输出**如下 JSON：',
    '{',
    '  "totalScore": 0-100 加权总分,',
    '  "perCriterion": [ { "id": "维度id", "score": 1-5, "comment": "评语" } ],',
    '  "review": "一句话总体评语",',
    '  "suggestions": ["可执行的改进建议"]',
    '}',
    '',
    '评分维度与锚点：',
    criteria.map((item, index) =>
      `${index + 1}. ${item.name}（id=${item.id}，权重${Math.round(item.weight * 100)}%）：5 分=${item.anchor5}；1 分=${item.anchor1}`,
    ).join('\n'),
  ]
  if (artifact.content.trim().length > 0) {
    lines.push('', '教学产物内容：', artifact.content.trim().slice(0, 6000))
  } else {
    lines.push('', '（该产物为空，请按实际质量如实打分）')
  }
  return lines.join('\n')
}

export function normalizeJudgeResult(raw: unknown, criteria: JudgeCriterion[], fallbackReview: string): JudgeResult {
  const record = (raw ?? {}) as Record<string, unknown>
  const perCriterionRaw = Array.isArray(record.perCriterion) ? record.perCriterion : []

  const scoreById = new Map<string, number>()
  const commentById = new Map<string, string>()
  for (const item of perCriterionRaw) {
    const entry = (item ?? {}) as Record<string, unknown>
    if (typeof entry.id !== 'string') continue
    const scoreRaw = typeof entry.score === 'number' ? entry.score : Number(entry.score)
    scoreById.set(entry.id, Number.isFinite(scoreRaw) ? Math.max(1, Math.min(5, Math.round(scoreRaw))) : 1)
    if (typeof entry.comment === 'string') commentById.set(entry.id, entry.comment)
  }

  const perCriterion: JudgeCriterionScore[] = criteria.map(item => ({
    id: item.id,
    name: item.name,
    score: scoreById.get(item.id) ?? 1,
    comment: commentById.get(item.id) ?? '',
  }))

  const weighted = perCriterion.reduce((sum, item, index) => sum + item.score * (criteria[index]!.weight), 0)
  // 1-5 分映射到 0-100。
  const totalScore = Math.round((weighted / 5) * 100)
  const totalRaw = typeof record.totalScore === 'number' ? record.totalScore : Number(record.totalScore)
  const finalTotal = Number.isFinite(totalRaw) ? Math.max(0, Math.min(100, Math.round(totalRaw))) : totalScore

  const suggestions = Array.isArray(record.suggestions)
    ? record.suggestions
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(item => item.length > 0)
        .slice(0, 6)
    : []

  return {
    totalScore: finalTotal,
    level: levelForScore(finalTotal),
    perCriterion,
    review: typeof record.review === 'string' && record.review.trim().length > 0 ? record.review.trim() : fallbackReview,
    suggestions,
  }
}

export function runJudge(
  context: LlmTaskContext,
  input: {
    target: EvalTarget
    artifact: JudgeArtifact
    /** 可选，用于覆盖默认 task 名（日志用）。 */
    taskLabel?: string
  },
): Promise<JudgeResult> {
  const metrics = metricsFor(input.target)
  const fallbackReview = `「${input.artifact.label}」整体${levelForScore(50)}，但各维度表现不均。`
  return runLlm(context, {
    task: input.taskLabel ?? `eval_${input.target}`,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(input.artifact, metrics.criteria),
  }).then(result => {
    if (result.errorCode !== undefined) {
      throw new Error(`判分调用失败（${result.errorCode}）：${result.errorMessage ?? '未知错误'}`)
    }
    return normalizeJudgeResult(extractJson<unknown>(result.text), metrics.criteria, fallbackReview)
  })
}

export function persistEvalRun(
  repo: Repository,
  input: {
    courseId: string
    target: EvalTarget
    targetId: string | null
    provider: string
    model: string
    degraded: boolean
    result: JudgeResult
  },
): EvalRun {
  const run: EvalRun = {
    id: newId('evalrun'),
    courseId: input.courseId,
    targetType: input.target,
    targetId: input.targetId,
    provider: input.provider,
    model: input.model,
    degraded: input.degraded,
    totalScore: input.result.totalScore,
    level: input.result.level,
    detail: input.result,
    createdAt: new Date().toISOString(),
  }
  repo.insertEvalRun(run)
  return run
}