# 06 · HTTP 接口与 SSE 协议

本篇覆盖 `server/src/http/`：SSE 通道封装、七个路由模块的全部端点，以及前端消费的事件序列。

| 文件 | 职责 |
| --- | --- |
| [sse.ts](file:///workspace/edu-loop-mvp/server/src/http/sse.ts) | `openSse` 通道 + `sendError` 统一错误响应 |
| [plugin.ts](file:///workspace/edu-loop-mvp/server/src/http/plugin.ts) | 从 Cordis 服务装配 Express（见 02 篇） |
| [routes/course.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/course.ts) | 步骤 1、2：课程大纲与讲解 |
| [routes/quiz.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/quiz.ts) | 步骤 3：出题 / 作答判分 |
| [routes/review.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/review.ts) | 步骤 4：间隔重复 |
| [routes/rubric.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/rubric.ts) | 步骤 5：量规生成与评估 |
| [routes/eval.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/eval.ts) | 评测中心（仅开发模式） |
| [routes/llm.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/llm.ts) | provider 目录与调用日志 |
| [routes/slide.ts](file:///workspace/edu-loop-mvp/server/src/http/routes/slide.ts) | 幻灯片 JSON 生成 |

## 1. SSE 通道（`sse.ts`）

### 为什么用 SSE 而不是 WebSocket

教学流程是「一问一答的流式文本」，**单向推送足够**；SSE 在浏览器侧只需
`fetch + ReadableStream`，无额外依赖。

### `openSse(res) → SseChannel`

```ts
export interface SseChannel {
  send(event: string, data: unknown): void
  close(): void
  readonly closed: boolean
}
```

响应头设置：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、
`Connection: keep-alive`、`X-Accel-Buffering: no`（禁用 Nginx 缓冲），并 `flushHeaders()`。

帧格式为标准的 `event: <name>\ndata: <json>\n\n`。

> **一个关键坑位注释**：不能用 `req.on('close')` 判断客户端断开——请求体被 `express.json`
> 读完后 `req` 会立刻触发 `'close'`，会把通道误判为已关闭、导致响应永不结束。
> 因此**只监听 `res` 的 `'close'`**（连接真正关闭才触发）。

### `sendError(res, status, message, code?)`

统一错误响应体：`{ error: { message, code? } }`。

## 2. 端点总览

| 方法 | 路径 | 说明 | 流式 |
| --- | --- | --- | --- |
| GET | `/api/health` | 运行模式 + provider 目录 + 时间 | - |
| GET | `/api/plugins` | 插件/服务诊断拓扑 | - |
| GET | `/api/llm/providers` | provider 与模型目录（含 `degraded`） | - |
| GET | `/api/llm/calls?limit=` | LLM 调用审计日志（1-200，默认 50） | - |
| GET | `/api/courses` | 课程列表 | - |
| GET | `/api/courses/:id` | 课程详情（含 lessons/stats/questionCount） | - |
| POST | `/api/courses` | **步骤 1**：生成结构化课程 | ✔ SSE |
| POST | `/api/courses/:id/lessons/:lessonId/explain` | **步骤 2**：生成讲解 | ✔ SSE |
| GET | `/api/quiz/courses/:courseId/questions` | 题目 + 作答 + 统计 | - |
| POST | `/api/quiz/courses/:courseId/generate` | **步骤 3a**：出题 | - |
| POST | `/api/quiz/questions/:questionId/attempt` | **步骤 3b**：作答判分 | - |
| GET | `/api/review/courses/:courseId/due` | 今日到期复习项 | - |
| GET | `/api/review/courses/:courseId/all` | 全部复习调度 | - |
| POST | `/api/review/questions/:questionId/review` | **步骤 4**：提交 0-5 复习评分 | - |
| POST | `/api/review/questions/:questionId/review-binary` | 便捷入口：按对/错复习 | - |
| GET | `/api/rubric/courses/:courseId` | 最新量规 + 最新评估 | - |
| POST | `/api/rubric/courses/:courseId/generate` | **步骤 5a**：生成量规 | - |
| POST | `/api/rubric/courses/:courseId/evaluate` | **步骤 5b**：依据证据评估 | - |
| GET | `/api/eval/courses/:courseId` | 评测元信息 + 最近评测 + 全部运行 | - |
| POST | `/api/eval/courses/:courseId/run` | 运行 LLM Judge | - |
| POST | `/api/slides/courses/:courseId/lessons/:lessonId/slides` | 课次要点 → SlideDeck | - |

未命中的 `/api/*` 返回 `404 { error: { message: '接口不存在' } }`。

## 3. 课程与讲解（`routes/course.ts`）

### `POST /api/courses` — 步骤 1（SSE）

事件序列：**`meta` → `delta`\* → `outline` | `error`**

1. 校验 `topic` 非空（否则 400）；`material` 空白视为 `null`；
2. `resolveRoute(context, body.provider, body.model)` 解析路由（失败 400）；
3. `openSse(res)` 开通道，先发 `meta { courseId, provider, model, degraded }`；
4. `runLlm(ctx, { task:'course_outline', system: TEACHER_SYSTEM, prompt: courseOutlinePrompt(...), onDelta })`
   —— 每个文本增量转发为 `delta { text }`；
5. 若有 `errorCode` → `error { code, message }` 并关闭；
6. `normalizeOutline(extractJson(result.text), topic)` → 组装 `Course` 与 `Lesson[]`（`newId` 生成 id）
   → `repo.insertCourse` + `repo.insertLessons` → 发 `outline { course, lessons, usage }`。

### `POST /api/courses/:id/lessons/:lessonId/explain` — 步骤 2（SSE）

事件序列：**`meta` → `delta`\* → `done` | `error`**

- 校验课程与课次均存在且归属一致；
- 路由缺省**沿用课程自身记录的** `provider`/`model`；
- `lesson_explain` 提示词（system 为 `TEACHER_SYSTEM`，temperature 0.5）；
- 成功后 `repo.setLessonExplanation` → 发 `done { lesson, usage }`。

## 4. 测验（`routes/quiz.ts`）

### `POST /api/quiz/courses/:courseId/generate` — 步骤 3a

- `count` 限制在 1-8（默认 3）；
- 传 `lessonId` 则针对该课次，否则覆盖整门课程（objective 取课程目标或 summary）；
- `quiz_generate` 提示词 → `normalizeQuestions` → 落 `questions` 表；
- **新题立即进入复习队列**：为每题 `upsertReview` 初始状态（`due_at = now`），保证闭环能马上走完；
- 返回 `{ questions, degraded, usage }`。

### `POST /api/quiz/questions/:questionId/attempt` — 步骤 3b

1. `quiz_grade` 提示词（temperature 0）判分；`normalizeGrade` 归一化；
2. **判分失败自动降级**：`catch` 中改用本地 `heuristicGrade`（见下），并把
   `gradedBy` 标为 `'heuristic'`（LLM 成功时为 `'llm'`）；
3. 落 `attempts`；
4. 读上一状态 → `schedule(state, gradeFromCorrect(correct))` → `upsertReview`；
5. 返回 `{ attempt, review, stats }`。

**`heuristicGrade(reference, answer)`**（无 LLM 时的确定性判据）：

- 归一化（去空白 + 小写）后：完全一致 / 互相包含 → `correct, 90`；
- 否则算**最长公共子串长度 / 参考答案长度**作为重合度，≥ 0.6 → `correct, 75`，否则 `correct=false, score=round(重合度×100)`；
- 空作答 → `correct=false, score=0`。

（`longestCommonSubstringLength` 用滚动数组 DP 实现。）

## 5. 间隔重复（`routes/review.ts`）

- `GET .../due`：`listDueReviews(courseId, now)`，逐条附带题目对象，返回 `{ due: [{ review, question }] }`；
- `GET .../all`：返回全部 `reviews`（供前端排期展示）；
- `POST /api/review/questions/:id/review`：`grade` 限制 0-5（默认 2）→ 读上一状态 →
  `schedule(state, grade)` → `upsertReview` → 返回 `{ review, remainingDue }`；
- `POST .../review-binary`：把 `correct`（兼容 `true/1/'1'/'true'`）折算为 `gradeFromCorrect`，
  其余同上——给「只想知道对错」的调用方用。

## 6. 量规与评估（`routes/rubric.ts`）

- `GET /courses/:courseId`：返回 `{ rubric, evaluation }`（各取最新一份）；
- `POST .../generate`（temperature 0.4）：`rubric_generate` → `normalizeRubricCriteria`
  （权重归一化到 1）→ 落 `rubrics`；
- `POST .../evaluate`（temperature 0.3）：**要求已存在量规**（否则 400「请先生成量规」）；
  收集 `attemptStats` 与最近 5 条错题（截断 120 字）→ `rubric_evaluate` → `normalizeEvaluation`
  → `insertRubricEvaluation`；返回 `{ evaluation, stats, usage }`。

## 7. 评测中心（`routes/eval.ts`）

- 仅开发模式挂载（生产模式由 `app.ts` 拦截为 403）；
- `GET /courses/:courseId`：返回 `{ targets, latest, runs }`，`targets` 由 `EVAL_TARGETS`
  与 `metricsFor(target).criteria` 组装；
- `POST .../run`：body `{ target, all?, provider?, model? }`，`target` 必须 ∈ outline/explain/quiz/grade；
  `all=false` 只评测最新一份产物，`all=true` 评测全部并逐个落库。详见 [08-eval-judge.md](./08-eval-judge.md)。

## 8. LLM 路由（`routes/llm.ts`）

- `GET /providers`：并发读取每个 provider 的模型目录，返回
  `{ defaultProvider, defaultModel, providers: [{ id, name, degraded, models }] }`——前端
  顶部选择器与「本地降级 / 真实模型」标签的数据源；
- `GET /calls`：`limit` 限制 1-200，返回 LLM 调用审计日志。

## 9. 幻灯片（`routes/slide.ts`）

`POST /api/slides/courses/:courseId/lessons/:lessonId/slides`：

- **`context.slide === undefined` → 501**（服务未装配），让前端隐藏预览而不阻断讲解主流程；
- 以「首页 = 主题标题页 + 每个要点一页」构造 `SlideInput`；
- `context.slide.generateSlideJson(input)` 生成 deck，返回 `{ deck, available, source, dslVersion }`；
- **纯同步、零 LLM 调用**，因此每次实时生成、不落库（避免过期快照）。

## 10. 前端消费的事件协议

前端用 `postSse`（见 [09-frontend.md](./09-frontend.md)）按事件名分发：

| 事件 | 载荷 | 出现场景 |
| --- | --- | --- |
| `meta` | `{ courseId?, lessonId?, provider, model, degraded }` | 流开始 |
| `delta` | `{ text }` | 每个文本增量 |
| `outline` | `{ course, lessons, usage }` | 步骤 1 成功 |
| `done` | `{ lesson, usage }` | 步骤 2 成功 |
| `error` | `{ code, message }` | 任一失败 |

下一篇：[07-openmaic-plugins.md](./07-openmaic-plugins.md)。