# edu-loop-mvp Code Wiki

> 教学闭环 MVP（edu-loop-mvp）的代码级 Wiki。覆盖范围：**仅 `edu-loop-mvp/` 这一个仓库**
> （即 pnpm workspace 下的 `server` + `web` 两个包），不包含同级的 OpenMAIC 等其它代码库。

## 这是什么项目

一个可本地零配置跑通的**最小全栈教学应用**，把「主题/资料 → 结构化课程 → 逐课讲解 → 测验判分
→ 间隔重复复习 → 评估量规」串成一条可演示的闭环。设计上刻意模仿 DeepSeek Harness（DSH）的
**「配置驱动 provider + 适配器注册表 + 流式分片协议」**，并用 Cordis 原生内核做插件装配。

## Wiki 目录

| 文档 | 内容 |
| --- | --- |
| [01-overview.md](./01-overview.md) | 项目定位、整体架构、五步闭环数据流、技术栈 |
| [02-server-bootstrap.md](./02-server-bootstrap.md) | 后端插件化装配与启动流程（Cordis 内核、插件拓扑、app/context/config） |
| [03-llm-layer.md](./03-llm-layer.md) | LLM 抽象层：契约类型、provider 配置、适配器注册表、loader、内置适配器 |
| [04-data-layer.md](./04-data-layer.md) | 数据层：`node:sqlite` 封装、schema、Repository |
| [05-teaching-domain.md](./05-teaching-domain.md) | 教学领域模块：提示词、JSON 提取、结果归一化、SM-2 调度、LLM 调用层 |
| [06-http-api.md](./06-http-api.md) | HTTP 接口与 SSE 协议：全部路由端点与事件序列 |
| [07-openmaic-plugins.md](./07-openmaic-plugins.md) | OpenMAIC 集成插件（slide/layout/storage/generation/tts-asr） |
| [08-eval-judge.md](./08-eval-judge.md) | 评测中心：LLM Judge 指标、判分流程、评测运行 |
| [09-frontend.md](./09-frontend.md) | 前端 Web 应用：路由、Pinia store、API 客户端、视图组件 |
| [10-dependencies.md](./10-dependencies.md) | 依赖关系：包依赖、插件依赖图、模块依赖矩阵 |
| [11-run-and-deploy.md](./11-run-and-deploy.md) | 项目运行方式：安装、开发、生产、环境变量、调试 |

## 快速索引：关键文件

| 关注点 | 文件 |
| --- | --- |
| 服务入口 | [server/src/index.ts](file:///workspace/edu-loop-mvp/server/src/index.ts) |
| Express 装配 | [server/src/app.ts](file:///workspace/edu-loop-mvp/server/src/app.ts) |
| LLM 契约 | [server/src/llm/types.ts](file:///workspace/edu-loop-mvp/server/src/llm/types.ts) |
| 适配器注册表 | [server/src/llm/registry.ts](file:///workspace/edu-loop-mvp/server/src/llm/registry.ts) |
| provider 配置 | [llm.config.json](file:///workspace/edu-loop-mvp/llm.config.json) |
| 数据库 schema | [server/src/db/index.ts](file:///workspace/edu-loop-mvp/server/src/db/index.ts) |
| 数据访问 | [server/src/db/repo.ts](file:///workspace/edu-loop-mvp/server/src/db/repo.ts) |
| 提示词 | [server/src/teaching/prompts.ts](file:///workspace/edu-loop-mvp/server/src/teaching/prompts.ts) |
| SM-2 调度 | [server/src/teaching/srs.ts](file:///workspace/edu-loop-mvp/server/src/teaching/srs.ts) |
| LLM Judge | [server/src/eval/judge.ts](file:///workspace/edu-loop-mvp/server/src/eval/judge.ts) |
| 前端状态 | [web/src/stores/course.ts](file:///workspace/edu-loop-mvp/web/src/stores/course.ts) |
| 前端 API 客户端 | [web/src/api/client.ts](file:///workspace/edu-loop-mvp/web/src/api/client.ts) |

## 阅读顺序建议

1. 先读 [01-overview.md](./01-overview.md) 建立全局认知；
2. 后端读者按 02 → 03 → 04 → 05 → 06 → 07 → 08 顺序；
3. 前端读者读 09；
4. 环境搭建看 11，架构约束看 10。