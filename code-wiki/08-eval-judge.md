# 08 · 评测中心（LLM Judge）

评测中心是本项目相较普通教学 Demo 的差异化能力：它用**另一个 LLM 调用**对系统自身
产生的教学产物打分，驱动提示词与内容迭代。位于 `server/src/eval/`，仅**开发模式**开放。

| 文件 | 职责 |
| --- | --- |
| [metrics.ts](file:///workspace/edu-loop-mvp/server/src/eval/metrics.ts) | 评测维度定义与等级口径 |
| [judge.ts](file:///workspace/edu-loop-mvp/server/src/eval/judge.ts) | 判分提示词组装、结果归一化、评测落库 |
| [routes/eval.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/eval.ts) | HTTP 入口与产物收集 |

## 1. 指标定义（`metrics.ts`）

### 四类评测对象

```ts
export type EvalTarget = 'outline' | 'explain' | 'quiz' | 'grade'
export const EVAL_TARGETS: EvalTarget[] = ['outline', 'explain', 'quiz', 'grade']
export const EVAL_TARGET_LABELS = { outline: '课程大纲', explain: '结构化讲解', quiz: '测验题目', grade: '判分反馈' }
```

### 维度与锚点

每个维度含 `weight`（权重和 = 1）、`anchor5`（5 分描述）、`anchor1`（1 分描述），
维度打分为 **1-5 分**，按权重加权后映射到 **0-100**：

```ts
export interface JudgeCriterion { id: string; name: string; weight: number; anchor5: string; anchor1: string }
```

| 对象 | 维度（权重） |
| --- | --- |
| **outline** 课程大纲 | 内容准确性 0.3 / 目标-课次连贯性 0.25 / 可操作性 0.25 / 关键概念覆盖 0.2 |
| **explain** 结构化讲解 | 内容准确性 0.3 / 直观易懂 0.3 / 结构完整 0.2 / 例子质量 0.2 |
| **quiz** 测验题目 | 与目标一致 0.25 / 题干无歧义 0.25 / 难度合理 0.25 / 解析质量 0.25 |
| **grade** 判分反馈 | 判分准确 0.4 / 反馈可执行 0.4 / 语气建设性 0.2 |

> **锚点设计意图**：给出 1 分与 5 分的明确描述，抑制「光环效应」，让不同产物、不同时间的
> 打分更可比——这正是评测中心作为「迭代工具」的价值所在。

### 等级口径

```ts
export function levelForScore(total: number): string {
  if (total >= 85) return '优秀'
  if (total >= 70) return '良好'
  if (total >= 50) return '合格'
  return '待提升'
}
```

（与量规评估的等级口径一致。）

## 2. 判分流程（`judge.ts`）

### 运行流程

1. 从仓库收集某一类型的产物（如某道题、某篇讲解）；
2. 组装判分提示词，要求 Judge 按维度给 1-5 分与评语；
3. 归一化结果，按权重加权得到 0-100 总分与等级；
4. 落库为一条 `eval_runs`，供指标聚合与迭代对比。

### `JUDGE_SYSTEM`

明确「**评估教学系统生成的教学产物质量，而不是评估学习者**」，并要求严格依据锚点、
避免光环效应、只输出 JSON。

### `runJudge(context, { target, artifact, taskLabel? })`

- 用 `metricsFor(target)` 取维度；
- `judgePrompt(artifact, criteria)` 组装提示词（`[[task:eval_judge]]` 标记 + 维度锚点列表 +
  产物内容截断 6000 字；产物为空时提示如实打分）；
- 调 `runLlm`（task 默认 `eval_${target}`）；有 `errorCode` 则抛错；
- `normalizeJudgeResult(extractJson(text), criteria, fallbackReview)`。

### `normalizeJudgeResult(raw, criteria, fallbackReview)`

- 按 `id` 收集各维度得分（限制 1-5）与评语，**以 `criteria` 为准对齐**（缺失维度补 1 分）；
- 加权总分：`round((Σ score×weight) / 5 × 100)`；若模型给了合法 `totalScore` 则优先采用；
- `level = levelForScore(finalTotal)`；`review` 缺失用 `fallbackReview`；`suggestions` 上限 6。

### `persistEvalRun(repo, input) → EvalRun`

组装 `EvalRun`（`newId('evalrun')`，`targetType = target`，`detail = result`）并 `insertEvalRun`。

## 3. 产物收集（`routes/eval.ts` 的 `collectCandidates`）

`target` 决定从仓库取什么、以及 `all` 的含义：

| target | 数据来源 | `all=false` | `targetId` |
| --- | --- | --- | --- |
| `outline` | 课程 + 全部课次拼成的 Markdown 大纲 | 恒为 1 份 | `course.id` |
| `explain` | `lessons` 的 `explanation` | 仅第 1 课 | `lesson.id` |
| `quiz` | `questions`（题型/题干/选项/答案/解析） | 仅第 1 题 | `question.id` |
| `grade` | `attempts`（作答 + 判分反馈 + 实际对错） | 仅第 1 条 | `attempt.id` |

`runEvaluations()` 逐个候选调 `runJudge` 并 `persistEvalRun`，`provider/model/degraded` 优先取
候选自身，否则回落到当前路由。判分温度为 **0.2**（偏低，追求一致性）。

## 4. HTTP 接口

### `GET /api/eval/courses/:courseId`

返回：

```ts
{
  targets: [{ target, label, criteria }],   // 维度与锚点，供前端展示说明
  latest: { [targetType]: EvalRun },        // 每类最近一次（repo.latestEvalPerType）
  runs: EvalRun[]                            // 全部运行（上限 100）
}
```

### `POST /api/eval/courses/:courseId/run`

body `{ target, all?, provider?, model? }`：

- `target` 必须 ∈ `EVAL_TARGETS`，否则 400；
- `all=true` 评测全部产物并逐个落库；否则仅评测最新一份；
- 返回 `{ runs: EvalRun[] }`。

> **模式隔离**：`app.ts` 只在 development 挂载本路由；production 下 `/api/eval` 一律返回 403，
> 前端 `system` store 也据此隐藏入口并拦截路由。前后端**两端一致**。

## 5. 数据落点

评测结果写入 `eval_runs` 表（见 [04-data-layer.md](./04-data-layer.md)）：

- `target_type` / `target_id` 定位产物；
- `judge_provider` / `judge_model` / `degraded` 记录判分所用的模型与是否降级；
- `total_score` / `level` / `detail`（完整 `JudgeResult` 的 JSON）。

> **降级提示**：当 evaluator 走 mock 适配器时，`mockJudge` 会返回带「【mock 判分】」前缀的
> 评语并明确说明这是确定性示例评测，提醒用户接入真实模型后重跑。

下一篇：[09-frontend.md](./09-frontend.md)。