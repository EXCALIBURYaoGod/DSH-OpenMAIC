# 教学闭环 MVP（edu-loop-mvp）技术方案报告

> 版本：v0.1.0 ｜ 定位：可本地运行的最小全栈教学闭环 ｜ 底座来源：DeepSeek Harness（DSH）设计契约 + OpenMAIC 资源契约

---

## 1. 概述

### 1.1 背景

《DSH 与教育及 OpenMAIC 新版本-深度研究报告》指出：现有「DSH × OpenMAIC」教学链路在**闭环后半段**——即**间隔重复复习**与**教学效果评估**——存在明显空白。DSH 侧的教学协议是「薄的」，OpenMAIC 擅长内容生成与渲染，但缺少一条把「学→练→测→复习→评」串起来的可运行骨架。

本方案即针对该缺口落地一个**最小可运行全栈应用**（edu-loop-mvp），把 DSH 的架构契约（Cordis 插件内核 + 配置驱动 LLM loader）与 OpenMAIC 的资源契约（`@openmaic/dsl` 的 `SlideElement` / `Stage` / `Scene`）搬到同一个工程里，验证完整闭环的可行性。

### 1.2 闭环定义

```
主题 / 参考资料
   → ① 结构化课程（大纲 + 课次）        [LLM]
   → ② 逐课结构化讲解（Markdown）       [LLM + SSE 流式]
   → ③ 测验（出题 → 作答 → 判分）        [LLM]
   → ④ 间隔重复复习（简化 SM-2）         [本地算法]
   → ⑤ 评估量规（量规生成 + 依据证据评估） [LLM]
   → ⑥ 评测中心（LLM Judge 反向评估产物）  [LLM，仅开发模式]
```

### 1.3 当前交付状态

| 维度 | 状态 |
| --- | --- |
| 后端闭环 | 五步全部可跑通，接口与落库完整 |
| 前端 | 六页（五步闭环 + 评测中心）全部实现，含 SSE 流式渲染 |
| 无凭据运行 | 支持。未解析到 Key 时自动降级到确定性 mock 适配器，闭环仍完整 |
| 真实模型 | 已接入火山方舟（豆包）与 DeepSeek，默认 provider = `doubao` |
| 运行模式 | dev / production 双模式已分离并验证 |
| 幻灯片 | 已接入 `@openmaic/dsl` 契约，不可解析时降级不阻断闭环 |

---

## 2. 设计目标与约束

| 编号 | 目标 | 落地手段 |
| --- | --- | --- |
| G1 | **无 Key 也能完整跑通闭环** | 确定性 mock 适配器 + `degraded` 标记 |
| G2 | **配置驱动接入任意 OpenAI 兼容端点** | `llm.config.json` provider profile，不改业务代码 |
| G3 | **架构对齐 DSH：内核同源、业务契约裁剪对齐** | 内核直接采用 `@deepseek-ai/cordis`（与 DSH 同源）；LLM 契约按需裁剪复刻 |
| G4 | **闭环状态可持久化、可回放** | SQLite 9 张表，全链路落库 |
| G5 | **开发/生产两模式语义清晰** | `AppMode` 单点解析，跨域/托管/接口门禁统一受控 |
| G6 | **模型输出作为不可信输入处理** | 零依赖 Markdown 白名单渲染 + 长度截断 |

**硬约束**：Node ≥ 22.5（依赖内置 `node:sqlite`）、零原生依赖、`pnpm` workspace。

---

## 3. 总体架构

### 3.1 分层视图

```
┌─────────────────────────────────────────────────────────────┐
│  前端 web/  Vue3 + TS + Vite + Element Plus + Pinia + Router │
│  api/ (fetch + SSE 手工解析)  stores/ (闭环状态)  views/ (六页) │
└───────────────────────────┬─────────────────────────────────┘
                            │  REST(JSON) + SSE(text/event-stream)
┌───────────────────────────▼─────────────────────────────────┐
│  后端 server/  Node + Express                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ http/  路由层：course / quiz / review / rubric / llm   │  │
│  │        / eval / slide   +  sse.ts 输出通道             │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ teaching/  领域层：prompts / llm / json / normalize /  │  │
│  │            srs（SM-2 调度）                            │  │
│  │ eval/      评测层：metrics / judge（LLM Judge）        │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ llm/       LLM 抽象层：types / config / registry /     │  │
│  │            loader / adapters(openai-compat, mock, sse) │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ db/        持久层：sqlite / schema / Repository        │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ 内核：@deepseek-ai/cordis 原生（无本地 core/ 实现）      │  │
│  └───────────────────────────────────────────────────────┘  │
│  plugins/  openmaic-slide / -layout / -storage /            │
│            -generation / -tts-asr（均为 Cordis 原生插件）    │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        │ llm.config.json（provider profile）    │
        │ .env（凭据，仅存变量名引用）            │
        │ server/data/edu-loop.db（SQLite/WAL）  │
        │ ../../OpenMAIC（@openmaic/dsl 源码）    │
        └───────────────────────────────────────┘
```

### 3.2 技术栈选型

| 层 | 选型 | 选型理由 |
| --- | --- | --- |
| 前端框架 | Vue 3 + `<script setup lang="ts">` | 轻量、模板直观，适合演示型六页应用 |
| 构建 | Vite 5 | 冷启动快；dev 代理 `/api` 即可免 CORS 调试 |
| UI | Element Plus | 表单/步骤条/卡片开箱可用，减少自研成本 |
| 状态 | Pinia | 与 Vue3 原生契合；单 store 承载闭环状态 |
| 后端 | Node + Express | SSE 与路由模型简单，无框架黑盒 |
| 内核 | `@deepseek-ai/cordis` + `@deepseek-ai/schemastery` | 直接采用 DSH 同源的 Cordis 原生内核，不再自研；配置经 Standard Schema 校验 |
| 流式 | **SSE**（非 WebSocket） | 教学场景是「一问一答的流式文本」，单向推送足够；浏览器侧仅需 `fetch` + `ReadableStream`，无额外依赖 |
| 存储 | `node:sqlite`（内置） | **零原生依赖、免编译**，规避 better-sqlite3 的 node-gyp 风险 |
| 包管理 | pnpm workspace | 前后端同仓分治 |

**关键取舍**：流式接口使用 **POST + fetch** 而非浏览器原生 `EventSource`。原因是 `EventSource` 只支持 GET，而生成类请求需要携带 `topic` / `material` / `provider` / `model` 等请求体。前端因此在 `web/src/api/client.ts` 手写 SSE 帧解析。

