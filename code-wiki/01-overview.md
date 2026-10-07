# 01 · 项目概览与整体架构

## 1. 项目定位

`edu-loop-mvp` 是一个**可本地零配置运行的最小全栈教学应用**。它把一份深度研究报告
（《DSH 与教育及 OpenMAIC 新版本-深度研究报告》）指出的缺口——**教学闭环的后半段
（复习 + 评估）**——补全成一条端到端可演示的链路：

```
主题/资料 → 结构化课程 → 逐课讲解 → 测验判分 → 间隔重复复习 → 评估量规
```

两条贯穿全项目的设计红线：

1. **无 Key 也能完整跑通。** 任何外部依赖（LLM、OpenMAIC dsl）解析不到时都降级为确定性
   本地实现，`degraded` 状态对外可见，闭环不中断。
2. **一切皆插件、配置驱动。** 新增 LLM 端点 / 新能力只需改配置或加插件，不改业务代码。

## 2. 仓库结构

本 Wiki 覆盖 `edu-loop-mvp/` 仓库，其为 pnpm workspace（`pnpm-workspace.yaml` 定义 `server` + `web`）：

```
edu-loop-mvp/
├─ llm.config.json          # provider profile：模型接入的唯一开关
├─ .env.example             # 凭据模板（只放 key，不放端点/模型）
├─ package.json             # workspace 根脚本（dev / build / typecheck）
├─ pnpm-workspace.yaml      # packages: server, web
├─ server/                  # 后端（Node + Express + SSE + node:sqlite）
│  ├─ src/
│  │  ├─ config/            # .env 读取、运行模式解析
│  │  ├─ llm/               # DSH 风格 LLM 层：types/config/registry/loader + adapters
│  │  ├─ db/                # node:sqlite 封装、schema、Repository
│  │  ├─ teaching/          # 提示词、JSON 提取、归一化、SRS、LLM 调用层
│  │  ├─ eval/              # LLM Judge：指标定义与判分
│  │  ├─ http/              # Express plugin、SSE、routes/
│  │  ├─ plugins/           # openmaic-* 集成插件
│  │  ├─ app.ts / context.ts / index.ts
│  ├─ scripts/              # smoke 脚本（历史遗留，见 §6）
│  └─ tests/                # node:test 内核装配测试
└─ web/                     # 前端（Vue 3 + Vite + Element Plus + Pinia）
   └─ src/
      ├─ api/               # 类型 + fetch/SSE 客户端
      ├─ stores/            # Pinia：llm / course / system
      ├─ views/             # 六个页面（五步 + 评测中心）
      ├─ components/        # MarkdownView / SlidePreview
      ├─ utils/markdown.ts  # 白名单 Markdown 渲染（防 XSS）
      ├─ router/            # 路由与步骤定义
      └─ main.ts / App.vue / styles.css
```

## 3. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | Vue 3 + TypeScript + Vite | `<script setup lang="ts">`，Element Plus UI |
| 前端状态 | Pinia | `llm` / `course` / `system` 三个 store |
| 前端路由 | Vue Router | 六条页面路由，含模式守卫 |
| 后端 | Node + Express 4 | 仅提供 JSON API 与 SSE |
| 后端内核 | `@deepseek-ai/cordis` | 插件装配、服务注册、依赖门控 |
| 配置校验 | `@deepseek-ai/schemastery` | 插件 `Config` 的 Standard Schema |
| 存储 | `node:sqlite`（Node 内置） | 零原生依赖，无需编译 |
| 包管理 | pnpm workspace | 锁定 `pnpm@12.4.2` |
| 流式传输 | SSE（Server-Sent Events） | 单向文本流，前端 fetch + ReadableStream 解析 |

运行环境要求 **Node ≥ 22.5**（`node:sqlite` 为内置模块）。

## 4. 整体架构

系统分为三层：**前端 SPA → Express API/SSE → 领域服务（LLM / 数据 / 教学 / 评测 / OpenMAIC）**，
领域服务全部通过 Cordis 内核以插件形式装配。

