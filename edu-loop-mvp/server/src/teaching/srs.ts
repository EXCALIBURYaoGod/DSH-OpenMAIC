/**
 * 间隔重复调度（简化 SM-2）。
 *
 * 报告指出教学闭环的后半段（复习 + 评估）是常被忽略的空白，这里用最简单的
 * 可运行实现把它补上：每次回忆质量评分（0-5）驱动难度因子 ease 与复习间隔。
 *
 * @module teaching/srs
 */

export interface SrsState {
  ease: number
  intervalDays: number
  repetitions: number
}

export interface SrsResult extends SrsState {
  dueAt: string
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000
/** 复习评分的取值范围（0=完全想不起来，5=脱口而出）。 */
export const MIN_GRADE = 0
export const MAX_GRADE = 5

/**
 * 依据 SM-2 计算下一次复习时间。
 * @param state 当前调度状态
 * @param grade 回忆质量 0-5
 * @param now 计算基准时间
 */
export function schedule(state: SrsState, grade: number, now: Date = new Date()): SrsResult {
  const clamped = Math.max(MIN_GRADE, Math.min(MAX_GRADE, Math.round(grade)))
  // 与函数名同名的参数会遮蔽函数，这里显式引用外部 ease 计算。
  const nextEase = clampEase(state.ease + (0.1 - (5 - clamped) * (0.08 + (5 - clamped) * 0.02)))
  const repetitions = clamped < 3 ? 0 : state.repetitions + 1
  const intervalDays = clamped < 3
    ? 1
    : repetitions === 1
      ? 1
      : repetitions === 2
        ? 6
        : Math.max(1, Math.round(state.intervalDays * nextEase))

  return {
    ease: nextEase,
    intervalDays,
    repetitions,
    dueAt: new Date(now.getTime() + intervalDays * MS_PER_DAY).toISOString(),
  }
}

/** 新建一道题的初始调度状态：立刻到期，等待第一次作答。 */
export function initialReview(now: Date = new Date()): SrsResult {
  return { ease: 2.5, intervalDays: 0, repetitions: 0, dueAt: now.toISOString() }
}

/** 把作答正确与否折算为回忆质量：答对=4（良好），答错=2（不合格）。 */
export function gradeFromCorrect(correct: boolean): number {
  return correct ? 4 : 2
}

function clampEase(ease: number): number {
  return Math.max(1.3, Math.min(2.8, Number(ease.toFixed(2))))
}