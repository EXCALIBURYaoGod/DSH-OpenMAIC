# 10 · 依赖关系

本篇汇总三层依赖：**包（npm）依赖**、**Cordis 插件依赖图**、**模块依赖矩阵**。

## 1. 包依赖

### 根 `package.json`（workspace）

| 字段 | 值 |
| --- | --- |
| `packageManager` | `pnpm@12.4.2` |
| scripts | `dev`（并行）、`dev:server` / `dev:web`、`build`、`start`、`prod`、`typecheck` |

### `server`（`@edu-loop/server`）

| 类型 | 包 | 用途 |
| --- | --- | --- |
| dependency | `@deepseek-ai/cordis` ^4.0.4 | 插件内核 |
| dependency | `@deepseek-ai/schemastery` ^3.18.4 | 插件 Config 的 Standard Schema |
| dependency | `@openmaic/dsl`（`file:../../OpenMAIC/...`） | slide 真机能力（本地路径依赖） |
| dependency | `cors` ^2.8.5 | 开发模式跨域 |
| dependency | `express` ^4.21.2 | HTTP 框架 |
| devDependency | `@types/cors` / `@types/express` / `@types/node` | 类型 |
| devDependency | `tsx` ^4.19.2 | 开发运行时（`tsx watch`） |
| devDependency | `typescript` ^5.7.2 | 编译 |

> `@openmaic/dsl` 是**本地路径依赖**（指向同级 `OpenMAIC` 仓库），因此它不参与 npm 安装；
> 若该目录不存在，`openmaic-slide` 的 `tryLoadOpenmaic` 会失败并降级为内置生成器，不影响运行。

### `web`（`@edu-loop/web`）

| 分组 | 包 | 用途 |
| --- | --- | --- |
| 框架 | `vue` ^3.5.13、`vue-router` ^4.5.0、`pinia` ^2.3.0 | SPA / 路由 / 状态 |
| UI | `element-plus` ^2.9.1 | 组件库（含 zh-cn locale） |
| React 桥接 | `react` / `react-dom` ^18.3.1 | SlidePreview 渲染 openmaic renderer |
| 图表/渲染 | `echarts` ^5.6.0、`html-to-image`、`html2canvas-pro`、`shiki` | openmaic renderer 依赖 |
| 展示 | `katex` ^0.16.33、`lucide-react`、`motion`、`clsx`、`tailwind-merge`、`tinycolor2` | renderer 生态 |
| 构建 | `vite` ^6.0.5、`@vitejs/plugin-vue`、`@vitejs/plugin-react`、`vue-tsc`、`typescript` | 构建与类型 |

> web 的许多依赖（react / echarts / shiki / motion 等）是**为编译 OpenMAIC renderer 源码而引入**的
> 运行时垫片，见 `vite.config.ts` 的 alias 设计。

## 2. Cordis 插件依赖图

`inject` 声明决定加载顺序；`provide` 声明服务名。

```
llm ──────────────► 提供 llm (LoadedLlm)
db  ──────────────► 提供 db (SqliteDatabase) / repo (Repository)

openmaic:storage   inject [db]        → 提供 kv.store / docs.store
openmaic:generation inject [llm]      → 提供 openmaic.generation
openmaic:layout    （无 inject）       → 提供 openmaic.layout
openmaic:slide     inject [llm, repo] → 提供 openmaic.slide   （优先消费 openmaic.layout）
openmaic:audio     （无 inject）       → 提供 openmaic.tts / openmaic.asr

edu-loop:http      inject [llm, repo] → 提供 app（最后装配，读取 openmaic.slide 可选）
```

- 带 `inject` 的插件在依赖出现前不会执行 `apply`，出现后自动加载——这由 Cordis 原生行为保证；
- **装配顺序**（`index.ts`）：`llm → db → storage → generation → layout → slide → audio → http`；
- http 必须最后，因为 `index.ts` 在 `app.listen` 前需要 `root.get('app')` 与 `root.get('llm')`。

### 服务 → 消费方对照