```
┌─────────────────────────────────────────────────────────────┐
│                       浏览器（web/）                          │
│  App.vue 侧边步骤条 + 顶部 provider/model/课程选择器           │
│  views/* 五步页面 + 评测中心                                   │
│  stores/course.ts ── api/client.ts（fetch / postSse）         │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP (JSON) + POST SSE
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express（server/src/app.ts）               │
│  /api/health  /api/plugins  /api/llm  /api/courses            │
│  /api/quiz    /api/review   /api/rubric /api/eval  /api/slides│
│  生产模式：静态托管 web/dist（单端口）                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ AppContext { runtime, repo, llm, slide }
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Cordis 内核（root = new Context()）              │
│                                                              │
│  llm  ─►  LlmRuntime（适配器注册表 + 流式调用）                │
│  db/repo ─► node:sqlite 连接 + Repository                     │
│  openmaic.layout  ─► 四点式 PPT 布局生成器                     │
│  openmaic.slide   ─► 要点 → SlideDeck JSON                    │
│  openmaic.storage ─► kv.store / docs.store（同库落地）         │
│  openmaic.generation ─► 两阶段生成（outline → scene）          │
│  openmaic.tts/asr ─► 语音 provider 注册表                      │
│  app ─► Express 实例                                          │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 装配顺序与依赖

`server/src/index.ts` 中的装配顺序为 **llm → db → openmaic\* → http**，因为 http 依赖 llm/repo，
openmaic 插件依赖 llm/db/repo。Cordis 的 `inject` 声明保证依赖未满足时插件不会提前执行
（详见 [02-server-bootstrap.md](./02-server-bootstrap.md)）。

### 4.2 请求上下文

每个 HTTP 请求在路由层通过 `resolveRoute()` 解析出 `{ provider, model, degraded }`，
再用 `taskContext()` 组装成 `LlmTaskContext`，交给 `runLlm()` 执行。这样 provider 选择
（默认值、未注册校验、降级标记）与业务逻辑解耦。

### 4.3 数据流：一次完整闭环

以「生成课程 → 讲解 → 测验 → 复习 → 量规」为例：

1. **生成课程**（`POST /api/courses`，SSE）：`course_outline` 提示词 → LLM 流式输出 JSON
   → `normalizeOutline` 归一化 → 落 `courses` + `lessons` 表 → 事件 `outline` 回传。
2. **结构化讲解**（`POST /api/courses/:id/lessons/:lessonId/explain`，SSE）：`lesson_explain`
   提示词 → Markdown 正文 → 写入 `lessons.explanation`。
3. **测验**（`POST /api/quiz/courses/:courseId/generate`）：`quiz_generate` → 题目落
   `questions` 表，并同时为每题写入 `reviews` 初始调度（`due_at = now`）。
   作答（`POST /api/quiz/questions/:questionId/attempt`）：`quiz_grade` 判分 → 落 `attempts`
   → 按 SM-2 更新 `reviews`。
4. **间隔重复**（`GET /api/review/courses/:courseId/due` + `POST /api/review/questions/:id/review`）：
   `schedule()` 重算 ease / interval / dueAt。
5. **评估量规**（`POST /api/rubric/courses/:courseId/generate` 与 `/evaluate`）：生成量规
   维度并依据测验证据评分，落 `rubrics` + `rubric_evaluations`。
6. **评测中心**（`POST /api/eval/courses/:courseId/run`，仅开发模式）：LLM Judge 对上述
   教学产物打分，落 `eval_runs`。

## 5. 核心设计模式

| 模式 | 体现 |
| --- | --- |
| **插件化内核** | 每个能力 = 一个 Cordis 插件（命名导出 `name`/`provide`/`inject`/`Config`/`apply`） |
| **配置驱动** | `llm.config.json` 描述 provider profile；`apiKeyEnv` 只引用环境变量名 |
| **降级哲学** | 无凭据 → mock 适配器；无 `@openmaic/dsl` → 内置生成器；判分失败 → 启发式判据 |
| **契约对齐** | `types.ts` 刻意对齐 DSH 的适配器契约；openmaic 插件对齐 `@openmaic/*` 契约子集 |
| **防御式解析** | 模型输出经 `extractJson` + `normalize*` 双保险后才落库 |
| **SSE 单向流** | 教学是一问一答的流式文本，SSE 足够且无额外依赖 |

## 6. 已知历史遗留

`server/scripts/*.mts`（audio/generation/slide/storage smoke）**引用了已不存在的
`../src/core/kernel.js` 与 `openmaic*Plugin` 旧 API**，属于改用 Cordis 原生内核之前的历史文件，
当前不可直接运行。当前可用的自动化验证是 `server/tests/core.kernel.spec.ts`（`node:test`）。
`package.json` 中未注册这些 smoke 脚本，因此不影响正常构建与运行。

## 7. 相关文档

- 后端装配细节：[02-server-bootstrap.md](./02-server-bootstrap.md)
- 依赖全景：[10-dependencies.md](./10-dependencies.md)
- 运行方式：[11-run-and-deploy.md](./11-run-and-deploy.md)