---

## 4. 内核与插件化装配机制

内核**不再自研**，而是直接采用与 DSH 同源的 **Cordis**（`@deepseek-ai/cordis`），配置校验使用同源的 `@deepseek-ai/schemastery`。此前那份「仿 Cordis」的裁剪实现（`server/src/core/`：context / plugin / kernel / errors，约 300 行）已在本次改造中整体删除，改由 Cordis 原生承担。

### 4.1 插件形态：模块即插件（DSH 范式）

每个插件是一个 ES 模块，用**命名导出**声明元数据，**不写 `default export`**。于是 `import * as xPlugin from './x/plugin.js'` 得到的模块命名空间本身就是一个合法插件对象（Cordis 判定「有 `apply` 方法的对象」即为插件），直接交给 `root.plugin()` 装载。

```ts
// 以 server/src/llm/plugin.ts 为例
export const name = 'edu-loop:llm'            // 展示名 / fiber 诊断名
export const provide = 'llm'                  // 提供的服务名
export const Config = z.object({ /* ... */ }) // schemastery（Standard Schema）校验器
export function apply(ctx: Context, config: Config): () => void {
  const loaded = loadLlm(config)
  ctx.provide('llm', loaded)                  // 注册服务，返回 disposer
  return () => { /* 释放引用；服务本体由 fiber 回收 */ }
}
```

元数据字段与 Cordis 的 `Plugin.Base` 一一对应：`name`（诊断名）、`Config`（Standard Schema 校验器）、`inject`（依赖服务）、`provide`（所提供服务的声明）。`apply` 的返回值是可选 disposer，用于释放**非服务类**资源（如 SQLite 连接、适配器引用）。

### 4.2 上下文（服务容器 + 反射层 + 事件总线）

`Context` 是一个 **Proxy**，属性读取经 `ctx.reflect`（`ReflectService`）解析。项目实际用到的能力：

| 能力 | 签名 | 说明 |
| --- | --- | --- |
| 注册服务 | `ctx.provide(name, value)` | 归属当前 fiber；重名抛错；返回 disposer |
| 读取服务 | `ctx.get(name, strict?)` | `strict` 默认 `true`，只返回「提供方 fiber 仍活跃」的实现 |
| 覆写服务值 | `ctx.set(name, value)` | 仅允许提供该服务的 fiber 覆写 |
| 声明依赖 | `inject` 元数据 | 依赖未满足时插件不加载，满足后自动加载 |
| 事件总线 | `ctx.on` / `ctx.emit` | 由 `ctx.events` 经 mixin 暴露到 `ctx` 上 |

每个插件还会按需做 **Context 类型增强**，把服务挂到 `Context` 接口上。例如 llm 插件：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { llm: LoadedLlm }
}
```

由此 `ctx.get('llm')` 与 `ctx.llm` 都获得静态类型——等价于旧实现里手写的服务契约，但不需维护运行时字符串表。

### 4.3 装配语义：依赖驱动的响应式加载

与旧实现「一次性校验 + 失败回滚」不同，Cordis 的装配是**响应式**的：

- `root.plugin(plugin, config)` 返回 `Fiber & PromiseLike<Fiber>`；`await` 之后表示装载完成（配置错误或启动错误会 reject）。
- 插件声明 `inject` 时，**只有全部依赖服务可用才会加载**；当某个依赖服务发生变化（重新注册 / 注销），依赖它的 fiber 会自动卸载并按需重新 `apply`。
- 配置在 `apply` **之前**经 `Config`（Standard Schema）校验，缺省字段按 schema 回填。
- 服务的生命周期绑定到**提供它的 fiber**：fiber 卸载即自动注销服务并唤醒依赖方，无需手写回滚逻辑。

由此得到的性质：**顺序写错不再只靠启动期报错兜底，而是「依赖未满足就不加载」——不会出现运行期空引用。**

### 4.4 启动装配顺序与服务拓扑

`server/src/index.ts` 以 `new Context()` 为根容器，加载顺序为 **llm → db → openmaic(storage/generation/layout/slide/audio) → http**：

| 顺序 | 插件名 | inject | provide（服务） |
| --- | --- | --- | --- |
| 1 | `edu-loop:llm` | — | `llm` |
| 2 | `edu-loop:db` | — | `db`、`repo` |
| 3 | `openmaic:storage` | `db` | `kv.store`、`docs.store` |
| 4 | `openmaic:generation` | `llm` | `openmaic.generation` |
| 5 | `openmaic:layout` | — | `openmaic.layout` |
| 6 | `openmaic:slide` | `llm`、`repo` | `openmaic.slide` |
| 7 | `openmaic:audio` | — | `openmaic.tts`、`openmaic.asr` |
| 8 | `edu-loop:http` | `llm`、`repo` | `app` |

拓扑正确性由 `inject` 声明保证：`openmaic:storage` 依赖 `db`，`openmaic:slide` 依赖 `llm` / `repo`，`edu-loop:http` 依赖 `llm` / `repo`。**依赖不满足的插件不会被加载**，因此 `index.ts` 的书写顺序只需保证依赖先到，语义上不构成隐式约定。（`http` 插件不再需要内建的 `kernel` 服务。）

### 4.5 装配成果的可观测性

`GET /api/plugins` 直接读取 Cordis 的两处内部结构，无需任何额外服务：

- **已加载插件**：`ctx.registry.values()` → 每个插件运行时记录的 `name`。
- **已注册服务**：`ctx.reflect.store`（`Dict<Impl>`）→ 每项的 `name`、`fiber.name`（提供方插件名）、`value` 是否可用。

因此该接口等价于一个轻量的运行时架构自检。

---

## 5. LLM 抽象层

设计目标：**新增一个 LLM 端点只改配置，不改代码**。

### 5.1 统一流式协议 StreamChunk

对齐 DSH `@deepseek-ai/dsh-llm` 的分片协议（`server/src/llm/types.ts`）：

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
```

**协议不变量**：每个 `block-start` 必须配对 `block-end`；`usage` 必须在 `finish` 之前产出；`finish` 必须是最后一个分片。

内容块词表 `ContentBlockType` 可扩展：`text` / `reasoning` / `tool-call`。停止原因用可辨识联合表达，`aborted` 与 `error` 携带可序列化的 `LlmFailure { message, code, status? }`。

