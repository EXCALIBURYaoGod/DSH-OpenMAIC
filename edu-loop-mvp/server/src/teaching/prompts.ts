/**
 * 教学提示词。
 *
 * 每个提示词都带一个 `[[task:xxx]]` 机器标记：真实模型会忽略它，
 * 而本地 mock 适配器据此返回确定性的结构化内容。这样「有 Key / 无 Key」
 * 两条路径共用同一套教学流程代码。
 *
 * @module teaching/prompts
 */

export const TEACHER_SYSTEM = [
  '你是一位严谨、循循善诱的学科教师，同时熟悉教学设计。',
  '要求：',
  '1. 先建立整体框架，再展开细节；不要堆砌术语。',
  '2. 输出必须可直接用于学习，而不是泛泛而谈。',
  '3. 当要求输出 JSON 时，只输出 JSON，不要包裹解释文字。',
].join('\n')

export function courseOutlinePrompt(topic: string, material: string | null): string {
  const lines = [
    '[[task:course_outline]]',
    `主题：${topic}`,
  ]
  if (material !== null && material.trim().length > 0) {
    lines.push('参考资料：', material.trim().slice(0, 4000))
  }
  lines.push(
    '',
    '请设计一门 3-5 课的微型课程，并**只输出**如下 JSON：',
    '{',
    '  "title": "课程标题",',
    '  "summary": "一段课程简介",',
    '  "objectives": ["学习目标1", "学习目标2"],',
    '  "lessons": [',
    '    { "title": "课次标题", "objective": "本课目标", "keyPoints": ["要点1", "要点2"] }',
    '  ]',
    '}',
  )
  return lines.join('\n')
}

export function lessonExplainPrompt(input: {
  courseTitle: string
  lessonTitle: string
  objective: string
  keyPoints: string[]
}): string {
  return [
    '[[task:lesson_explain]]',
    `课程：${input.courseTitle}`,
    `课题：${input.lessonTitle}`,
    `学习目标：${input.objective}`,
    `要点：${input.keyPoints.join('、')}`,
    '',
    '请用 Markdown 写一份结构化讲解，包含：直觉引入、关键概念、一个具体例子、常见误区、自检问题。',
    '控制在 600 字以内，避免空话。',
  ].join('\n')
}

export function quizGeneratePrompt(input: {
  courseTitle: string
  lessonTitle: string
  objective: string
  count: number
}): string {
  return [
    '[[task:quiz_generate]]',
    `课程：${input.courseTitle}`,
    `课题：${input.lessonTitle}`,
    `学习目标：${input.objective}`,
    `数量：${input.count}`,
    '',
    '请出题并**只输出**如下 JSON：',
    '{',
    '  "questions": [',
    '    {',
    '      "type": "single_choice | short_answer",',
    '      "stem": "题干",',
    '      "options": ["选项A", "选项B", "选项C", "选项D"] 或 null,',
    '      "answer": "参考答案（选择题给出正确选项原文）",',
    '      "explanation": "解析",',
    '      "difficulty": "easy | medium | hard"',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

export function quizGradePrompt(input: {
  stem: string
  reference: string
  answer: string
}): string {
  return [
    '[[task:quiz_grade]]',
    `题干：${input.stem}`,
    `参考答案：${input.reference}`,
    `学习者作答：${input.answer}`,
    '',
    '请按下面步骤判分，并**只输出**如下 JSON：',
    '{ "correct": bool, "score": 0-100, "feedback": "面向学习者的具体反馈" }',
    '',
    '判分步骤：',
    '1. 把参考答案拆成 2-4 个关键要点；',
    '2. 逐要点核对学习者作答，命中几个给几个的部分分（不必每个要点都命中才能算对）；',
    '3. score 按要点的实际命中比例给分，能反映真实掌握程度；',
    '4. correct：命中多数关键要点则为 true，否则为 false；',
    '5. feedback：一句话点明做到了什么，再指出具体漏掉或写错的关键要点，并给出一个可立即执行的改进动作（如回看哪一小节）。语气客观、非指责。',
  ].join('\n')
}

export function rubricGeneratePrompt(courseTitle: string, objectives: string[]): string {
  return [
    '[[task:rubric_generate]]',
    `主题：${courseTitle}`,
    `学习目标：${objectives.join('；')}`,
    '',
    '请设计一份 3-4 个维度的评分量规，并**只输出**如下 JSON：',
    '{',
    '  "criteria": [',
    '    {',
    '      "id": "英文短标识",',
    '      "name": "维度名称",',
    '      "weight": 0.4,',
    '      "descriptor": "该维度的整体描述",',
    '      "levels": [{ "level": "优秀", "score": 4, "descriptor": "表现描述" }]',
    '    }',
    '  ]',
    '}',
    '要求：weight 之和为 1。',
  ].join('\n')
}

export function rubricEvaluatePrompt(input: {
  courseTitle: string
  criteria: Array<{ id: string; name: string; descriptor: string }>
  attempted: number
  correct: number
  accuracy: number
  recentWrong: string[]
}): string {
  return [
    '[[task:rubric_evaluate]]',
    `主题：${input.courseTitle}`,
    `评分维度：${input.criteria.map(item => `${item.name}（${item.descriptor}）`).join('；')}`,
    `已作答题目数：${input.attempted}`,
    `作答正确数：${input.correct}`,
    `正确率：${input.accuracy}`,
    `最近错题：${input.recentWrong.join(' | ') || '无'}`,
    '',
    '请依据以上学习证据给出评估，并**只输出**如下 JSON：',
    '{',
    '  "totalScore": 0-100,',
    '  "level": "优秀 | 良好 | 合格 | 待提升",',
    '  "perCriterion": [{ "id": "维度id", "score": 1-4, "comment": "评语" }],',
    '  "suggestions": ["下一步建议"]',
    '}',
  ].join('\n')
}