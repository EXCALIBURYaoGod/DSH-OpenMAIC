/**
 * 确定性 mock 适配器：无需网络与凭据即可跑通完整教学闭环。
 *
 * 它沿用同一套 `LlmAdapter` 契约与 `StreamChunk` 协议，因此上层教学流程代码
 * 完全不需要知道当前用的是真模型还是 mock——这正是「一切皆插件」的好处。
 *
 * 识别方式：教学提示词里带有 `[[task:xxx]]` 标记，mock 据此返回对应的确定性内容。
 * 没有标记时回退为一段说明文本。
 *
 * @module llm/adapters/mock
 */

import { LlmAdapter } from '../registry.js'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '../types.js'

const TASK_MARKER = /\[\[task:([a-z_]+)\]\]/

export class MockAdapter extends LlmAdapter {
  private readonly displayName: string
  private readonly models: readonly LlmModelInfo[]
  /** 每个文本分片的字符数。 */
  private readonly chunkSize: number
  /** 每个分片之间的间隔毫秒数，用于让前端能看到真实的流式效果。 */
  private readonly chunkDelayMs: number

  constructor(options: {
    provider: string
    displayName: string
    models: readonly LlmModelInfo[]
    chunkSize?: number
    chunkDelayMs?: number
  }) {
    super()
    this.displayName = options.displayName
    this.models = options.models
    this.chunkSize = options.chunkSize ?? 24
    this.chunkDelayMs = options.chunkDelayMs ?? 6
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName, degraded: true }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.models.map(model => ({ ...model, provider }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.models.find(entry => entry.id === model)
    return { provider, id: model, name: found?.name ?? model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = [options.system ?? '', ...options.messages.map(message => message.content)].join('\n')
    const task = TASK_MARKER.exec(prompt)?.[1] ?? 'unknown'
    const answer = renderTask(task, prompt)

    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let offset = 0; offset < answer.length; offset += this.chunkSize) {
      const text = answer.slice(offset, offset + this.chunkSize)
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
      yield { type: 'text-delta', index: 0, text }
    }
    const block: ContentBlock = { type: 'text', text: answer }
    yield { type: 'block-end', index: 0, block }
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.ceil(prompt.length / 2),
        outputTokens: Math.ceil(answer.length / 2),
        totalTokens: Math.ceil((prompt.length + answer.length) / 2),
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pick(prompt: string, label: string): string {
  const match = new RegExp(`${label}[:：]\\s*(.+)`).exec(prompt)
  return match?.[1]?.trim() ?? ''
}

function renderTask(task: string, prompt: string): string {
  switch (task) {
    case 'course_outline':
      return JSON.stringify(mockOutline(pick(prompt, '主题') || '未命名主题'), null, 2)
    case 'lesson_explain':
      return mockExplanation(pick(prompt, '课题') || '本课', pick(prompt, '学习目标'))
    case 'quiz_generate':
      return JSON.stringify(mockQuiz(pick(prompt, '课题') || '本课', Number.parseInt(pick(prompt, '数量'), 10) || 3), null, 2)
    case 'quiz_grade':
      return JSON.stringify(mockGrade(pick(prompt, '参考答案'), pick(prompt, '学习者作答')), null, 2)
    case 'rubric_generate':
      return JSON.stringify(mockRubric(pick(prompt, '主题') || '本课程'), null, 2)
    case 'rubric_evaluate':
      return JSON.stringify(mockEvaluate(prompt), null, 2)
    case 'eval_judge':
      return JSON.stringify(mockJudge(prompt), null, 2)
    default:
      return `【本地 mock 适配器】未识别到任务标记，已返回占位内容。\n\n收到的提示词摘要：\n${prompt.slice(0, 200)}`
  }
}

function mockOutline(topic: string): unknown {
  return {
    title: `${topic}：从入门到实践`,
    summary: `本课程围绕「${topic}」构建一条完整的学习路径，先建立概念地图，再通过练习与复习巩固。`,
    objectives: [
      `能用自己的话解释「${topic}」的核心概念`,
      `能在具体情境中应用「${topic}」的基本方法`,
      `能识别并纠正常见的理解误区`,
    ],
    lessons: [
      {
        title: `${topic}：核心概念与地图`,
        objective: `建立「${topic}」的整体认知框架`,
        keyPoints: ['定义与边界', '关键术语', '与相邻概念的关系'],
      },
      {
        title: `${topic}：典型方法与步骤`,
        objective: `掌握「${topic}」的标准操作流程`,
        keyPoints: ['方法步骤', '适用条件', '常见错误'],
      },
      {
        title: `${topic}：综合应用与迁移`,
        objective: `能把「${topic}」迁移到新问题中`,
        keyPoints: ['案例分析', '迁移策略', '自我检查清单'],
      },
    ],
  }
}

function mockExplanation(lesson: string, objective: string): string {
  return [
    `# ${lesson}`,
    '',
    `> 学习目标：${objective || '理解本课的核心内容'}`,
    '',
    '## 1. 先建立一个直觉',
    `把「${lesson}」想象成一张地图：先看清地形，再决定走哪条路。不追求一次记住所有细节，而是先抓住主干。`,
    '',
    '## 2. 关键概念',
    '- **主干概念**：本课最核心的一句话结论。',
    '- **支撑概念**：解释主干为什么成立的两三个要点。',
    '- **边界条件**：什么情况下这套方法不适用。',
    '',
    '## 3. 一个具体例子',
    '假设你遇到一个陌生问题：先判断它是否属于本课覆盖的类型；若属于，套用步骤；若不属于，记录为待解决问题，进入下一轮学习。',
    '',
    '## 4. 常见误区',
    '1. 把术语背下来就以为自己理解了——真正的标准是能举例和反例。',
    '2. 跳过边界条件直接套用方法——这会在迁移时失效。',
    '',
    '## 5. 自检问题',
    '- 你能用一句话说明本课在解决什么问题吗？',
    '- 你能举出一个本课方法不适用的例子吗？',
  ].join('\n')
}

function mockQuiz(lesson: string, count: number): unknown {
  const total = Math.min(Math.max(count, 1), 8)
  const questions: unknown[] = []
  for (let index = 0; index < total; index += 1) {
    questions.push({
      type: index % 3 === 2 ? 'short_answer' : 'single_choice',
      stem: `【${lesson}】第 ${index + 1} 题：以下哪一项最准确地描述了本课的核心方法？`,
      options: index % 3 === 2
        ? null
        : [
            '先背术语，再谈应用',
            '先建立整体框架，再逐步深入细节',
            '只记住结论，不必理解过程',
            '完全依赖直觉，不需要步骤',
          ],
      answer: index % 3 === 2
        ? '先建立整体框架，再逐步深入细节，并在迁移中检验理解。'
        : '先建立整体框架，再逐步深入细节',
      explanation: '本课强调从主干到细节的认知顺序，并用迁移检验理解程度。',
      difficulty: index === 0 ? 'easy' : index === total - 1 ? 'hard' : 'medium',
    })
  }
  return { questions }
}

function mockGrade(reference: string, learner: string): unknown {
  const normalizedReference = reference.trim()
  const normalizedLearner = learner.trim()
  const hit = normalizedLearner.length > 0
    && normalizedReference.length > 0
    && (normalizedLearner.includes(normalizedReference.slice(0, 6)) || normalizedReference.includes(normalizedLearner.slice(0, 6)))
  const score = normalizedLearner.length === 0 ? 0 : hit ? 100 : 55
  return {
    correct: score >= 60,
    score,
    feedback: normalizedLearner.length === 0
      ? '未作答。建议先复述本课的主干结论，再尝试作答。'
      : hit
        ? '回答抓住了参考答案的关键表述，可进入下一题。'
        : '回答方向接近但缺少关键表述，建议回看本课的「关键概念」小节后重答。',
  }
}

function mockRubric(topic: string): unknown {
  return {
    criteria: [
      {
        id: 'concept',
        name: '概念理解',
        weight: 0.4,
        descriptor: `能准确说明「${topic}」的核心概念与边界`,
        levels: [
          { level: '优秀', score: 4, descriptor: '能给出定义、举例与反例' },
          { level: '良好', score: 3, descriptor: '能给出定义并举例' },
          { level: '合格', score: 2, descriptor: '能复述定义但举例困难' },
          { level: '待提升', score: 1, descriptor: '定义表述含糊' },
        ],
      },
      {
        id: 'application',
        name: '方法应用',
        weight: 0.4,
        descriptor: '能在新情境中套用本课方法并说明理由',
        levels: [
          { level: '优秀', score: 4, descriptor: '步骤完整且能说明适用条件' },
          { level: '良好', score: 3, descriptor: '步骤完整' },
          { level: '合格', score: 2, descriptor: '步骤有遗漏' },
          { level: '待提升', score: 1, descriptor: '无法定位适用方法' },
        ],
      },
      {
        id: 'reflection',
        name: '反思与迁移',
        weight: 0.2,
        descriptor: '能识别自身误区并提出改进动作',
        levels: [
          { level: '优秀', score: 4, descriptor: '主动指出误区并给出改进计划' },
          { level: '良好', score: 3, descriptor: '能指出误区' },
          { level: '合格', score: 2, descriptor: '在提示下能指出误区' },
          { level: '待提升', score: 1, descriptor: '未形成反思' },
        ],
      },
    ],
  }
}

function mockJudge(prompt: string): unknown {
  // 从提示词里抽取各维度 id 与权重行。
  const criteria: Array<{ id: string; line: string; weight: number }> = []
  for (const match of prompt.matchAll(/^(\d+)\. (.+?)（id=([a-z_]+)，权重(\d+)%）：(.+)$/gm)) {
    criteria.push({
      id: match[3]!,
      line: match[2]!,
      weight: Number.parseInt(match[4]!, 10) / 100,
    })
  }

  // 提取教学产物正文：定位「教学产物内容：」之后的部分。
  const marker = '教学产物内容：'
  const markerIndex = prompt.indexOf(marker)
  const body = (markerIndex === -1 ? prompt : prompt.slice(markerIndex + marker.length)).trim()
  const bodyLength = body.length
  const hasStructureKeywords = markerIndex !== -1 && /关键|\*\*|##|冒号|：/.test(body)
  const baseSignal = hasStructureKeywords ? (bodyLength >= 300 ? 4 : 3) : bodyLength >= 150 ? 3 : 2

  // 依据维度语义给出略有差异的确定性分数。
  const perCriterion = criteria.map((item, index) => {
    let score = baseSignal
    if (item.id === 'accuracy' || item.id === 'validity' || item.id === 'unambiguity') score = Math.max(2, baseSignal - 1)
    if (item.id === 'clarity' || item.id === 'example' || item.id === 'actionability') score = Math.min(5, baseSignal + (index % 2))
    if (item.id === 'tone') score = 4
    return {
      id: item.id,
      score,
      comment: `【mock 判分】基于产物长度与结构特征给出确定性示例分；接入真实模型后将按锚点真实评估${item.line}。`,
    }
  })

  const weighted = criteria.reduce(
    (sum, item, index) => sum + (perCriterion[index]?.score ?? 1) * item.weight,
    0,
  )
  const totalScore = Math.round((weighted / 5) * 100)
  return {
    totalScore,
    perCriterion,
    review: '【mock 判分】当前为确定性示例评测，非真实内容评估；配置凭据接入真实模型后可获得有效指标。',
    suggestions: [
      '接入真实模型后重跑评测，获取可迭代的有效指标。',
      '对落后维度对应的提示词做针对性优化后复测对比。',
    ],
  }
}

function mockEvaluate(prompt: string): unknown {
  const answered = Number.parseInt(pick(prompt, '已作答题目数'), 10) || 0
  const correct = Number.parseInt(pick(prompt, '作答正确数'), 10) || 0
  const accuracy = answered === 0 ? 0 : Math.round((correct / answered) * 100)
  const level = accuracy >= 85 ? '优秀' : accuracy >= 70 ? '良好' : accuracy >= 50 ? '合格' : '待提升'
  return {
    totalScore: accuracy,
    level,
    perCriterion: [
      {
        id: 'concept',
        score: Math.max(1, Math.min(4, Math.round(accuracy / 25))),
        comment: `基于 ${answered} 次作答的正确率 ${accuracy}%，概念理解${accuracy >= 70 ? '较扎实' : '仍需巩固'}。`,
      },
      {
        id: 'application',
        score: Math.max(1, Math.min(4, Math.round(accuracy / 28))),
        comment: '应用能力由测验正确率间接推断，建议补充一道迁移题以更准确评估。',
      },
      {
        id: 'reflection',
        score: Math.max(1, Math.min(4, Math.round(accuracy / 30))),
        comment: '反思维度目前缺少直接证据，建议在复习环节记录一次错因复盘。',
      },
    ],
    suggestions: accuracy >= 70
      ? ['保持当前节奏，把复习间隔逐步拉长到 6 天、15 天。', '尝试用本课方法解释一个课程外的例子。']
      : ['优先重做错题，并回看对应小节的「关键概念」。', '把复习间隔压缩到 1 天，先巩固再扩展。'],
  }
}