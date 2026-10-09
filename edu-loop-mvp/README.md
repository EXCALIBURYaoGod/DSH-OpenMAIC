# 教学闭环 MVP（edu-loop-mvp）

基于《DSH 与教育及 OpenMAIC 新版本-深度研究报告》落地的**可本地运行的最小全栈应用**。
它专门补齐报告中指出的缺口——**闭环后半段（复习 + 评估）**，并把整条链路串成可演示的闭环：

> 主题/资料 → 结构化课程 → 逐课讲解 → 测验判分 → 间隔重复复习 → 评估量规

---

## 1. 技术栈与关键设计

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router（`<script setup lang="ts">`） |
| 后端 | Node + Express + SSE（Server-Sent Events） |
| 存储 | `node:sqlite`（Node 内置，零原生依赖，无需编译） |
| 包管理 | pnpm workspace（`server` + `web`） |

### LLM 接入：模仿 DeepSeek Harness 的 LLM loader

参考 DSH 的分层契约，做成**配置驱动**而非硬编码单一模型：

1. **Provider profile**（`llm.config.json`）——`apiKeyEnv` 只引用环境变量名，不落明文；
2. **适配器注册表**（`server/src/llm/registry.ts`）——`registerAdapter()` 返回可 `replace()` 的句柄，重复注册全有或全无；
3. **统一流式协议 StreamChunk**——`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`，与 DSH 语义一致。

当前的适配器实现：

- `openai-compat`：任意 OpenAI 兼容端点（默认指向 DeepSeek）；
- `mock`：**确定性本地适配器**。未解析到凭据时自动启用并标记 `degraded`，保证**没有任何 API Key 也能完整跑通五步闭环**。

因此「新增一个自定义 LLM 端点」只需要改 `llm.config.json`，不改代码。

---

## 2. 环境要求

- **Node ≥ 22.5**（`node:sqlite` 为内置模块；已验证于 Node 26）
- **pnpm**（仓库锁定 `pnpm@12.4.2`）

---

## 3. 本地启动

### 3.1 安装依赖

```bash
pnpm install
```

### 3.2 零配置启动（推荐先跑这个）

不需要任何 API Key：

```bash
pnpm dev
```

- 前端：<http://localhost:5173>（`/api` 已代理到后端 8787）
- 后端：<http://localhost:8787>

启动后前端右上角会出现「**本地降级**」标签，表示当前用内置 mock 适配器，输出为确定性示例内容。此时五步闭环可完整走通。

### 3.3 接入真实模型（可选）

```bash
# macOS / Linux
cp .env.example .env
# Windows PowerShell
Copy-Item .env.example .env

# 然后编辑 .env，填入 DEEPSEEK_API_KEY=sk-xxx
```

重启后端即可。凭据解析成功时不再降级，标签会变为「**真实模型**」。

若要接入自定义 OpenAI 兼容网关，在 `llm.config.json` 里新增一个 provider，把 `apiKeyEnv` 指向 `.env` 中新增的变量名即可，例如：

```json
{
  "defaultProvider": "my-gateway",
  "providers": {
    "my-gateway": {
      "api": "openai-completions",
      "baseURL": "https://your-gateway.example.com/v1",
      "apiKeyEnv": "MY_GATEWAY_API_KEY",
      "displayName": "我的网关",
      "models": [{ "id": "my-model", "name": "My Model" }]
    }
  }
}
```

### 3.4 生产单端口模式

```bash
pnpm build
pnpm --filter @edu-loop/server run start
```

构建产物由后端静态托管，访问 <http://localhost:8787> 即可，无需再开前端 dev server。

---

## 4. 五步闭环操作指南

左侧边栏即为五个步骤，点一下即可切换（页内路由，不会整页刷新）。

| 步骤 | 页面 | 做什么 |
| --- | --- | --- |
| 1 | 生成课程 | 填主题（可选填参考资料）→「生成结构化课程」，流式输出课程大纲与课次 |
| 2 | 结构化讲解 | 选一个课次 →「生成讲解」，得到 markdown 讲解正文 |
| 3 | 测验 | 「生成题目」→ 作答 → 提交，得到判分反馈；错题自动进入复习队列 |
| 4 | 间隔重复 | 查看到期题目 → 点 0–5 分档位完成复习，间隔按简化 SM-2 重新计算 |
| 5 | 评估量规 | 「生成评估量规」→「依据学习证据评估」，得到各维度得分、总分、等级与建议 |

顶部选择器可切换 provider / 模型 / 历史课程。

> 说明：课程状态保存在前端内存中。**刷新页面后**请用右上角「选择课程」下拉框重新选中已有课程，它会从后端把讲解、题目、复习、量规全部加载回来。

---

## 5. 数据与调试

- 数据库文件：`server/data/edu-loop.db`（首次启动自动建表，共 8 张表）
- 健康检查：`GET /api/health`
- provider 目录：`GET /api/llm/providers`
- **调用审计**：`GET /api/llm/calls` —— 每次 LLM 调用都会落 `llm_call_logs`，含 `task`、`promptChars`、`inputTokens` / `outputTokens`、`latencyMs`、`status`。

---

## 6. 目录结构

```
edu-loop-mvp/
├─ llm.config.json          # provider profile（模型接入的唯一开关）
├─ .env.example             # 凭据模板
└─ server/                  # 仅后端：加载 OpenTeach bundle 并启动 HTTP 服务
   └─ src/
      └─ index.ts           # 入口：组装 OpenTeach 各模块插件 → app.listen
```

> 教学闭环后端与各模块插件已迁至 `OpenTeach/`（可安装的 DSH 插件 `@openteach/bundle`）；
> 前端已拆为独立包 `OpenTeach-frontend/`（`@openteach/frontend`，直接移植自 OpenMAIC 前端，
> 通过 `OPENTEACH_API_BASE` 把 `/api/*` 代理到本后端）。

---

## 7. 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动后端（开发） |
| `pnpm dev:server` | 单独启动后端 |
| `pnpm build` | 构建后端 |
| `pnpm typecheck` | 全量类型检查 |