# 多智能体互动课堂

## 1. 职责划分

课堂领域逻辑落在 `openmaic:classroom` 插件
（[`packages/classroom/`](../OpenTeach/packages/classroom)），其**下方的编排内核由 DSH 承担**：

| 层 | 承担者 | 内容 |
| --- | --- | --- |
| 领域层 | `openmaic:classroom` | Director 提示词、课堂工具语义、课堂动作、结构化解析、事件契约 |
| 编排内核 | DSH | `ctx.agents`（AgentRegistry，`dsh-agent-loop` 实现工厂）创建 Director 与子智能体；`ctx.llm`（DSH `LlmRuntime`）作为模型出口 |
| 模型出口 | `eduLlm` | 经 `DshHostLlmAdapter` 反向适配宿主（见 [llm.md](./llm.md)） |

服务契约：`provide = 'openmaic.classroom'`，`inject = ['eduLlm', 'llm', 'agents']`。

## 2. Director 与子智能体

一轮会话（对齐 OpenMAIC 的 `statelessGenerate`）的流程：

```
runSession(input)
 ├─ 组装角色 / 场景 / 白板运行态 → ClassroomToolRuntime
 ├─ 经 ctx.agents 建 Director 智能体
 │    系统提示词 = buildDirectorPrompt(...)（complete: true，成为唯一 section）
 │    注册工具：read_scene / call_agent / cue_user / close_session
 ├─ Director 调用 call_agent → delegateAgent 委派子智能体
 │    子智能体流式产出文本（text_delta）与动作（action）
 ├─ 以唯一终态工具收束（cue_user 或 close_session）
 └─ 产出 done（含 totalActions / totalAgents / endReason）
```

**关键约束**：`cue_user` 与 `close_session` 是**唯一终态工具**，二者互斥
（`userCued` / `sessionClosed` 标记保证只生效一次）。这是 OpenMAIC 原实现的策略，
移植时提示词正文（终态工具策略、路由规则、输出格式契约、角色与长度规范）**保持原样**，
以保证行为一致。

**无状态化**：后端不持有跨轮状态，`directorState`（turnCount / agentResponses /
whiteboardLedger）由客户端持有并在每轮请求回传。`AgentTurnSummary` 与
`WhiteboardActionRecord` 即是其元素类型。

## 3. 内置角色注册表

[`packages/classroom/src/registry.ts`](../OpenTeach/packages/classroom/src/registry.ts)
的 `DEFAULT_CLASSROOM_AGENTS` 定义 6 个内置角色（persona 正文按 OpenMAIC 原文移植，注释为中文）：

| id | 名称 | role | priority | 允许动作 | 定位 |
| --- | --- | --- | --- | --- | --- |
| `default-1` | AI teacher | teacher | **10** | 幻灯片动作 + 白板动作 | 主讲：控制课程节奏、幻灯片与视觉引导 |
| `default-2` | AI助教 | assistant | 7 | 仅白板 | 补充解释、换角度重述、举例、小结；**不接管课堂** |
| `default-3` | 显眼包 | student | 4 | 仅白板 | 活跃气氛；短平快的幽默反应与类比 |
| `default-4` | 好奇宝宝 | student | 5 | 仅白板 | 追问 why / how，逼出更深的讲解 |
| `default-5` | 笔记员 | student | 5 | 仅白板 | 结构化速记与复述，用白板写要点 |
| `default-6` | 思考者 | student | 6 | 仅白板 | 跨领域连接、质疑假设，推动讨论深度 |

**权限模型**（[`types.ts`](../OpenTeach/packages/classroom/src/types.ts)）：

```ts
WHITEBOARD_ACTIONS = [wb_open, wb_close, wb_draw_text, wb_draw_shape, wb_draw_chart,
                      wb_draw_latex, wb_draw_table, wb_draw_line, wb_draw_code,
                      wb_edit_code, wb_clear, wb_delete]
SLIDE_ACTIONS      = [spotlight, laser, play_video]        // 教师专属视觉引导

ROLE_ACTIONS = {
  teacher:   [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
  assistant: [...WHITEBOARD_ACTIONS],
  student:   [...WHITEBOARD_ACTIONS],
}
```

每个动作的文本描述由 `getActionDescriptions()` 生成，注入子智能体提示词
（移植自 OpenMAIC `tool-schemas.ts`），从而让模型知道动作的**参数契约**与
**使用时机**（例如 `wb_close` 明确要求「不要仅因自己画完就关闭」）。

> **priority 的作用**：它是 Director 选择发言人的**参考**，不是接口直控。
> 真正的调度由 Director LLM 通过 `call_agent` 决定。

## 4. Director 提示词与路由

[`packages/classroom/src/prompts.ts`](../OpenTeach/packages/classroom/src/prompts.ts)
移植 `lib/chat/pi/prompts.ts` 与 `lib/orchestration/summarizers/*` 的关键片段，
产出三类提示词：

