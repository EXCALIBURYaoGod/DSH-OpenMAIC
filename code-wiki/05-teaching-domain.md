# 05 · 教学领域模块

`server/src/teaching/` 承载五步闭环的领域逻辑，是路由层与 LLM/数据层之间的中间层。

| 文件 | 职责 |
| --- | --- |
| [prompts.ts](file:///workspace/edu-loop-mvp/server/src/teaching/prompts.ts) | 全部提示词 + 系统提示词 |
| [llm.ts](file:///workspace/edu-loop-mvp/server/src/teaching/llm.ts) | `runLlm` / `runLlmJson`：下发提示词、转发分片、落调用日志 |
| [json.ts](file:///workspace/edu-loop-mvp/server/src/teaching/json.ts) | `extractJson`：从模型输出中稳健提取 JSON |
| [normalize.ts](file:///workspace/edu-loop-mvp/server/src/teaching/normalize.ts) | 把模型 JSON 归一化为内部稳定结构 |
| [srs.ts](file:///workspace/edu-loop-mvp/server/src/teaching/srs.ts) | 简化 SM-2 间隔重复调度 |

## 1. 提示词（`prompts.ts`）

### 1.1 `[[task:xxx]]` 标记约定

**每个提示词首行都带一个 `[[task:xxx]]` 机器标记**。真实模型会忽略它，而 MockAdapter
据此返回确定性内容——这是「有 Key / 无 Key 两条路径共用同一套教学流程代码」的关键设计。

### 1.2 `TEACHER_SYSTEM`

系统提示词，要求：先建立整体框架再展开细节、输出可直接用于学习、要求 JSON 时只输出 JSON。

### 1.3 六个提示词构造函数

| 函数 | task 标记 | 用途 |
| --- | --- | --- |
| `courseOutlinePrompt(topic, material)` | `course_outline` | 生成 3-5 课微课程 JSON（title/summary/objectives/lessons），资料截断到 4000 字 |
| `lessonExplainPrompt({courseTitle, lessonTitle, objective, keyPoints})` | `lesson_explain` | 生成 Markdown 讲解（直觉引入/关键概念/例子/误区/自检），限 600 字 |
| `quizGeneratePrompt({...count})` | `quiz_generate` | 出题 JSON（type/stem/options/answer/explanation/difficulty） |
| `quizGradePrompt({stem, reference, answer})` | `quiz_grade` | 判分 JSON（correct/score/feedback），含 5 步判分流程 |
| `rubricGeneratePrompt(courseTitle, objectives)` | `rubric_generate` | 生成 3-4 维度量规 JSON，要求 weight 之和为 1 |
| `rubricEvaluatePrompt({...})` | `rubric_evaluate` | 依据学习证据（作答数/正确率/错题）评估 JSON |

判分提示词值得注意：它把**部分分**逻辑显式写进步骤（拆要点 → 逐要点核对 → 按命中比例给分
→ 命中多数算对 → 反馈要给出可立即执行的改进动作），以提升判分质量。

## 2. LLM 调用层（`llm.ts`）

### `LlmTaskContext`

```ts
export interface LlmTaskContext {
  runtime: LlmRuntime
  repo: Repository
  provider: string
  model: string
  degraded: boolean
  temperature?: number
}
```

### `runLlm(context, input) → RunLlmResult`

一次 LLM 调用的统一入口，职责：

1. 组装 `GenerateOptions`（`messages: [{ role:'user', content: prompt }]` + 可选 `system`/`temperature`/`signal`）；
2. 用 `async function*` **包装流**：每遇 `text-delta` 就累加并回调 `input.onDelta`（供 SSE 转发）；
3. `assembleStream()` 装配完整结果；
4. **落库一条 `llm_call_logs`**：记录 provider/model/degraded/task、promptChars、outputChars、
   inputTokens/outputTokens、latencyMs、status（`ok`/`error`）、errorCode；
5. 返回 `{ text, reasoning, usage?, finish, errorCode?, errorMessage? }`。

```ts
export interface RunLlmInput  { task: string; system?: string; prompt: string; onDelta?: (t: string) => void; signal?: AbortSignal }
export interface RunLlmResult { text: string; reasoning: string; usage?: TokenUsage; finish: FinishReason; errorCode?: string; errorMessage?: string }
```

### `runLlmJson<T>(context, input, parse)`

在 `runLlm` 基础上要求返回 JSON：`errorCode` 非空则抛「LLM 调用失败（code）：message」，
否则用传入的 `parse` 解析 `result.text`，返回 `{ value, result }`。

> 设计要点：`runLlm` 把「流式转发」与「审计落库」这两件横切关注点收拢在此，
> 路由层只需关心业务语义。

## 3. JSON 提取（`json.ts`）

真实模型常在 JSON 前后附带说明文字或 ```json 代码围栏，因此 `extractJson` 做**三档尝试**：

1. 直接 `JSON.parse(trimmed)`；
2. 用正则剥离 ```json 代码围栏后再 parse；
3. `sliceBalancedObject`：取**第一个 `{` 到与之配平的 `}`**，扫描时跟踪字符串状态与转义，
   忽略字符串内部的花括号。

全部失败时抛错，错误信息附带输出前 200 字符。

## 4. 结果归一化（`normalize.ts`）

模型（尤其不同 provider）字段常缺失或类型漂移，本模块把外部输入收敛为内部稳定结构，
**避免脏数据落库**。全部函数遵循「逐字段断言 + 兜底默认值 + 数量上限」的策略。

| 函数 | 输出类型 | 关键处理 |
| --- | --- | --- |
| `normalizeOutline(raw, fallbackTopic)` | `CourseOutline` | lessons 上限 8；为空时补一课；title/summary 兜底含主题 |
| `normalizeQuestions(raw, limit)` | `GeneratedQuestion[]` | 兼容 `{questions:[...]}` 与裸数组；无 options 自动降为 `short_answer`；difficulty 限 easy/medium/hard |
| `normalizeGrade(raw)` | `GradeResult` | score 限 0-100；`correct` 缺失时按 `score>=60` 推断 |
| `normalizeRubricCriteria(raw)` | `RubricCriterion[]` | 维度上限 6、等级上限 5；**权重归一化到和为 1** |
| `normalizeEvaluation(raw, criteria)` | `EvaluateResult` | totalScore 限 0-100；perCriterion 缺失时按量规维度补 1 分占位；suggestions 上限 6 |

工具函数：`asString(value, fallback)`、`asStringArray(value, limit)`。

## 5. 间隔重复调度（`srs.ts`）——简化 SM-2

报告指出「复习 + 评估」是教学闭环常被忽略的空白，本模块用最简单的可运行实现补上。

```ts
export interface SrsState  { ease: number; intervalDays: number; repetitions: number }
export interface SrsResult extends SrsState { dueAt: string }

export const MIN_GRADE = 0, MAX_GRADE = 5
export const MS_PER_DAY = 24 * 60 * 60 * 1000
```

### `schedule(state, grade, now = new Date())`

```ts
export function schedule(state: SrsState, grade: number, now: Date = new Date()): SrsResult {
  const clamped = Math.max(MIN_GRADE, Math.min(MAX_GRADE, Math.round(grade)))
  const nextEase = clampEase(state.ease + (0.1 - (5 - clamped) * (0.08 + (5 - clamped) * 0.02)))
  const repetitions = clamped < 3 ? 0 : state.repetitions + 1
  const intervalDays = clamped < 3
    ? 1
    : repetitions === 1 ? 1
    : repetitions === 2 ? 6
    : Math.max(1, Math.round(state.intervalDays * nextEase))
  return { ease: nextEase, intervalDays, repetitions, dueAt: new Date(now.getTime() + intervalDays * MS_PER_DAY).toISOString() }
}
```

规则：

- **回忆质量 0-5**（0=完全想不起来，5=脱口而出）；
- `ease` 按 SM-2 标准公式更新，并 `clampEase` 限制在 **1.3 ~ 2.8**（保留两位小数）；
- **答错（grade < 3）→ repetitions 归零、间隔压回 1 天**；
- 首次重复 1 天、第二次 6 天、之后按 `上次间隔 × ease` 递增。

### 辅助函数

- `initialReview(now)`：新题初始状态 `{ ease: 2.5, intervalDays: 0, repetitions: 0, dueAt: now }`（立刻到期）；
- `gradeFromCorrect(correct)`：答对 = 4（良好），答错 = 2（不合格）。

> 调度在**两处**被调用：`quiz.ts` 作答时（用 `gradeFromCorrect`）、`review.ts` 复习时
> （用学习者选的 0-5 档位）。

## 6. 模块协作全景

```
路由层
  │  resolveRoute / taskContext
  ▼
teaching/llm.ts ──runLlm──► llm/registry.ts ──► adapter
  │  ◄── text (流式 + 完整)
  ├─ teaching/json.ts   extractJson()       「从模型输出稳健取 JSON」
  ├─ teaching/normalize.ts normalizeXxx()   「收敛为内部结构」
  └─ teaching/srs.ts    schedule()          「复习调度」
  ▼
db/repo.ts（落库）+ SSE 事件回传前端
```

下一篇：[06-http-api.md](./06-http-api.md)。