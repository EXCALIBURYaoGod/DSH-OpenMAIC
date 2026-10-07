# 03 · LLM 抽象层

LLM 层是整个项目的技术核心，位于 `server/src/llm/`。它把 DSH（DeepSeek Harness）
的「**配置驱动 provider + 适配器注册表 + 统一流式分片协议**」搬到本 MVP，是「新增模型
不改代码」这一目标的实现载体。

| 文件 | 职责 |
| --- | --- |
| [types.ts](file:///workspace/edu-loop-mvp/server/src/llm/types.ts) | 契约类型：内容块、流式分片、请求选项、元信息 |
| [config.ts](file:///workspace/edu-loop-mvp/server/src/llm/config.ts) | provider profile 类型 + 结构/不变量校验 |
| [registry.ts](file:///workspace/edu-loop-mvp/server/src/llm/registry.ts) | `LlmRuntime` 适配器注册表 + `assembleStream` 装配 |
| [loader.ts](file:///workspace/edu-loop-mvp/server/src/llm/loader.ts) | 把配置装配为可用 runtime，处理凭据解析与降级 |
| [plugin.ts](file:///workspace/edu-loop-mvp/server/src/llm/plugin.ts) | Cordis 插件外壳，注册 `llm` 服务 |
| [errors.ts](file:///workspace/edu-loop-mvp/server/src/llm/errors.ts) | 带机器可读 code 的错误类型 |
| [adapters/openai-compat.ts](file:///workspace/edu-loop-mvp/server/src/llm/adapters/openai-compat.ts) | OpenAI 兼容流式适配器（DeepSeek / 火山方舟等） |
| [adapters/mock.ts](file:///workspace/edu-loop-mvp/server/src/llm/adapters/mock.ts) | 确定性 mock 适配器（无 Key 跑通闭环） |
| [adapters/sse.ts](file:///workspace/edu-loop-mvp/server/src/llm/adapters/sse.ts) | 从 provider 响应体解析 SSE 事件 |

## 1. 契约类型（`types.ts`）

本文件刻意收窄 DSH 契约（如 `RequestMessage.content` 收窄为纯文本字符串、省略
`toolHistory`/`reasoningEffort`），保留最小可用子集。

### 内容块

```ts
export interface TextBlock      { type: 'text';      text: string }
export interface ReasoningBlock { type: 'reasoning'; text: string }   // 思维链，与可见文本区分
export interface ToolCallBlock  { type: 'tool-call'; id: ToolCallId; name: string; arguments: string }
export type ContentBlockType = 'text' | 'reasoning' | 'tool-call'
export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock
```

### 流式分片协议 `StreamChunk`（本层最重要的类型）

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

**协议约束**：每个 `block-start` 必须配对 `block-end`；`usage` 必须在 `finish` 之前；
`finish` 必须是最后一个分片。

### 停止原因与失败

```ts
export interface FinishReasonMap {
  stop: { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  aborted: { kind: 'aborted'; failure: LlmFailure }
  error:   { kind: 'error';   failure: LlmFailure }
}
export interface LlmFailure { message: string; code: string; status?: number }
```

### Token 统计与请求选项

- `TokenUsage`：`inputTokens` **仅表示未命中缓存的输入**（与 DSH 语义一致），另有
  `outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`。
- `GenerateOptions`：`provider / model / messages / system? / tools? / temperature? /
  maxTokens? / stop? / signal?`。`system` 会在 `messages` 之前映射到 provider 的 system 槽位。
- `LlmProviderInfo` 含本 MVP 新增的 `degraded?: boolean` 标记。

## 2. provider 配置（`config.ts`）

`LlmConfigFile` 描述整个 `llm.config.json`：

```ts
export interface LlmConfigFile {
  defaultProvider?: string
  defaultModel?: string
  providers: Record<string, ProviderProfile>   // 键即路由名
}
```

`ProviderProfile` 字段（命名对齐 DSH 的 `PiAiProviderProfile`）：

| 字段 | 含义 |
| --- | --- |
| `displayName?` | 展示名，默认取路由键 |
| `api?` | 线协议：`openai-completions` \| `mock`（默认 `openai-completions`） |
| `baseURL?` | 端点；`openai-completions` 下必需 |
| `apiKeyEnv?` | **凭据引用的环境变量名**，不落明文 |
| `headers?` | 附加请求头（保留名由适配器掌管） |
| `extraBody?` | provider 专有请求体字段（如火山方舟的 `thinking`），原样并入 body |
| `timeoutMs?` | HTTP 超时 |
| `models?` | 模型目录 `ModelProfile[]`（`id/name/description/contextWindow/maxTokens`） |

两个函数：

- `normalizeProviderProfile(provider, profile)`：回填 `api` 与 `displayName` 默认值；
- `assertValidConfig(config)`：**跨字段不变量**校验——至少一个 provider、`api` 必须在
  `PROVIDER_APIS`（`openai-completions` / `mock`）内、`openai-completions` 必须声明
  `baseURL`、模型 id 非空、`defaultProvider` 必须已定义。schema 管结构，此函数管不变量。

## 3. 适配器注册表（`registry.ts`）

### `LlmAdapter` 抽象类

```ts
export abstract class LlmAdapter {
  providerInfo(provider): LlmProviderInfo            // 展示元信息
  listModels(provider): Promise<readonly LlmModelInfo[]>   // 模型目录
  resolveModel(provider, model): Promise<LlmResolvedModelInfo>
  prepareCall(provider, model): Promise<PreparedAdapterCall>  // 绑定元信息与 dispatch
  abstract stream(options): AsyncIterable<StreamChunk>       // 唯一必须实现
}
```

### `LlmRuntime`

- `registerAdapter(providers[], adapter)` → 返回 **disposable 句柄**，句柄带 `replace(providers[])`：
  - **全有或全无**：任一 provider 已被别的适配器占用则抛 `DUPLICATE_ADAPTER`，不产生半提交；
  - `replace()` 先整体校验候选集再原子替换，避免空窗；已 dispose 的句柄调用 `replace` 抛 `REGISTRATION_DISPOSED`。
- `listProviders()` / `listModels(provider)`：元信息读取。
- `onAdaptersUpdated(listener)`：拓扑变化订阅（非否决性通知）。
- `stream(options)`：**把适配器异常归一化为终止性分片**而非抛出：

```ts
private async *streamInternal(options) {
  // 1) 取注册 + prepareCall 失败 → yield { finish: error }
  // 2) 逐块转发；一旦见到 finish 立即结束
  // 3) 流自然结束却没有 finish → PROTOCOL_VIOLATION
  // 4) 抛错时：signal.aborted ? aborted : error
}
```

### `assembleStream(chunks)` → `AssembledStream`

把分片流装配为完整文本，供非流式调用点使用：

```ts
export interface AssembledStream {
  text: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage?: TokenUsage
  finish: FinishReason
}
```

`text-delta` 累加、`block-end` 以块内文本为准（覆盖累加值）、`tool-call-delta` 按 index 归并参数。

## 4. loader：配置 → 可用 runtime（`loader.ts`）

`loadLlm(config)` 是本层「配置驱动」的落地：

```ts
export interface LoadedLlm {
  runtime: LlmRuntime
  defaultProvider: string
  defaultModel: string
  degradedProviders: Set<string>   // 无凭据回退到 mock 的 provider 集合
  config: LlmConfigFile
}
```

装配逻辑逐 provider 判定：

1. `api === 'mock'` → 注册 `MockAdapter`，标记为降级；
2. `openai-completions` 但 `resolveCredential(apiKeyEnv)` 为 `undefined` → **用 MockAdapter 顶替**
   该路由，`displayName` 追加「（本地降级，未配置 XXX）」，标记降级；
3. 否则注册 `OpenAICompatAdapter({ provider, profile, apiKey })`。

默认路由：`defaultProvider ?? providers 的第一个键`；`defaultModel ?? 该 provider 首个模型 id ?? 'mock-teacher'`。

> 这条「无 Key 也能跑通」的硬要求，正是通过「**降级发生在装配层，业务层无感知**」实现的。

## 5. Cordis 插件外壳（`plugin.ts`）

```ts
export const name = 'edu-loop:llm'
export const provide = 'llm'
export const Config = z.object({ defaultProvider, defaultModel, providers: z.dict(ProviderProfileSchema).required() })

export function apply(ctx, config): () => void {
  const loaded = loadLlm(config as LlmConfigFile)
  ctx.provide('llm', loaded)
  // 降级时打印告警 + 接入真实模型的提示
  return () => { /* 释放对 runtime 的引用 */ }
}
```

在 `declare module '@deepseek-ai/cordis'` 中把 `llm: LoadedLlm` 加到 `Context`，供类型推导。
`Config` 用 schemastery 描述结构（不写 `z<Config>` 注解是因为可选字段归一化输出比 `Config` 更宽）。

## 6. 错误类型（`errors.ts`）

`LlmError` 携带稳定机器码 `code` 与可序列化的 `failure`。预定义码：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `NO_ADAPTER_CODE` | `NO_ADAPTER` | 该 provider 未注册适配器 |
| `PROVIDER_HTTP_ERROR_CODE` | `PROVIDER_HTTP_ERROR` | provider 返回非 2xx |
| `INVALID_CREDENTIAL_CODE` | `INVALID_CREDENTIAL` | 凭据非法 |
| `ABORTED_CODE` | `ABORTED` | 调用被取消 |
| `MISSING_CREDENTIAL_CODE` | `MISSING_CREDENTIAL` | 无凭据（用于解释降级原因） |

`failureFromUnknown(error)` 把任意异常归一化为 `LlmFailure`。

## 7. 内置适配器

### 7.1 `OpenAICompatAdapter`（`adapters/openai-compat.ts`）

适用于 DeepSeek 及任何提供 `POST {baseURL}/chat/completions` + `stream: true` 的服务。

要点：

- 调用前校验 provider 一致性（`PROVIDER_MISMATCH`）与凭据存在（`MISSING_CREDENTIAL`）；
- **超时与取消合并**：`AbortSignal.any([options.signal, timeoutController.signal])`；
- 请求体：`{ ...extraBody, model, messages, stream: true, stream_options: { include_usage: true } }`，
  按需追加 `temperature / max_tokens / stop`；
- `toWireMessages()`：`system` 前置于 `messages`；
- **块管理**：推理块与文本块按需懒开启（各自分配 index），结束时按 index 排序统一发 `block-end`；
- `usage` 用 `!= null` 判空（火山方舟会在增量分片下发 `usage: null`）；
- `mapUsage()`：`inputTokens = prompt_tokens - prompt_cache_hit_tokens`（未命中缓存的输入）；
- `mapFinishReason()`：`tool_calls/function_call → tool-calls`、`length → max-tokens`、其余 `stop`。

### 7.2 `MockAdapter`（`adapters/mock.ts`）

确定性本地适配器，与上层共处同一套 `LlmAdapter` / `StreamChunk` 契约，因此业务层无需感知差异。

- **任务识别**：从提示词里匹配 `[[task:xxx]]` 标记（正则 `TASK_MARKER`），据此返回对应内容；
- **流式模拟**：把答案按 `chunkSize`（默认 24 字符）切片，逐片 `yield text-delta`，片间
  `chunkDelayMs`（默认 6ms）延时，让前端看到真实流式效果；
- 产出 `block-start → text-delta* → block-end → usage → finish`，token 数按 `字符数/2` 估算；
- 支持的任务：`course_outline` / `lesson_explain` / `quiz_generate` / `quiz_grade` /
  `rubric_generate` / `rubric_evaluate` / `eval_judge`；未识别时返回占位说明文本。

`renderTask` 内部按任务分支渲染确定性内容，例如 `mockOutline` 生成 3 课的课程结构、
`mockJudge` 依据产物长度与结构特征给出确定性分数（并明确标注这是示例评测）。

### 7.3 `parseSseStream`（`adapters/sse.ts`）

把 `fetch` 的 `ReadableStream` 解析为 SSE 事件序列：按 `\n\n` 切分事件块，
提取 `data:` 行（多行以 `\n` 连接）与可选 `event:` 字段，末尾残留 buffer 也会尝试解析。

## 8. 完整调用链

```
runLlm(context, input)                      （teaching/llm.ts）
   └─► runtime.stream(GenerateOptions)       （llm/registry.ts）
          └─► adapter.prepareCall() → adapter.stream()
                 ├─ OpenAICompatAdapter.stream()  → fetch → parseSseStream → StreamChunk
                 └─ MockAdapter.stream()          → 确定性文本切片 → StreamChunk
   ◄── assembleStream(chunks)                （llm/registry.ts）
        → { text, reasoning, usage, finish }
   ◄── 写 llm_call_logs（repo.insertLlmLog）
```

下一篇：[04-data-layer.md](./04-data-layer.md)。