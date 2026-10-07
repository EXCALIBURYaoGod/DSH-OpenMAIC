# 11 · 项目运行方式

本篇说明如何安装、开发、构建与部署 `edu-loop-mvp`，并列出全部环境变量、运行模式与常用调试入口。

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node | **≥ 22.5**（已验证于 Node 26） | 数据层依赖内置模块 [`node:sqlite`](file:///workspace/edu-loop-mvp/server/src/db/sqlite.ts)，零原生依赖、无需编译 |
| pnpm | 仓库锁定 `pnpm@12.4.2` | 见根 [package.json](file:///workspace/edu-loop-mvp/package.json) 的 `packageManager` 字段 |
| LLM 端点 | 可选 | 缺失时自动降级为内置 mock 适配器，五步闭环仍可完整跑通 |
| OpenMAIC 源码目录 | 可选 | 缺失时 slide 降级为内置生成器；`@openmaic/renderer` alias 失效但不阻断构建 |

`pnpm-workspace.yaml` 声明两个工作包 `server` 与 `web`，并显式放行 `esbuild` / `vue-demi`
的构建脚本（pnpm 10+ 默认 strictDepBuilds）。

## 2. 安装依赖

```bash
pnpm install
```

> `@edu-loop/server` 对 `@openmaic/dsl` 使用**本地路径依赖**（`file:../../OpenMAIC/...`），
> 不参与 npm 拉取；其失败不会阻断安装。

## 3. 运行模式

模式由 `NODE_ENV` 解析（[config/mode.ts](file:///workspace/edu-loop-mvp/server/src/config/mode.ts)）：

| 模式 | 触发 | 前端 | 后端 | 跨域 |
| --- | --- | --- | --- | --- |
| `development` | 未设置或非 `production` | Vite dev server（5173，HMR + `/api` 代理） | `tsx watch` 跑源码（8787） | 放开（`cors`） |
| `production` | `NODE_ENV=production` | 已构建，由后端单端口静态托管 | `node dist/index.js`（8787） | 同源，无需跨域 |

装配逻辑见 [index.ts](file:///workspace/edu-loop-mvp/server/src/index.ts#L45-L84)：仅生产模式注入
`webDist`；若 `web/dist/index.html` 缺失则只提供 API 并打印告警。

## 4. 本地启动

```bash
# 零配置启动（推荐先跑这个，无需任何 API Key）
pnpm dev
```

- 前端：<http://localhost:5173>（`/api` 代理到后端 8787，见 [vite.config.ts](file:///workspace/edu-loop-mvp/web/vite.config.ts#L39-L48)）
- 后端：<http://localhost:8787>

启动后前端右上角显示「**本地降级**」标签，表示当前走内置 mock 适配器、输出为确定性示例内容。

### 单独启动

```bash
pnpm dev:server   # 只启动后端
pnpm dev:web      # 只启动前端
```

## 5. 接入真实模型

凭据从 **`edu-loop-mvp/.env`** 读取（极简零依赖读取器 [config/env.ts](file:///workspace/edu-loop-mvp/server/src/config/env.ts)，
只支持 `KEY=VALUE`、`#` 注释、去引号，且**不覆盖已存在的进程环境变量**）。

```bash
# macOS / Linux
cp .env.example .env
# Windows PowerShell
Copy-Item .env.example .env
# 然后编辑 .env，填入 DEEPSEEK_API_KEY=sk-xxx
```

重启后端即可，标签由「本地降级」变为「真实模型」。

接入自定义 OpenAI 兼容网关时，只需改 [llm.config.json](file:///workspace/edu-loop-mvp/llm.config.json)（不改代码）：
新增 provider 并把 `apiKeyEnv` 指向 `.env` 里的变量名。

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

## 6. 生产构建与部署

```bash
pnpm build                                     # 类型检查 + 前端构建
pnpm --filter @edu-loop/server run start       # 或 pnpm start
```

构建产物由后端静态托管，单端口访问 <http://localhost:8787>，无需再开前端 dev server。
也可用根脚本一步到位：

```bash
pnpm prod    # 等价于 pnpm run build && pnpm run start
```

### 构建拆解

| 命令 | 实际执行 | 产物 |
| --- | --- | --- |
| `pnpm --filter @edu-loop/web run build` | `vue-tsc --noEmit && vite build --mode production` | `web/dist/` |
| `pnpm --filter @edu-loop/server run build` | `tsc -p tsconfig.build.json` | `server/dist/` |
| `pnpm --filter @edu-loop/server run start` | `NODE_ENV=production node dist/index.js` | - |

## 7. 路径常量

服务入口在启动时固定解析出以下路径（见 [index.ts](file:///workspace/edu-loop-mvp/server/src/index.ts#L28-L34)）：

| 常量 | 路径 | 用途 |
| --- | --- | --- |
| `CONFIG_PATH` | `edu-loop-mvp/llm.config.json` | provider profile |
| `ENV_PATH` | `edu-loop-mvp/.env` | 凭据 |
| `DB_PATH` | `server/data/edu-loop.db` | SQLite 数据文件（首次启动自动建表，共 8 张表） |
| `WEB_DIST` | `web/dist` | 生产模式静态托管目录 |
| `PORT` | 环境变量 `PORT`，默认 `8787` | 后端监听端口 |

## 8. 环境变量清单

| 变量 | 是否必需 | 作用 |
| --- | --- | --- |
| `PORT` | 可选 | 后端端口，默认 `8787` |
| `NODE_ENV` | 可选 | `production` 时进入单端口托管模式 |
| `DEEPSEEK_API_KEY` | 可选 | `llm.config.json` 中 `deepseek` provider 的凭据（`apiKeyEnv` 引用名） |
| `DOUBAO_LLM_API_KEY` | 可选 | `doubao` provider 的凭据（默认 provider） |
| `OPENAI_API_KEY` | 可选 | openmaic-tts-asr 的 `openai-tts` / `openai-whisper` provider 凭据 |

> 约定：**端点地址、模型 id、超时等都在 `llm.config.json` 的 provider profile 里配置**；
> `.env` 只负责凭据，且只被 `.gitignore` 忽略，请勿把真实 key 写进会入库的文件。

## 9. 调试与自检入口

| 入口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/llm/providers` | provider 目录（含降级态） |
| `GET /api/llm/calls` | 调用审计：每次 LLM 调用落 `llm_call_logs`（`task` / `promptChars` / `inputTokens` / `outputTokens` / `latencyMs` / `status`） |

### Provider 降级自检

未解析到凭据时，`llm` 插件加载阶段会把默认路由切到 mock 并标记 `degraded`。
`scripts/*-smoke.mts` 是一组**内核装配级 smoke 脚本**，用真实依赖注入验证插件契约与
「卸载后服务回收」，可在无凭据环境直接运行：

```bash
node --import tsx server/scripts/storage-smoke.mts      # KVStore / DocumentStore
node --import tsx server/scripts/generation-smoke.mts   # 两阶段生成（mock 降级态）
node --import tsx server/scripts/slide-smoke.mts        # 要点 → SlideDeck（真机 / 内置回退）
node --import tsx server/scripts/audio-smoke.mts        # TTS / ASR provider registry 与桩行为
```

## 10. 常用脚本速查

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 安装 workspace 依赖 |
| `pnpm dev` | 并行启动前后端（开发） |
| `pnpm dev:server` / `pnpm dev:web` | 单独启动后端 / 前端 |
| `pnpm build` | 全量构建（前端 `vue-tsc + vite`） |
| `pnpm start` | 生产模式启动后端 |
| `pnpm prod` | 构建 + 生产启动 |
| `pnpm typecheck` | 全量类型检查（前后端） |

---

上一篇：[10-dependencies.md](./10-dependencies.md) · 返回 [目录](./README.md)。