### 5.2 Provider Profile 配置

`llm.config.json` 的字段命名刻意对齐 DSH 的 `PiAiProviderProfile`：

| 字段 | 说明 |
| --- | --- |
| `api` | 线协议：`openai-completions` \| `mock` |
| `baseURL` | 端点；`openai-completions` 下必填（启动期校验） |
| `apiKeyEnv` | **凭据引用（环境变量名），不落明文** |
| `displayName` | 展示名 |
| `headers` / `timeoutMs` | 自定义头与超时 |
| `extraBody` | provider 专有请求体字段，**原样并入** `/chat/completions`，用于承载各家非标准参数（如火山方舟的 `thinking`），避免厂商差异渗进适配器代码 |
| `models` | 模型目录（`id` / `name` / `description` / `contextWindow` / `maxTokens`） |

保留字段 `model` / `messages` / `stream` / `stream_options` 不可被 `extraBody` 覆盖。

当前实际配置的三个 provider：

| provider | api | baseURL | apiKeyEnv | 模型 |
| --- | --- | --- | --- | --- |
| `deepseek` | openai-completions | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `deepseek-chat`、`deepseek-reasoner` |
| `doubao`（**默认**） | openai-completions | `https://ark.cn-beijing.volces.com/api/v3` | `DOUBAO_LLM_API_KEY` | `doubao-seed-2-1-pro-260628` |
| `mock` | mock | — | — | `mock-teacher` |

豆包 profile 通过 `extraBody` 关闭了思维链（`thinking: { type: "disabled" }`），以缩短首字延迟。

### 5.3 降级机制（G1 的实现）

`loadLlm()`（`server/src/llm/loader.ts`）的装配逻辑：

```
for 每个 provider profile:
  if api === 'mock'                    → 注册 MockAdapter，标记 degraded
  else if resolveCredential(apiKeyEnv) === undefined
                                       → 注册 MockAdapter 顶替，标记 degraded
  else                                 → 注册 OpenAICompatAdapter（真实调用）
```

关键设计：
- **降级是「路由级」的**，而非全局开关。某个 provider 缺 Key 只影响该路由，其余 provider 照常真实调用。
- **降级状态对外可见**：经 `/api/health`、`/api/llm/providers` 暴露 `degraded: true`，前端据此显示「本地降级 / 真实模型」标签。
- **降级不影响闭环完整性**：mock 适配器返回确定性结构化内容，五步流程与真实模型走完全相同的代码路径。

### 5.4 提示词与适配器的耦合点：`[[task:xxx]]` 标记

每个提示词首行携带机器标记（如 `[[task:course_outline]]`）。真实模型会忽略它，而 mock 适配器据此返回对应的确定性内容。这样**「有 Key / 无 Key」两条路径共用同一套教学流程代码**，无需在业务层写任何分支。

---

## 6. 教学领域层

### 6.1 提示词契约（`server/src/teaching/prompts.ts`）

统一的教师系统提示词要求：先框架后细节、输出可直接用于学习、输出 JSON 时不得包裹解释文字。

| 函数 | task 标记 | 输出契约 |
| --- | --- | --- |
| `courseOutlinePrompt` | `course_outline` | `{ title, summary, objectives[], lessons[{ title, objective, keyPoints[] }] }` |
| `lessonExplainPrompt` | `lesson_explain` | Markdown 正文，含直觉引入、关键概念、具体例子、常见误区、自检问题，≤600 字 |
| `quizGeneratePrompt` | `quiz_generate` | `{ questions[{ type, stem, options, answer, explanation, difficulty }] }` |
| `quizGradePrompt` | `quiz_grade` | `{ correct, score(0-100), feedback }` |
| `rubricGeneratePrompt` | `rubric_generate` | `{ criteria[{ id, name, weight, descriptor, levels[] }] }`，权重和为 1 |
| `rubricEvaluatePrompt` | `rubric_evaluate` | `{ totalScore, level, perCriterion[], suggestions[] }` |

其中 `quizGradePrompt` 的**分步判分说明**是质量关键：要求先把参考答案拆成 2–4 个关键要点，再逐要点核对学习者作答并按命中比例给部分分，最后输出面向学习者的、含「一个可立即执行的改进动作」的反馈，且语气客观非指责。

`rubricEvaluatePrompt` 则体现了**证据驱动评估**：把已作答数、正确数、正确率、最近错题作为学习证据注入，而非让模型凭空打分。

### 6.2 JSON 提取与归一化

| 模块 | 职责 |
| --- | --- |
| `teaching/json.ts` | `extractJson`：先尝试直接解析 → 剥离 ```` ```json ```` 围栏 → 提取首尾平衡对象；均失败则抛解析错误 |
| `teaching/normalize.ts` | 对大纲等结果做字段 coercion/校验：补齐缺失标题、目标、课次，并**限制 `objectives` / `lessons` / `keyPoints` 数量**，防止模型输出失控撑爆库与 UI |

**设计意图**：LLM 输出是不可信输入。长度截断 + 数量上限 + 结构归一化，是保证下游稳定性的第一道防线。

---

## 7. 间隔重复调度（简化 SM-2）

`server/src/teaching/srs.ts` 用一个纯函数实现调度，是全项目**唯一的确定性算法核心**（不依赖 LLM）。

### 7.1 状态与算法

```ts
interface SrsState { ease: number; intervalDays: number; repetitions: number }

schedule(state, grade, now):
  clamped     = clamp(round(grade), 0, 5)
  nextEase    = clampEase(state.ease + (0.1 - (5-clamped) * (0.08 + (5-clamped) * 0.02)))
  repetitions = clamped < 3 ? 0 : state.repetitions + 1
  intervalDays = clamped < 3 ? 1
               : repetitions === 1 ? 1
               : repetitions === 2 ? 6
               : max(1, round(state.intervalDays * nextEase))
  dueAt       = now + intervalDays * 86400000
