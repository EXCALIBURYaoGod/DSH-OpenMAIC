/**
 * LLM Judge 的评测指标定义。
 *
 * 每个可诊断的教学产物类型（大纲 / 讲解 / 题目 / 判分反馈）对应一组带权重的维度，
 * 维度打分为 1-5 分制，按权重加权得到 0-100 的总分。
 *
 * @module eval/metrics
 */

export type EvalTarget = 'outline' | 'explain' | 'quiz' | 'grade'

export const EVAL_TARGETS: EvalTarget[] = ['outline', 'explain', 'quiz', 'grade']

export const EVAL_TARGET_LABELS: Record<EvalTarget, string> = {
  outline: '课程大纲',
  explain: '结构化讲解',
  quiz: '测验题目',
  grade: '判分反馈',
}

export interface JudgeCriterion {
  id: string
  name: string
  /** 该维度占总分权重，各项之和为 1。 */
  weight: number
  /** 1-5 分判分要点，供 Judge 依据的锚点。 */
  anchor5: string
  anchor1: string
}

export interface JudgeMetrics {
  target: EvalTarget
  criteria: JudgeCriterion[]
}

const CRITERIA: Record<EvalTarget, JudgeCriterion[]> = {
  outline: [
    {
      id: 'accuracy',
      name: '内容准确性',
      weight: 0.3,
      anchor5: '概念、表述与学科常识一致，无硬伤',
      anchor1: '存在明显的事实或逻辑错误',
    },
    {
      id: 'coherence',
      name: '目标-课次连贯性',
      weight: 0.25,
      anchor5: '学习目标清晰，课次递进合理且服务于目标',
      anchor1: '目标含糊，课次彼此割裂或重复',
    },
    {
      id: 'actionability',
      name: '可操作性',
      weight: 0.25,
      anchor5: '学习者能据此形成明确的学习与练习路径',
      anchor1: '泛泛而谈，无法指导行动',
    },
    {
      id: 'coverage',
      name: '关键概念覆盖',
      weight: 0.2,
      anchor5: '主题的关键概念与边界均被覆盖',
      anchor1: '遗漏核心概念或边界模糊',
    },
  ],
  explain: [
    {
      id: 'accuracy',
      name: '内容准确性',
      weight: 0.3,
      anchor5: '关键概念与原理表述准确',
      anchor1: '存在概念或逻辑错误',
    },
    {
      id: 'clarity',
      name: '直观易懂',
      weight: 0.3,
      anchor5: '从直觉到细节循序渐进，语言平实少术语堆砌',
      anchor1: '跳跃或堆砌术语，难以跟上',
    },
    {
      id: 'structure',
      name: '结构完整',
      weight: 0.2,
      anchor5: '包含直觉、关键概念、例子、误区、自检等要素',
      anchor1: '缺少其中多数要素',
    },
    {
      id: 'example',
      name: '例子质量',
      weight: 0.2,
      anchor5: '有贴近学习者的具体例子，能帮助迁移',
      anchor1: '没有例子或例子空泛',
    },
  ],
  quiz: [
    {
      id: 'validity',
      name: '与目标一致',
      weight: 0.25,
      anchor5: '题目直接考察本课学习目标',
      anchor1: '题目与本课目标无关',
    },
    {
      id: 'unambiguity',
      name: '题干无歧义',
      weight: 0.25,
      anchor5: '题干指向唯一正确理解，选项互斥',
      anchor1: '题干含混，多个选项都可能正确',
    },
    {
      id: 'difficulty',
      name: '难度合理',
      weight: 0.25,
      anchor5: '难度标注与实际水平匹配，且有梯度',
      anchor1: '难度标注明显失衡',
    },
    {
      id: 'explanation',
      name: '解析质量',
      weight: 0.25,
      anchor5: '解析解释对在哪、错在哪，指向复习',
      anchor1: '解析缺失或流于复述答案',
    },
  ],
  grade: [
    {
      id: 'accuracy',
      name: '判分准确',
      weight: 0.4,
      anchor5: '对/错判断与参考答案实质一致',
      anchor1: '判分明显错误',
    },
    {
      id: 'actionability',
      name: '反馈可执行',
      weight: 0.4,
      anchor5: '指出差距并给出可立即执行的改进步骤',
      anchor1: '反馈空泛，无具体改进',
    },
    {
      id: 'tone',
      name: '语气建设性',
      weight: 0.2,
      anchor5: '鼓励且不打击，聚焦改进而非指责',
      anchor1: '语气冷漠或指责性',
    },
  ],
}

export function metricsFor(target: EvalTarget): JudgeMetrics {
  return { target, criteria: CRITERIA[target] }
}

/** 依据加权总分给出等级（与量规一致的口径）。 */
export function levelForScore(total: number): string {
  if (total >= 85) return '优秀'
  if (total >= 70) return '良好'
  if (total >= 50) return '合格'
  return '待提升'
}