| 服务 | 提供者 | 消费方 |
| --- | --- | --- |
| `llm` | llm 插件 | http、generation、slide |
| `db` / `repo` | db 插件 | storage、slide、http |
| `openmaic.layout` | layout 插件 | slide（`ctx.get`） |
| `openmaic.slide` | slide 插件 | http（`/api/slides`）、`AppContext.slide` |
| `kv.store` / `docs.store` | storage 插件 | 对外契约出口（当前无内部消费方） |
| `openmaic.generation` / `openmaic.tts` / `openmaic.asr` | generation / audio 插件 | 对外契约出口 |
| `app` | http 插件 | index.ts 取回并 listen |

## 3. 服务端模块依赖矩阵

| 模块 | 依赖 | 被依赖 |
| --- | --- | --- |
| `config/env` | 无 | llm/loader、openmaic-tts-asr |
| `config/mode` | 无 | index |
| `llm/types` | 无 | llm 全部 |
| `llm/config` | 无 | llm/loader、llm/plugin、index |
| `llm/errors` | llm/types | llm/registry、adapters |
| `llm/registry` | errors、types | llm/loader、teaching/llm、openmaic-generation |
| `llm/loader` | config/env、registry、adapters | llm/plugin |
| `llm/adapters/*` | registry、types、errors（openai-compat 另用 adapters/sse） | llm/loader |
| `db/sqlite` | node:sqlite | db/index、openmaic-storage |
| `db/index` | db/sqlite | db/plugin |
| `db/repo` | db/sqlite | 所有 routes、teaching/llm、eval/judge、context |
| `teaching/prompts` | 无 | routes/course、routes/quiz、routes/rubric |
| `teaching/json` | 无 | routes/*、eval/judge、openmaic-generation |
| `teaching/normalize` | db/repo（类型） | routes/course、routes/quiz、routes/rubric |
| `teaching/srs` | 无 | routes/quiz、routes/review |
| `teaching/llm` | llm/registry、llm/types、db/repo | routes/*、eval/judge |
| `eval/metrics` | 无 | eval/judge、routes/eval |
| `eval/judge` | teaching/json、teaching/llm、db/repo、eval/metrics | routes/eval |
| `context` | llm/loader、llm/registry、db/repo、teaching/llm、openmaic-slide | routes/*、app |
| `http/sse` | express（类型） | routes/* |
| `http/routes/*` | context、teaching/*、db/repo、eval/* | app |
| `http/plugin` | app、context、config/mode | index |
| `app` | http/routes/*、config/mode、context | http/plugin |
| `index` | config/*、llm/*、db/*、http/*、plugins/* | 入口 |

**无循环依赖**；`teaching/*` 与 `llm/*` 是领域/基础设施分层的关键边界——路由层不直连适配器，
只通过 `teaching/llm` 与 `context` 间接使用。

## 4. 前端模块依赖

| 模块 | 依赖 |
| --- | --- |
| `api/client` | 浏览器 fetch |
| `api/types` | 无（与后端 `db/repo` 类型手工对齐） |
| `stores/system` | api/client、api/types |
| `stores/llm` | api/client、api/types |
| `stores/course` | api/client、api/types |
| `views/*` | stores/*、components/*、utils/markdown |
| `components/MarkdownView` | utils/markdown |
| `components/SlidePreview` | api/types + `@openmaic/renderer`（经 vite alias） |
| `router` | 视图（懒加载） |
| `main` / `App.vue` | router、stores/* |

## 5. 外部系统依赖清单

| 外部系统 | 是否必需 | 缺失时 |
| --- | --- | --- |
| Node ≥ 22.5 | **必需** | 无 `node:sqlite`，无法启动 |
| pnpm | 必需（构建/安装） | - |
| LLM 端点（DeepSeek / 火山方舟等） | 可选 | 自动降级为 mock 适配器 |
| `OpenMAIC/` 本地目录 | 可选 | slide 降级为内置生成器；`@openmaic/renderer` alias 失效但可构建 |
| `OPENAI_API_KEY` | 可选 | audio 仅开放 browser-native 桩 |

下一篇：[11-run-and-deploy.md](./11-run-and-deploy.md)。