```

配套约定：

| 函数/常量 | 值 | 说明 |
| --- | --- | --- |
| `clampEase` | `[1.3, 2.8]`，保留 2 位小数 | 难度因子上下界，防止 ease 塌陷或爆炸 |
| `initialReview` | `ease=2.5, intervalDays=0, repetitions=0, dueAt=now` | 新题**立即到期**，等待首次作答 |
| `gradeFromCorrect` | 答对 → 4；答错 → 2 | 把「对/错」折算为 0–5 回忆质量 |
| `MIN_GRADE` / `MAX_GRADE` | 0 / 5 | 评分量程（0=完全想不起来，5=脱口而出） |

### 7.2 行为特征

- **答错（grade < 3）即重置**：`repetitions` 归零、间隔压回 1 天，进入「重新学习」状态。
- **首次正确不立刻拉长间隔**：`repetitions=1` 时仍为 1 天，`repetitions=2` 时为 6 天，之后才按 `interval × ease` 递增。这是 SM-2 的标准阶梯，避免「一次侥幸答对」导致长期不复习。
- **纯函数、无副作用、可注入 `now`**：便于测试与时间旅行回放。

### 7.3 与闭环的衔接

| 触发点 | 行为 |
| --- | --- |
| 出题 | 为每题建 `reviews` 行，`due_at = now`（立即可复习） |
| 测验作答 | 判分后按 `gradeFromCorrect(correct)` 自动推进调度 |
| 复习页 | `GET /api/review/courses/:id/due` 取到期项，提交 0–5 分档位 |

---

## 8. 评测中心（LLM Judge）

这是本方案**独有的增量设计**，是相对「DSH × OpenMAIC」链路的补强项：让系统能**反向评估自己产出的教学产物质量**，从而驱动迭代。

### 8.1 设计定位

`server/src/eval/metrics.ts` 开宗明义：评估对象是**教学产物**（大纲/讲解/题目/判分反馈），而非学习者。这与第 5 步的「评估量规」（评估学习者）形成正交的两条评估线：

| 维度 | 步骤 5：评估量规 | 评测中心 |
| --- | --- | --- |
| 评估对象 | **学习者** | **教学产物** |
| 证据来源 | 作答记录、正确率、错题 | 课程大纲、讲解正文、题目、判分反馈 |
| 产出用途 | 给出学习建议 | 驱动产品/提示词迭代 |
| 开放模式 | 全模式 | **仅开发模式** |

### 8.2 指标定义

每个产物类型对应一组带权重的维度（1–5 分制，权重和为 1）：

| 产物 | 维度（权重） |
| --- | --- |
| `outline` 课程大纲 | 内容准确性 .30、目标-课次连贯性 .25、可操作性 .25、关键概念覆盖 .20 |
| `explain` 结构化讲解 | 内容准确性 .30、直观易懂 .30、结构完整 .20、例子质量 .20 |
| `quiz` 测验题目 | 与目标一致 .25、题干无歧义 .25、难度合理 .25、解析质量 .25 |
| `grade` 判分反馈 | 判分准确 .40、反馈可执行 .40、语气建设性 .20 |

每个维度都定义了 **5 分锚点与 1 分锚点**（如「判分准确」：5 分 = 对/错判断与参考答案实质一致；1 分 = 判分明显错误），作为 Judge 的打分依据，抑制主观漂移。

### 8.3 打分与归一化

`runJudge()` → `normalizeJudgeResult()` 的算分链路：

```
加权原始分 = Σ(score_i × weight_i)          // score_i ∈ [1,5]
结构分     = round(加权原始分 / 5 × 100)     // 映射到 0-100
最终总分   = clamp(round(模型给的 totalScore), 0, 100)  若可解析，否则用结构分
```

等级口径（与量规一致）：`≥85 优秀`、`≥70 良好`、`≥50 合格`、`<50 待提升`。

**健壮性设计**：
- 维度分数强制取整并 clamp 到 `[1,5]`；缺失维度以 1 分兜底并补空评语。
- 模型给出的 `totalScore` **仅作参考**，无法解析时回退到由维度结构算出的分数——避免模型自报总分与维度分自相矛盾。
- Judge 调用失败（`errorCode` 存在）直接抛出，由路由转为 `502`，不产出脏数据。
- 每条评测落库为一条 `eval_runs`，含 `provider` / `model` / `degraded`，支持跨模型对比。

### 8.4 产物收集

`collectCandidates()` 按目标类型从仓库取产物：

| target | 默认（不传 `all`） | `all=true` |
| --- | --- | --- |
| `outline` | 课程整体大纲（1 份） | 同左 |
| `explain` | 首个课次的讲解 | 全部课次讲解 |
| `quiz` | 首道题 | 全部题目 |
| `grade` | 首次作答反馈 | 全部作答反馈 |

---

## 9. 数据模型

`server/src/db/index.ts` 中集中定义 DDL，共 **9 张表**。连接建立后立即执行：

```sql
PRAGMA journal_mode = WAL;   -- 读写并发，避免写锁阻塞读
PRAGMA foreign_keys = ON;    -- 启用外键约束（SQLite 默认关闭）
```

### 9.1 表结构总览

| 表 | 主键 | 说明 | 关键索引 |
| --- | --- | --- | --- |
| `courses` | `id` | 课程主记录：topic / material / title / summary / objectives(JSON) / provider / model / degraded | — |
| `lessons` | `id` | 课次：`course_id` FK、`idx` 序号、objective、key_points(JSON)、explanation、explained_at | `(course_id, idx)` |
| `questions` | `id` | 题目：`course_id` FK、`lesson_id` FK(SET NULL)、type、stem、options(JSON)、answer、explanation、difficulty | `(course_id, idx)` |
| `attempts` | `id` | 作答记录：`question_id` FK、answer、correct、score、feedback、graded_by(默认 llm) | `(question_id)` |
| `reviews` | `question_id` | 复习调度状态：ease、interval_days、repetitions、due_at、last_grade、last_reviewed_at | `(due_at)` |
| `rubrics` | `id` | 评分量规：`course_id` FK、criteria(JSON) | `(course_id)` |
| `rubric_evaluations` | `id` | 量规评估结果：total_score、level、detail(JSON) | `(course_id)` |
| `llm_call_logs` | `id` | 调用审计：provider/model/task/prompt_chars/output_chars/input_tokens/output_tokens/latency_ms/status/error_code | `(created_at)` |
| `eval_runs` | `id` | Judge 评测运行：target_type、target_id、judge_provider/model、degraded、total_score、level、detail(JSON) | `(course_id, target_type)` |

### 9.2 模型要点

- **级联删除**：所有从属表对 `courses(id)` 声明 `ON DELETE CASCADE`，删课程即清理全部闭环数据；`questions.lesson_id` 用 `ON DELETE SET NULL`（删课次不应连带删题）。
- **`reviews` 以 `question_id` 为主键**——一题一行调度状态，天然幂等，配合 `upsertReview`。
- **JSON 字段以 TEXT 存储**（`objectives` / `key_points` / `options` / `criteria` / `detail`），由 Repository 负责序列化。牺牲了 SQL 内查询能力，换取零依赖与 schema 稳定性。
- **索引策略聚焦访问路径**：按课程取课次/题目（`(course_id, idx)`）、按到期时间取复习项（`due_at`）、按时间倒序取审计日志（`created_at`）。
- **`llm_call_logs` 是可观测性基座**：每次 LLM 调用落一条，含 `task`、字符数、真实 token 数、延迟与状态，使「成本与质量」可被量化。

> 注：`edu-loop-mvp/README.md` 中「共 8 张表」的表述已滞后（`eval_runs` 为评测中心新增），实际为 9 张。

### 9.3 仓库访问层

`Repository`（`server/src/db/repo.ts`）封装全部数据访问，方法族：

| 族群 | 方法 |
| --- | --- |
| 课程 | `insertCourse` / `getCourse` / `listCourses` |
| 课次 | `insertLessons` / `getLesson` / `listLessons` |
| 题目 | `insertQuestions` / `listQuestions` / `getQuestion` / `countQuestions` |
| 作答 | `insertAttempt` / `listAttempts` |
| 复习 | `getReview` / `upsertReview` / `listDueReviews` / `listReviews` |
| 量规 | `insertRubric` / `latestRubric` / `insertRubricEvaluation` / `latestEvaluation` |
| 审计 | `insertLlmLog` / `listLlmLogs` |
| 评测 | `insertEvalRun` / `listEvalRuns` / `latestEvalPerType` |

批量插入（`insertLessons` / `insertQuestions`）在事务中执行，保证课程与课次/题目的原子性。

---

## 10. 接口设计

### 10.1 通用约定

- 前缀统一 `/api`；未匹配的 `/api/*` 返回 `404 { error: { message: '接口不存在' } }`。
- 错误响应统一形状：`{ error: { message: string, code?: string } }`（`server/src/http/sse.ts` 的 `sendError`）。
- 请求体上限 `2mb`（`express.json({ limit: '2mb' })`）。

### 10.2 元信息与诊断

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 返回 `{ ok, mode, defaultProvider, defaultModel, providers, time }`。**`mode` 是前端感知运行模式的唯一来源** |
| GET | `/api/plugins` | 插件清单 + 服务拓扑（含提供方与可用性） |
| GET | `/api/llm/providers` | provider 目录（含 `degraded` 标记与各模型信息） |
| GET | `/api/llm/calls?limit=` | 调用审计，`limit` 默认 50、clamp 到 `[1,200]` |

### 10.3 闭环五步

| 方法 | 路径 | 类型 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/courses` | JSON | 课程列表 |
| GET | `/api/courses/:id` | JSON | 课程详情（课程 + 课次 + 作答统计） |
| POST | `/api/courses` | **SSE** | 步骤①生成课程大纲。body: `{ topic, material?, provider, model }` |
| POST | `/api/courses/:id/lessons/:lessonId/explain` | **SSE** | 步骤②生成讲解 |
| GET | `/api/quiz/courses/:courseId/questions` | JSON | 题目 + 作答 + 统计 |
| POST | `/api/quiz/courses/:courseId/generate` | JSON | 步骤③a 出题。body: `{ provider, model, lessonId?, count? }` |
| POST | `/api/quiz/questions/:questionId/attempt` | JSON | 步骤③b 作答判分，返回 `{ attempt, stats }` |
| GET | `/api/review/courses/:courseId/due` | JSON | 步骤④到期复习项 |
| GET | `/api/review/courses/:courseId/all` | JSON | 全部复习状态 |
| POST | `/api/review/questions/:questionId/review` | JSON | 提交 0–5 回忆评分，返回 `{ review, remainingDue }` |
| POST | `/api/review/questions/:questionId/review-binary` | JSON | 便捷入口：按对/错提交（内部折算 4/2 分） |
| GET | `/api/rubric/courses/:courseId` | JSON | 最新量规 + 最新评估 |
| POST | `/api/rubric/courses/:courseId/generate` | JSON | 步骤⑤a 生成量规 |
| POST | `/api/rubric/courses/:courseId/evaluate` | JSON | 步骤⑤b 依据学习证据评估 |
| POST | `/api/slides/courses/:courseId/lessons/:lessonId/slides` | JSON | 生成幻灯片 deck（依赖 `openmaic.slide`，失败不阻断闭环） |

### 10.4 评测中心（仅开发模式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/eval/courses/:courseId` | 返回 `{ targets[], latest, runs[] }`，`targets` 含各类型的维度与权重定义 |
| POST | `/api/eval/courses/:courseId/run` | body: `{ target, all?, provider?, model? }`，返回 `{ runs }` |

### 10.5 SSE 帧协议

`openSse()`（`server/src/http/sse.ts`）设置响应头：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no          # 关键：禁用 Nginx 等反代的响应缓冲，否则流式会被整段缓存
```

帧格式为标准 `event: <name>\ndata: <json>\n\n`。

| 接口 | 事件序列 |
| --- | --- |
| `POST /api/courses` | `meta`（courseId/provider/model/degraded）→ `delta`*（流式文本）→ `outline`（课程+课次+usage）/ `error` |
| `POST .../explain` | `meta`（lessonId/…）→ `delta`* → `done`（落库后的 lesson）/ `error` |

**一个踩过的坑（已在代码注释中固化）**：不能用 `req.on('close')` 判断客户端断开——`express.json()` 读完请求体后 `req` 会立即触发 `'close'`，导致通道被误判为已关闭、响应永不结束。必须只监听 `res` 的 `'close'`。

---

## 11. 前端架构

### 11.1 路由与步骤

`web/src/router/index.ts` 定义 `STEPS` 常量与路由表，六页一一对应：

| 路径 | 组件 | 步骤标题 |
| --- | --- | --- |
| `/` → `/course` | — | 重定向 |
| `/course` | `CourseView.vue` | 1. 生成课程 |
| `/explain` | `ExplainView.vue` | 2. 结构化讲解 |
| `/quiz` | `QuizView.vue` | 3. 测验 |
| `/review` | `ReviewView.vue` | 4. 间隔重复 |
| `/rubric` | `RubricView.vue` | 5. 评估量规 |
| `/eval` | `EvalView.vue` | 评测中心 |
| `/:pathMatch(.*)*` | — | 兜底重定向到 `/course` |

侧边栏由 `STEPS` 驱动渲染 `el-steps`，点击切换页内路由（不整页刷新）。

### 11.2 启动时序（含模式门禁）

`web/src/main.ts` 的顺序至关重要：

```
1. createApp + use(pinia)
2. useSystemStore → await system.load()      # 先取 /api/health 的 mode
3. router.beforeEach(...)                     # 注册守卫：生产模式拦截 /eval
4. app.use(router)
5. app.mount('#app')
```

**守卫必须在 `app.use(router)` 之前注册**——vue-router 在安装时会立即触发首次导航，若之后注册，直接访问 `/eval` 会漏拦。

### 11.3 状态管理（Pinia）

| store | 职责 |
| --- | --- |
| `course.ts` | **闭环全部状态**：courses / course / lessons / questions / attempts / stats / due / reviews / rubric / evaluation / slideDeck；getters 提供 `latestAttemptByQuestion`、`wrongQuestions`、`dueCount`；actions 覆盖五步全部读写 |
| `llm.ts` | provider / model 选择状态 |
| `system.ts` | 运行模式，getter `evalEnabled = mode === 'development'` |

`course.ts` 的 actions 与后端接口一一对应：`createCourse` / `explainLesson` / `generateSlides` / `generateQuiz` / `submitAttempt` / `loadDue` / `submitReview` / `generateRubric` / `evaluate`。

### 11.4 SSE 客户端

`web/src/api/client.ts` 的 `postSse` 手写帧解析：

- 用 `fetch` POST 拿到 `ReadableStream`，`getReader()` + `TextDecoder`
- 按 `\n\n` 切分帧边界；逐行解析 `event:` / `data:`（`data:` 后单个空格需剥离）
- 多行 `data:` 以 `\n` 拼接；JSON 解析失败时降级为纯字符串回调
- 流结束前残留的 buffer 也会派发，避免丢最后一帧
- 支持 `AbortSignal` 取消

### 11.5 Markdown 安全渲染

`web/src/utils/markdown.ts` 采用**零依赖白名单方案**，这是针对「模型输出即不可信输入」的正面防御：

1. **先全量 HTML 转义**（`& < > " '`）——所有原始标签失效，从根本上掐断 `<script>` / `<img onerror>` 类注入。
2. **再只放行一个很小的语法子集**：标题 `#`~`######`、引用 `>`、代码围栏 ```` ``` ````、有序/无序列表、`**bold**`、`*italic*`、`` `code` ``。
3. 行内 `code` 用占位符托管，避免代码内容被后续 bold/italic 正则二次加工。

选择自研而非「markdown 库 + `v-html`」，是为了**让白名单是显式的、可审计的**，而不是依赖第三方 sanitizer 的默认策略。

### 11.6 幻灯片渲染（Vue 容器中挂载 React 渲染器）

`SlidePreview.vue` 需要把 OpenMAIC 的 React 渲染器挂进 Vue 组件树。实现要点：

- 在 Vue 侧维护一个容器 `div` 作为挂载点，用 React `createRoot` 渲染 deck。
- `watch(props.deck)` 中 **`await nextTick()`** 后再操作——否则容器尚未渲染，`createRoot` 会挂到空节点。
- **跟踪 `rootEl`**：当容器被 `v-if` 重建导致 DOM 节点变化时，先卸载旧 root 再新建，避免 "旧 React root 已脱离 DOM" 导致的首屏空白。
- 渲染器依赖通过 Vite `alias` 直接指向 `OpenMAIC/packages/@openmaic/renderer/src`，**编译源码而非安装整棵依赖树**；renderer 的裸模块依赖（react、react-dom、echarts、motion 等）统一 alias 回 `web/node_modules`。

> 取舍说明：这些 alias 只指向顶层包入口，子路径（`react/jsx-runtime`、`echarts/core` 等）交给各包自身的 `exports` map 解析，以避免 Vite 预构建失败。

---

## 12. 运行模式分离（dev / production）

### 12.1 模式解析

`server/src/config/mode.ts` 是唯一判定点：

```ts
export type AppMode = 'development' | 'production'
export function resolveAppMode(): AppMode {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
}
```

`npm script` 层显式注入 `NODE_ENV`，模式只由启动命令决定，不做运行时切换。

### 12.2 两模式差异

| 维度 | development | production |
| --- | --- | --- |
| 前端 | Vite dev server（5173，HMR） | 后端单端口托管 `web/dist` |
| 后端 | `tsx watch` 跑源码，热重载 | `node dist/index.js` 跑编译产物 |
| CORS | **开启**（前端 5173 跨域访问 8787） | **关闭**（同源单端口） |
| `/api/eval/*` | 正常服务 | **403 拦截** |
| SPA 回退 | — | `express.static` + `app.get('*')` 回退 `index.html` |
| 评测中心入口 | 显示 | 侧边栏隐藏 + 路由守卫重定向 |

dev 模式下前端通过 Vite 代理访问后端，因此浏览器侧实际是**同源**请求：

```ts
// web/vite.config.ts
server: { port: 5173, proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } } }
```

### 12.3 评测中心的双端门禁

屏蔽必须**前后端同时生效**，否则前端隐藏但接口裸奔（或反之）：

**后端**（`server/src/app.ts`）：

```ts
if (mode === 'development') {
  app.use('/api/eval', createEvalRouter(context))
} else {
  app.use('/api/eval', (_req, res) => {
    res.status(403).json({ error: { message: '评测中心仅在开发模式可用' } })
  })
}
```

**前端**三重配合：
1. `system.ts` 从 `/api/health` 读 `mode`，暴露 `evalEnabled`。
2. `App.vue` 的 `visibleSteps` 在 `evalEnabled=false` 时过滤掉 `eval` 步骤，品牌副标题同步去掉「评测」字样。
3. `main.ts` 的路由守卫把直接访问 `/eval` 重定向回 `/course`。

**失败安全策略**：`system.load()` 请求失败时保持默认 `development`——宁可多显示（接口侧仍会 403），也不误藏功能。

### 12.4 生产部署链路

```
pnpm build          # 前端 vue-tsc + vite build → web/dist
                    # 后端 tsc -p tsconfig.build.json → server/dist
pnpm start          # NODE_ENV=production node dist/index.js，单端口 8787
```

启动日志会显式打印运行模式、默认 provider/model、已加载插件清单，并在生产模式下检查 `web/dist/index.html` 是否存在，缺失时给出明确告警而非静默失败。

---

## 13. 与 DSH / OpenMAIC 的结合关系

### 13.1 结合形态：内核同源、业务契约对齐

本项目的结合是**内核直接采用 + 契约级对齐**。`server/package.json` 的运行时依赖为 `express`、`cors`、`@openmaic/dsl`，以及 DSH 同源的 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`——**内核与配置校验已改为直接使用 DSH 的原生实现，其余业务契约仍按需裁剪复刻**。

| DSH 侧契约 | 本项目落点 | 对齐程度 |
| --- | --- | --- |
| Cordis `Context`（DI + 反射 + 事件总线） | 直接使用 `@deepseek-ai/cordis` | **原生采用**（不再是复刻） |
| 「一切皆插件」`inject`/`provide`/`Config`/`apply`/disposer | 各插件模块的命名导出 | 原生契约 |
| 依赖驱动的响应式装配与 fiber 级生命周期 | Cordis `registry` / `reflect` | 原生契约 |
| `@deepseek-ai/schemastery` 配置校验 | 各插件的 `Config` 导出 | **原生采用** |
| `@deepseek-ai/dsh-llm` 适配器契约 | `llm/types.ts` | 刻意对齐，差异显式声明 |
| `LlmRuntime` provider 注册表 | `llm/registry.ts` | 保留最小子集 |
| `PiAiProviderProfile` 字段命名 | `llm/config.ts` | 对齐（含 `apiKeyEnv` 凭据引用约定） |
| 统一流式协议 | `llm/types.ts` 的 `StreamChunk` | 语义一致 |
| 「一切皆插件」的安装体系 | — | **未结合**（无 Profile × 组合包 × 有序 patch） |

### 13.2 与 OpenMAIC 的实体级结合

这是项目中唯一的真实跨仓库依赖：

| 结合点 | 路径 | 形态 |
| --- | --- | --- |
| 幻灯片资源契约 | `@openmaic/dsl`（`file:../../OpenMAIC/packages/@openmaic/dsl`） | 后端 `openmaic-slide` 插件产出符合 `Stage`/`Scene`/`SlideElement` 契约的文档并用其校验 |
| 渲染器 | Vite alias → `OpenMAIC/packages/@openmaic/renderer/src` | 前端 `SlidePreview.vue` 编译源码渲染 |

**软耦合设计**：`openmaic-slide` 在解析不到 `@openmaic/dsl` 时**降级为内置生成器**，只打警告、不抛错、不阻断闭环。

### 13.3 有意收窄的部分（差异清单）

| 项 | DSH | 本项目 | 理由 |
| --- | --- | --- | --- |
| 内核 | `@deepseek-ai/cordis`（自带） | **同一实现（直接依赖）** | 从「复刻」升级为「同源」，换取契约完全一致 |
| `RequestMessage.content` | 内容块数组 | **纯文本字符串** | 一对一教学场景用不到多模态内容块 |
| `toolHistory` / `reasoningEffort` / `purpose` | 具备 | 省略 | 单轮调用场景无需求 |
| `degraded` 字段 | 无 | **新增** | 支撑「无 Key 也能跑通」这一硬约束 |
| 持久化 | 自带体系 | `node:sqlite` | 换零原生依赖与免编译 |
| remote / typert / settings 目录 / 瀑布式事件 | 具备 | 省略 | 保留最小可用子集 |

### 13.4 本项目的增量价值

相对「DSH × OpenMAIC」原有链路，本项目**补齐并验证了三件事**：

1. **闭环后半段落地**：间隔重复（SM-2）与评估量规从「报告中的缺口」变为可运行代码。
2. **产物质量可度量**：评测中心提供带锚点的 Judge 指标体系与跨模型对比能力，使提示词迭代有量化依据。
3. **架构可行性验证**：证明 DSH 的 Cordis 插件内核与 LLM loader 契约可以直接被一个独立全栈工程以最小成本采用——内核与配置校验均为 DSH 同源的 Cordis / schemastery，无需引入 DSH 全量运行时。

---

## 14. 部署与运行

### 14.1 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.5**（依赖内置 `node:sqlite`；已在 Node 26 验证） |
| 包管理 | pnpm（仓库锁定 `pnpm@12.4.2`） |
| 其他 | 无需数据库服务、无需编译工具链 |

### 14.2 环境变量

`.env` 由 `server/src/config/env.ts` 的 `loadDotEnv` 在启动时加载，仅存**凭据变量名到值的映射**；`llm.config.json` 只引用变量名，不落明文。

| 变量 | 用途 |
| --- | --- |
| `DOUBAO_LLM_API_KEY` | 火山方舟（豆包）凭据，默认 provider |
| `DEEPSEEK_API_KEY` | DeepSeek 凭据 |
| `PORT` | 后端端口，默认 `8787` |

### 14.3 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 并行启动前后端（开发模式） |
| `pnpm dev:server` | 仅后端（`tsx watch`） |
| `pnpm dev:web` | 仅前端（Vite 5173） |
| `pnpm build` | 全量类型检查 + 构建 |
| `pnpm start` | 生产单端口启动（需先 build） |
| `pnpm prod` | build 后直接生产启动 |
| `pnpm typecheck` | 全量类型检查（不产出） |

### 14.4 运行数据

| 项 | 路径 |
| --- | --- |
| 数据库 | `server/data/edu-loop.db`（含 `-wal` / `-shm`） |
| 前端产物 | `web/dist` |
| 后端产物 | `server/dist` |

---

## 15. 非功能设计

### 15.1 安全

| 面 | 措施 |
| --- | --- |
| 凭据管理 | 配置文件只存环境变量名，值仅存于 `.env`；`.env` 已在 `.gitignore` |
| XSS | 模型输出经转义 + 白名单子集渲染，不直接 `v-html` |
| 输入边界 | `express.json` 限 2mb；`topic` 空值校验；prompt 中 `material` 截断至 4000 字符；Judge artifact 截断至 6000 字符 |
| 输出失控 | `normalize.ts` 对 objectives/lessons/keyPoints 数量设上限 |
| 接口门禁 | 生产模式 `/api/eval/*` 硬拦截 403 |
| SQL | 全部经 Repository 参数化访问，无字符串拼接 |

### 15.2 可观测性

- **`/api/health`**：运行模式、默认路由、provider 清单。
- **`/api/plugins`**：插件与服务拓扑，等价于启动期架构自检。
- **`/api/llm/calls`**：每次 LLM 调用的 `task`、字符数、真实 token、延迟、状态、错误码——成本与质量可量化。
- **启动日志**：打印模式、provider/model、插件清单、静态资源托管状态与告警。

### 15.3 健壮性

| 场景 | 处理 |
| --- | --- |
| 无 API Key | 路由级降级为 mock，闭环完整可跑，状态外显 |
| 模型返回非 JSON | `extractJson` 三级降级（直接解析 → 剥围栏 → 平衡对象提取） |
| 模型返回结构缺失 | `normalize*` 补齐兜底，Judge 缺失维度按 1 分并补空评语 |
| 模型自报总分与维度矛盾 | 以维度加权分为准 |
| Judge 调用失败 | 抛错 → 路由转 `502`，不落脏数据 |
| `@openmaic/dsl` 不可用 | 幻灯片能力降级为内置生成器，不阻断闭环 |
| SSE 客户端断开 | 仅监听 `res.close`，避免 `req.close` 误判 |
| 前端取不到 mode | 默认 development，宁可多显示也不误藏 |

---

## 16. 已知限制

| 编号 | 限制 | 影响 | 当前状态 |
| --- | --- | --- | --- |
| L1 | **课程状态存于前端内存** | 刷新页面后需用「选择课程」下拉重新选中才能恢复讲解/题目/复习/量规 | 后端已全量落库，恢复路径可用 |
| L2 | 无鉴权与多租户 | 仅适合单机演示/内部验证 | 已知边界 |
| L3 | 无并发写保护 | WAL 提供读写并发，但缺少业务级事务隔离 | 单用户场景无影响 |
| L4 | JSON 字段不可 SQL 查询 | 无法按 `objectives` 内容检索 | 换取 schema 稳定 |
| L5 | 无正式测试套件覆盖 | 仅 `server/tests/core.kernel.spec.ts`（Cordis 原生装配） | 需补 |
| L6 | 生产构建未做代码分割 | 首屏体积偏大 | 有优化空间 |
| L7 | 幻灯片为静态排版 | 无动画/交互 | 依赖 OpenMAIC 渲染器能力边界 |
| L8 | `README.md` 表数量描述滞后 | 文档与实现不一致（8 vs 9） | 建议同步 |

---

## 17. 后续演进建议

按优先级排序：

**P0 — 补齐工程完备性**
1. 为 `teaching/srs.ts`、`eval/judge.ts`（`normalizeJudgeResult`）、`utils/markdown.ts` 补单元测试。这三处是纯函数/强契约逻辑，测试收益最高。
2. 修正 `README.md` 表数量与模式说明的滞后表述。

**P1 — 体验与状态一致性**
3. 课程选择持久化（`localStorage` 记住 courseId，启动自动 `selectCourse`），消除 L1。
4. 生产构建增加路由级代码分割与 `SlidePreview` 懒加载，缓解 L6。

**P2 — 能力扩展**
5. 为评测中心引入**历史趋势**视图（同一课程跨版本/跨模型的 `eval_runs` 对比曲线），把「可度量」推进到「可回归」。
6. 把 `openmaic.tts` / `openmaic.asr` 两个已注册但未在闭环中使用的服务接入讲解页（语音播报 + 口头作答），打通多模态学习路径。
7. 复习调度从简化 SM-2 演进为 FSRS，并引入「作答耗时」「提示使用」等信号作为回忆质量输入。

**P3 — 架构演进**
8. 若需多用户/多租户，在 Repository 之上引入鉴权与 course 归属隔离，而非改动内核。
9. 若需接入 DSH 生态插件：内核已与 DSH 同源（同为 Cordis），DSH 插件本身即 Cordis 插件，可直接挂到本项目根容器上；只需保证其 `inject` 引用的服务名（如 `llm`）与本项目已注册的服务对齐。

---

## 附录 A：关键文件索引

| 关注点 | 文件 |
| --- | --- |
| 内核装配 | Cordis 原生（`@deepseek-ai/cordis`）；插件模块：`server/src/llm/plugin.ts`、`db/plugin.ts`、`http/plugin.ts`、`server/src/plugins/*/plugin.ts` |
| 启动入口 | `server/src/index.ts` |
| 应用装配与模式门禁 | `server/src/app.ts` |
| 模式解析 | `server/src/config/mode.ts` |
| LLM 契约 | `server/src/llm/types.ts`、`config.ts`、`registry.ts`、`loader.ts` |
| 适配器 | `server/src/llm/adapters/openai-compat.ts`、`mock.ts`、`sse.ts` |
| 提示词 | `server/src/teaching/prompts.ts` |
| SM-2 调度 | `server/src/teaching/srs.ts` |
| 评测指标与 Judge | `server/src/eval/metrics.ts`、`judge.ts` |
| Schema 与仓库 | `server/src/db/index.ts`、`repo.ts` |
| SSE 通道 | `server/src/http/sse.ts` |
| OpenMAIC 接入 | `server/src/plugins/openmaic-slide/plugin.ts`、`openmaic-layout/plugin.ts` |
| 前端 SSE 客户端 | `web/src/api/client.ts` |
| 闭环状态 | `web/src/stores/course.ts` |
| 模式感知 | `web/src/stores/system.ts`、`web/src/main.ts`、`web/src/App.vue` |
| Markdown 安全 | `web/src/utils/markdown.ts` |
| 模型接入开关 | `llm.config.json` |

## 附录 B：术语表

| 术语 | 含义 |
| --- | --- |
| DSH | DeepSeek Harness，本项目架构契约的来源 |
| Cordis | DSH 使用的插件化内核框架；本项目直接采用其原生实现（`@deepseek-ai/cordis`），并以 `@deepseek-ai/schemastery` 做配置校验 |
| StreamChunk | LLM 适配器输出的统一流式分片协议 |
| degraded | provider 未解析到凭据而回退到确定性 mock 的标记 |
| SM-2 | SuperMemo-2 间隔重复算法，本项目使用其简化变体 |
| Judge | LLM-as-Judge，用模型对教学产物按锚点维度打分 |
| 闭环 | 主题 → 课程 → 讲解 → 测验 → 复习 → 量规 的完整链路 |
