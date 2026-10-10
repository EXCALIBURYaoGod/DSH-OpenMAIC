# LLM 接入

## 1. 结论：宿主优先（方案 B）

在 dsh 宿主内运行时，OpenTeach **不自持 LLM 配置、不复制凭据**。它把宿主的
`ctx.llm`（DSH `LlmRuntime`）**反向**适配成本项目自己的 provider 运行时，使
`eduLlm` 成为宿主 `ctx.llm` 的一层薄代理：

```
eduLlm  ──(DshHostLlmAdapter)──▶  宿主 ctx.llm  ──▶  provider（ark / ark-doubao / …）
provider 路由 · 端点 · 模型目录 · 凭据  全部由 dsh 掌管
```

实现见 [`packages/llm/src/dsh-host.ts`](../OpenTeach/packages/llm/src/dsh-host.ts)。

## 2. 为什么服务叫 `eduLlm` 而不是 `llm`

DSH 的 `LlmRuntime` 构造函数里硬编码了 `super(ctx, 'llm')`，`dsh-llm` 也已把
`Context.llm` 声明为它自己的 `LlmRuntime`。为避免命名冲突，本项目的 LLM 服务
改名为 **`eduLlm`**（见 [`packages/llm/src/plugin.ts`](../OpenTeach/packages/llm/src/plugin.ts)），
把 `llm` 这个名字让给 dsh 编排内核。

为此存在**两个方向相反**的适配器：

| 文件 | 方向 | 使用场景 |
| --- | --- | --- |
| `dsh-host.ts` → `DshHostLlmAdapter` | DSH `ctx.llm` → edu 运行时 | **dsh 宿主内运行（默认）** |
| `dsh-adapter.ts` → `DshLlmAdapter` | edu 运行时 → 注册进 DSH `ctx.llm` | 独立运行自装配内核时 |

## 3. 装配流程

`packages/llm/src/plugin.ts` 的 `apply()` 是 **async**：

```ts
const host = await probeDshLlm(ctx)
const loaded = host === undefined
  ? loadLlm(config)            // 独立运行：按 llm.config.json / 内置默认
  : await loadFromDshHost(ctx, host)   // 宿主内：反向适配
ctx.provide('eduLlm', loaded)
```

- `probeDshLlm(ctx)`：轮询等待宿主 `llm` 服务且 `listProviders().length > 0`，
  上限 **8s**、间隔 **25ms**。dsh 的 Loader 并行启动各条目，`llm-pi-ai` 晚于 `llm`
  就绪，所以首次快照可能只有最早的一条路由。独立运行时无 dsh 内核，立即返回
  `undefined`，**无额外延迟**。
- `loadFromDshHost(ctx, host)`：
  - 为宿主每个 provider 路由注册一个 `DshHostLlmAdapter`；
  - 订阅宿主的 `llm/adapters-updated` 事件，拓扑变化时用 `handle.replace()` 同步
    edu 侧路由，并刷新 `config.providers` 与默认路由 / 模型 —— 冷启动竞态与运行期
    热插拔都能正确传播；
  - 从宿主的 `agentDefaultModel` 解析默认 provider / model（等待上限 2s）；
  - 宿主拥有真实凭据与端点，故 `degradedProviders` 是**空集**。

## 4. 协议翻译

`DshHostLlmAdapter` 在两侧协议间做双向翻译（`dsh-host.ts` 头部注释中的「协议翻译」段）：

- **内容块**：`text` / `reasoning` / `tool-call` / `tool-result` 双向映射；
  `tool-call.id` 在写入 DSH 侧时提升为 branded `CallId`；edu 无对应槽位的块
  （如 image）在转换中丢弃。
- **消息**：`system` 消息以 `{ kind: 'plugin', plugin: 'openteach' }` 为来源标记，
  便于 DSH 溯源展示。
- **流式**：`StreamChunk` 保持 DSH 的 chunk 协议 —— `text-delta`、`reasoning-delta`、
  `tool-call-delta`、`usage`、`finish`。

> 说明：DSH 侧的 `RequestMessage.content` 被收窄为纯字符串，并省略
> `toolHistory` / `reasoningEffort` / `purpose` 等字段 —— 这是 MVP 阶段的有意简化。

## 5. 独立运行时的回落

无 dsh 内核时（本包单独安装运行），按以下优先级解析 provider 配置：

1. `config.llm`（宿主显式传入）
2. `config.llmConfigPath` → `OPENTEACH_LLM_CONFIG` 指向的 `llm.config.json`
3. 内置默认：`deepseek` 路由（`https://api.deepseek.com/v1`，Key 读 `DEEPSEEK_API_KEY`）

`llm.config.json` 的结构（见 [`OpenTeach/llm.config.json`](../OpenTeach/llm.config.json)）：

```jsonc
{
  "defaultProvider": "doubao",
  "providers": {
    "doubao":   { "api": "openai-completions", "baseURL": "...", "apiKeyEnv": "DOUBAO_LLM_API_KEY", "models": [...] },
    "deepseek": { "api": "openai-completions", "baseURL": "...", "apiKeyEnv": "DEEPSEEK_API_KEY",  "models": [...] },
    "mock":     { "api": "mock", "models": [{ "id": "mock-teacher", ... }] }
  }
}
```

- `api` 取值见 `PROVIDER_APIS`：`openai-completions` | `mock`（适配器在
  `packages/llm/src/adapters/`）。
- **`apiKeyEnv` 只写环境变量名，不落明文 Key**：真实凭据放在
  `OpenTeach/.env.local`（由 `envPath` 指定，按包根目录解析），模板见
  [`OpenTeach/.env.example`](../OpenTeach/.env.example)。
- 跨字段不变量（至少一个 provider、`openai-completions` 必须声明 `baseURL`、
  `defaultProvider` 必须已定义）由 `assertValidConfig` 显式检查。

## 6. mock 降级

**任一 provider 解析不到凭据时，该路由自动降级为内置 mock 适配器**，并记入
`loaded.degradedProviders`。降级是**能力性**的、不报错、不打误导性日志：

- 五步教学闭环（大纲 → 讲解 → 出题 → 作业 → 复习）在没有任何 API Key 时仍可完整跑通；
- `generation` 插件据默认路由是否在 `degradedProviders` 中判定 `source: 'llm' | 'mock'`；
- `classroom` 插件据内核可用性判定 `source: 'dsh' | 'fallback'`。

各服务对外暴露 `available` / `source`，调用方据此感知真实能力还是降级实现。

> 注意：OpenMAIC 核心生成链路（`/api/generate/*`）走的是另一套 provider 解析
> （读 `{PREFIX}_API_KEY` / `{PREFIX}_BASE_URL` / `{PREFIX}_MODELS`），**不经过 mock 降级**，
> 无 Key 时会直接报 `MISSING_API_KEY`。详见 [generation.md](./generation.md)。

## 7. 环境变量速查

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 独立运行时 `deepseek` 路由的凭据 |
| `DOUBAO_LLM_API_KEY` | 独立运行时 `doubao` 路由的凭据 |
| `OPENTEACH_LLM_CONFIG` | `llm.config.json` 的绝对路径（未显式配置 `llmConfigPath` 时生效） |
| `OPENTEACH_ENV_PATH` | `.env.local` 的绝对路径（未显式配置 `envPath` 时生效） |

宿主内运行时以上均**不生效**（除供 openmaic-core 使用的 provider 变量外），
因为模型能力完全来自 dsh。