| 函数 | 对象 | 内容 |
| --- | --- | --- |
| `buildDirectorPrompt` | Director | 决定谁发言、调用 `call_agent`，以唯一终态工具收束 |
| `buildChildPrompt` | 子智能体系统提示 | 人格（persona）、角色规范、长度与输出格式契约 |
| `buildChildTurnPrompt` | `call_agent` 派发的指令 | 场景证据 + **硬性字数上限** |

数据来源的差异：OpenMAIC 用 `StatelessChatRequest`（UIMessage / Stage）adapt；
本项目改为轻量上下文 `DirectorPromptContext` / `ChildPromptContext`。
提示词**正文**保持原样移植。

长度规范是硬性约束（教师 ≈70 字 / 助教 ≈60 字 / 学生 ≈40 字，`getChildHardCap`），
避免子智能体长篇大论。同伴上下文（`buildPeerContextSection`）会明确要求
「不要重复他们的点，要补充新角度」。

## 5. 事件契约与 SSE 续传

课堂事件是一个 discriminated union（`ClassroomEvent`）：

| type | 载荷要点 |
| --- | --- |
| `agent_start` | `{ messageId, agentId, agentName, agentAvatar?, agentColor? }` |
| `text_delta` | `{ content, messageId? }` |
| `action` | `{ actionId, actionName, params, agentId, messageId? }` |
| `agent_end` | `{ messageId, agentId }` |
| `cue_user` | `{ fromAgentId?, prompt? }` |
| `done` | `ClassroomSummary`（totalActions / totalAgents / endReason…） |
| `error` | `{ message }` |

每条事件包在 `ClassroomEventEnvelope` 里，带 `sessionId` 与**会话内单调自增 `seq`**
（从 1 开始）。`seq` 直接用作 SSE 的 event id，因此客户端可用
`Last-Event-ID` 做**断点续传**，无需依赖内存游标 —— `getSessionEvents(sessionId, afterSeq)`
即按此语义过滤。

实现上，`runSession()` 是一个 `AsyncGenerator`：工具执行与子智能体会话回调把事件
写入队列并 `wake` 唤醒生成器，生成器并发排出并逐条 `yield` 给 SSE 层。整个
Director 编排作为**一个异步任务**并发运行，结束时 `markFinished` 兜底。

## 6. 持久化与降级

**存储**（可降级）：

- 运行时权威源是进程内 `Map`（`events` / `sessions`）；
- `repo` 可用时**尽力同步落库**（`tryPersist`）：事件 → `classroom_events`（动作同时写
  `whiteboard_elements`）、会话 → `classroom_sessions`、角色 → `agents` 表；失败仅告警一次
  并继续走内存，**不阻断课堂**；
- 读取路径：内存未命中（如进程重启后）再回退到 SQLite 事件流。

**角色注册表**：`repo` 可用时用 SQLite `agents` 表（`createSqliteAgentRegistry`），
否则用内存版（`createClassroomAgentRegistry`），接口一致。

**上下文压缩**：`compaction.ts` 按 provider / model 的 `contextWindow` 判定，
在安全边界（本步已空闲、会话无打开 turn）时用一段课堂取向的摘要替换较早的 surface
节点，控制下一轮请求体量，并可经 `getCompactionTrace()` 诊断。

**降级**：

- 内核不可用 → `source: 'fallback'`，`emitFallbackAgentTurn` 产出**确定性的教师发言**
  （「已就绪：配置模型凭据后即可开启多智能体互动课堂」），保证课堂界面可渲染；
- 内核可用但 mock 未产生任何发言 → 同样走该兜底；
- 无论哪条路径，最后都会补一个 `cue_user` 或 `done` 收束，避免会话悬挂。

## 7. HTTP 接口

课堂与角色相关接口由 `http` 插件挂载（[`routes/classroom.ts`](../OpenTeach/packages/http/src/http/routes/classroom.ts)）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/classroom/sessions` | 运行一轮课堂会话 |
| `GET` | `/api/classroom/sessions` | 列出会话元信息 |
| `POST` | `/api/classroom/chat` | SSE 流式对话（下发上述事件） |
| `GET` | `/api/classroom/sessions/:id/events` | 读取事件（`afterSeq` 优先，配 `Last-Event-ID` 续传） |
| `GET` | `/api/classroom/:courseId/scenes` | 取某课程的场景快照 |
| `GET` | `/api/classroom/compaction` | 上下文压缩诊断 |
| `GET` / `POST` | `/api/agents` | 角色列表 / 新建 |
| `DELETE` | `/api/agents/:id` | 删除角色 |

> 这些路由与 openmaic-core 移植的 `/api/classroom` 是**两条并行的入口**：
> 前者服务 OpenTeach 自有的课堂编排，后者服务 OpenMAIC 核心链路的课堂容器。
> 分发器对 `/api/classroom` 无动态段，只有精确匹配 `/api/classroom` 才会命中核心路由，
> `/api/classroom/sessions` 等由 Express 路由处理。
