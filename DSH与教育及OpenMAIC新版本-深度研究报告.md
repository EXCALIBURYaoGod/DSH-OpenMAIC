# DeepSeek Harness（DSH）× 教育 × OpenMAIC 新版本：深度研究报告

- 报告日期：2026-09-30
- 研究对象：DeepSeek Harness（DSH）、OpenMAIC、以及二者通过 `dsh-openmaic` 插件的集成
- 目标读者：AI 教育产品与技术决策者（默认按「技术 + 产品并重」撰写）
- 证据标注约定：
  - 【事实】= 有一手来源可核（本地仓库源码 / 官方 README / 官方 CHANGELOG / 官方 Release）
  - 【推断】= 基于事实的合理推论，尚无一手来源直接支撑
  - 【建议】= 面向落地的主观建议，不代表官方立场
- 核实状态标记：✅ 已核实｜⚠️ 部分核实｜❌ 未能核实（详见第 8、9 节）

> 说明：本报告制定计划阶段曾向用户提出 7 个待确认问题（篇幅、读者、是否含案例、是否纳入社区插件、是否需要路线图等），用户未逐条回答而直接批准执行。本报告按以下默认假设撰写，并在相关处标注：【默认假设】技术 + 产品并重；含具体教学闭环案例走查；社区/第三方插件分级收录且一律标注来源可靠性；末尾给出可落地路线图。

---

## 1. 摘要

**结论先行。**

1. **DSH 是"底座"，不是"教学产品"。**【事实】DeepSeek Harness（命令行 `dsh`）是 DeepSeek AI 于 2026 年开源的 agent harness（智能体框架），采用"一切皆插件"架构，由 Cordis 内核驱动。它本身不含教学能力，而是通过插件把通用大模型约束成"遵守教学协议的智能体"。它目前处于**开发者预览**阶段，官方明确警告**未来会出现破坏兼容性的变更**，且**尚未接受安全审计**。(✅)

2. **"DSH 有一整套官方教育插件"这一线索，基本上站不住脚。**【事实/❌】用户初始线索中的 `dsh-edu-mode`、`dsh-project-based-learning`、`dsh-craft-your-textbook`、`dsh-plugin-education` 四个插件名，经针对性检索**未找到任何相关命中**。本报告判定为"疑似不存在 / 需进一步核实"，**不应作为事实引用**。(❌ 证据强度弱)

3. **真正的教育落地发生在 OpenMAIC 侧，而不是 DSH 侧。**【事实】OpenMAIC 是清华大学 THU-MAIC 团队的开源 AI 互动课堂平台，截至 2026-09-30 的最新版本为 **v1.1.2（2026-09-28）**，版本线密集（0.3.2 → 1.0.0 → 1.1.x）。用户线索中关于 v0.3.2 与 v1.0.0 的功能描述**基本全部被官方 CHANGELOG 证实**。(✅)

4. **用户线索中最需要纠正的一点**：`dsh-openmaic` 插件实际注册的是 **4 个工具 + 1 个技能**，而非线索中的 2 个工具。4 个工具是 `openmaic_generate`、`openmaic_slide`、`openmaic_widget`、`openmaic_render`；技能是 `openmaic-teach`（苏格拉底式教学会话）。(✅ 依据上游 README 原文)

5. **一条不可忽视的存疑数据**：用户线索中的 Token 数据「累计 883B、近 30 天 68B、环比 +203%」**在 OpenMAIC 仓库内查无出处**，本报告**不采信为事实**。(❌)

6. **合规是关键约束，不是脚注。**【事实】两个项目均为 MIT 许可（均可商用），但 OpenMAIC 在 1.0.2–1.1.2 之间连续发布了多个安全公告（SSRF、DNS rebinding、Next.js 远程代码执行 CVE-2026-75604），DSH 官方则明示"沙箱与审批不保证隔离、不保证防损害"。教育场景天然涉及未成年人数据，**这是比功能对比更重要的决策变量**。(✅)

一句话总结：**"DSH × 教育"目前的真实形态是——DSH 作为可插拔的 agent 运行时，通过一个第三方（THU-MAIC 维护、非 DeepSeek 官方）的 `dsh-openmaic` 插件，把 OpenMAIC 的课堂生成能力变成对话式工具；而"课程怎么教"这件事，事实上由 OpenMAIC 的 24 个教学 Skill 承担。**

---

## 2. DeepSeek Harness（DSH）是什么

### 2.1 定位与理念

【事实】DSH 是由 DeepSeek AI 开发的开源 agent harness（智能体框架），构建于**"一切皆插件"**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，设计理念见论文《*A Programming Paradigm for Spatiotemporal Composability*》（arXiv 2608.25512）。(✅)

【事实】关键设计约束：

- **不存在需要打补丁的特权内核**。扩展 DSH 的方式是把插件挂载到其他插件旁边；产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 **agent loop（智能体循环）本身**，因此每一部分都可以从配置替换。(✅ 依据 `docs/architecture.zh.md`)
- **"注册即副作用"（Registrations are effects）**：每一项注册都通过 `ctx.effect()` / `ctx.on()` 进行，注册表的 `register()` 返回一个 disposer，插件卸载时自动撤销。(✅ 依据 `AGENTS.md`)
- **"模型可见 ⟺ 已记录"（Model-visible ⟺ logged）**：模型能看到的，必然已被记录进会话日志。(✅)

【事实】DSH 官方的三项核心职责（面向使用者）：编排模型与工具、在危险操作前请求人工批准、维护结构化的执行计划。(✅ 依据官方 README 与产品页)

### 2.2 架构：Profile × 组合包 × 有序 patch

【事实】运行中的 `dsh` 是一棵**插件树**，由启动时按序叠加的各层组合而成。(✅)

- **profile**：存放在 Harness home 中的具名组装，列出自己叠放的组合包、存放树外插件、保存用户的 `cordis.patch.yml`。随发行版交付的模板包括 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`。(✅)
- **组合包（bundle）**：Cordis 配置项及其挂载代码的分发格式，因此它插入的内容始终可被其上各层 patch。(✅)
- **层顺序**：先按 profile 列出的顺序应用每个组合包 → profile 的 `cordis.patch.yml` → home 级那份 → 任意 `--patch` overlay。一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。(✅)
- `dsh-base` 是 `web` / `headless` / `sdk` / `acp` 的共享第一层：模型适配器、工具、持久化、**沙箱与审批策略**、设置、凭据、遥测。(✅)

【事实】可用 `dsh --profile web --dump-config` 导出机器上实际启动的配置树，"它打印出的任何条目，都可以由你自己的 patch 替换"。(✅)

### 2.3 轮次流程与事件模型（决定"教育协议"能挂在哪）

【事实】DSH 的执行模型：一个**步骤**是一次模型请求加上它调用的工具；一个**轮次**包含零个或多个步骤。(✅)

三个事件域是主要扩展点：

| 事件域 | 性质 | 教育场景含义【推断】 |
|---|---|---|
| 会话事件（`turn/*`、`step/*`、`*message`、`tool/*`） | 追加到日志并广播的**持久事实** | 学习过程可回放、可审计——教学合规与"学习记录"的基础 |
| Agent 事件（`agent/*`） | 携带活跃 Agent 的实时扩展点（inbox、步骤、状态、请求、验证、续跑） | 可在教学流程中插入"暂停并提问"、"校验回答"等拦截 |
| 能力事件（`fs/*`、`tools/*`、`telemetry/*`） | 向某个 seam 附加策略与适配器 | 可对教学工具的调用施加策略（如禁止联网、限定时长） |

【事实】`agent/pre-step`、`agent/request`、`llm/stream`、以及三个 `tools/*` 事件是 **waterfall（瀑布式）事件**，监听器必须调用 `next()` 才能委托下去；`agent/turn-stopping` 是 serial 事件。(✅)

### 2.4 四种模式（与教育相关的边界）

【事实/⚠️】DSH 提供四种运行模式（详细说明散见于文档，部分描述来自官方产品页，标 ⚠️）：

| 模式 | 特征 | 教育场景适配【推断】 |
|---|---|---|
| Standard | 默认完整工具集 | 通用教学助手 |
| Code（Code Mode SDK） | 以代码方式编排工具调用 | 计算类、编程类课程的自动评测 |
| Minimal | 仅 bash + 编辑器 | 自由度最高，也最危险，不建议面向学生 |
| Creator | 提供 **Plugin Manager** 与**只读运行时检查工具**（`cordis_inspect_list`、`cordis_inspect_query`） | 教师/开发者自建教学插件 |

【事实】Creator 模式的两个只读运行时检查工具由 `@deepseek-ai/dsh-tool-cordis` 提供；"Author persistent changes as bundles and install them with plugin_manager"——即创作持久变更的方式是写成组合包，再用 plugin_manager 安装。(✅ 依据 `docs/tool-catalog.md`)

### 2.5 插件安装机制（教育插件如何落地）

【事实】`dsh plugin --profile <name> <args...>` 会在 profile 目录内**转发给 pnpm**，因此所有 pnpm 子命令都可用。(✅)

可安装的来源形态（✅ 依据 `docs/user/develop/basic/publish.zh.md`）：

```sh
dsh plugin --profile demo add ./hello-plugin              # 本地目录
dsh plugin --profile demo add github:you/hello-plugin     # GitHub 仓库
dsh plugin --profile demo add your-package                # npm 包（安装预构建代码）
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz    # tarball
```

【事实】卸载命令同时移除依赖与对应的层：`dsh plugin --profile demo remove dsh-hello-plugin`。(✅)

### 2.6 能力边界（必须明确的三条）

【事实】

1. **非生产就绪**：开发者预览，将出现破坏性变更；"它尚未接受安全审计，不得视为安全或可用于生产环境的软件"。(✅ 依据 `SAFETY.zh.md`)
2. **沙箱不保证隔离**："沙箱、审批提示与权限控制可以降低风险，但不保证隔离，也不能保证防止损害……不要把 DeepSeek Harness 当作不可信工作负载唯一的安全控制措施。"(✅)
3. **插件即代码执行**："本项目可以执行模型生成的代码与命令、加载第三方插件，并访问向其开放的网络、进程、凭据和文件……恶意输入或不可信插件可能损坏宿主计算机、修改或删除文件、泄露数据或凭据。"(✅)

【建议】第 3 条是全部教育落地风险的根源：**任何教育插件都在用户权限下运行**，而 DSH 的工具审批机制**不等于沙箱**。面向学校的部署必须叠加外层隔离（一次性 VM / 容器 / 专用环境）。

---

## 3. DSH 与教育结合：路径与教育插件核实

### 3.1 用户线索的四个教育插件：核实结果

对初始线索中列出的四个插件（`dsh-edu-mode`、`dsh-project-based-learning`、`dsh-craft-your-textbook`、`dsh-plugin-education`）进行了**四名称同查**的针对性检索。

| 插件名（线索） | 线索描述的能力 | 核实结果 | 判定 |
|---|---|---|---|
| `dsh-edu-mode` | 完整课程教学协议：资料收集 → 结构化讲解 → 笔记 → 测验 → 错题重讲 | **零相关命中** | ❌ 疑似不存在 |
| `dsh-project-based-learning` | 项目制学习教练，证据驱动 | **零相关命中** | ❌ 疑似不存在 |
| `dsh-craft-your-textbook` | 教材 PDF 转 AI 教学蓝本 | **零相关命中** | ❌ 疑似不存在 |
| `dsh-plugin-education` | 教案骨架、测验校验、评分量规、Anki 卡片等 | **零相关命中** | ❌ 疑似不存在 |

【事实/❌】**判定：这四个插件名在本次可及的信息渠道中无任何印证，证据强度弱（一次针对性搜索）。**建议按"疑似不存在"处理；官方的插件发现渠道是 GitHub 话题 [`dsh-plugin`](https://github.com/topics/dsh-plugin)，若后续需要确证，应按第 9 节给出的核实路径复核。(❌)

【推断】值得注意：线索中描述的能力（教学协议、PBL 教练、教材转蓝本、测验校验/评分量规/间隔重复）**几乎与 OpenMAIC 的 24 个教学 Skill 一一对应**（见 4.4 节）。合理推测是：**这些能力被误记为 DSH 插件，实际上是 OpenMAIC 的能力。** 这是一个典型的"两者混淆"风险，已验证于本报告。

### 3.2 DSH 官方插件生态的真实秩序

【事实】DSH 官方对插件生态的组织方式是**话题标签 + 讨论区 + 社区群**，而非官方插件市场：

- 为插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。(✅ 依据官方 README)
- 反馈与 bug 通过 GitHub Discussions。(✅)
- DSH 自带一批**非教育类**能力包（`packages/` 分组）：`skill/`（技能加载）、`subagent/`、`mcp/`、`hooks/`（Claude Code / Codex 桥）、`plan/`（已记录的规划）、`todo/`、`goal/`、`schedule/`（定时跟进）、`guard/`（循环/工具守卫）、`sandbox/`（进程隔离）、`deliverables/`（轮次交付物）等。(✅ 依据 `AGENTS.md`)

【推断】这意味着：**DSH 提供了"教学协议"所需的全部底层原语**（技能加载、子代理、规划、守卫、沙箱、交付物），但这些原语本身**不是**教学协议。教育能力的"上层建筑"需要由插件作者（如 THU-MAIC）来提供。

### 3.3 第三方插件目录：一律不可作为事实

【事实/❌】存在若干第三方站点宣称收录大量 DSH 插件，且**互相矛盾**：

| 站点 | 宣称 | 性质 |
|---|---|---|
| dshai.org | 3,034 插件、1.8M 周下载、500.5K stars | 第三方自报 |
| dsh.do | 14,489 插件 | 第三方自报 |
| dshplugin.dev | 1,146 插件 | 第三方自报 |

**这些数据不一致、无审计、属自报，本报告一律不作为事实引用。** 另需注意：`dshai.org`、`deepseekharness.dev`、`dsh.do`、`dshplugin.dev`、`open-design.ai`、`awesome-dsh-plugin.com` **均为第三方站点，非官方**。(❌)

【事实】唯一可作为官方来源的公众产品页是 `deepseek.com/harness/en/`。(✅)

---

## 4. OpenMAIC 新版本核实

### 4.1 定位

【事实】OpenMAIC 是清华大学 THU-MAIC 团队开发的开源 AI 互动课堂平台：

- 仓库：`github.com/THU-MAIC/OpenMAIC`，许可证 MIT（Copyright (c) 2026 THU-MAIC）。(✅)
- 技术栈：Next.js 16.3.3 + React 19 + pnpm，Node >= 22.19。(✅)
- 在线云版：`open.maic.chat`，访问码以 `sk-` 前缀。(✅)
- 能力：把主题或文档转化为幻灯片、测验、模拟/交互实验、PBL 项目等沉浸式课堂。(✅)

### 4.2 完整版本线（逐条核实自仓库 CHANGELOG）

【事实】截至 2026-09-30 的版本线（✅）：

| 版本 | 日期 | 版本 | 日期 |
|---|---|---|---|
| 0.1.0 | 2026-03-26 | 1.0.2 | 2026-09-14 |
| 0.2.0 | 2026-04-20 | 1.0.3 | 2026-09-15 |
| 0.2.1 | 2026-04-26 | 1.1.0 | 2026-09-24 |
| 0.2.2 | 2026-06-02 | 1.1.1 | 2026-09-27 |
| 0.3.0 | 2026-06-28 | **1.1.2** | **2026-09-28（最新）** |
| 0.3.1 | 2026-07-21 | Unreleased | （服务端持久化强制开启等） |
| **0.3.2** | **2026-08-14** | 1.0.1 | 2026-09-06 |
| **1.0.0** | **2026-08-27** | | |

> 注：本地仓库 `package.json` 中 `version` 字段为 `1.1.1`，而 CHANGELOG 已到 `1.1.2`——说明本地检出略滞后于最新发布，二者不矛盾。

### 4.3 v0.3.2 与 v1.0.0：线索证实情况

#### v0.3.2（2026-08-14）——线索**全部证实** ✅

线索提到的功能，与官方 CHANGELOG 逐条对应：

| 线索说法 | CHANGELOG 实际内容 | 状态 |
|---|---|---|
| 视频导出加固 | Video export hardening：spotlight 几何、视频片段、公式、字幕保真；确定性 Quiz/PBL 封面卡；自包含静态交互 HTML 捕获；CPU 资源画像；渲染服务有效并行捕获 | ✅ |
| 服务端持久化 | Server-backed persistence completion：学习者数据切换至 RuntimeStore；stage/scene/outline 切换至 DocumentStore；Postgres 后端 HTTP 契约；**一键 compose 栈 #982**；脏集增量保存 | ✅ |
| Postgres 一键部署 | 同上（compose profile + 内嵌 API + 文档） | ✅ |
| Amazon Bedrock | Amazon Bedrock LLM provider #538 | ✅ |
| Claude 搜索 | Claude（`claude search`）作为 web 搜索 provider #393 | ✅ |
| 法语/西班牙语/越南语 | fr-FR #1068、es-MX #942、vi-VN #1025（另有 432 条 zh-TW 校译） | ✅ |
| （线索未提）资产注册表 | Asset registry：分配的 asset id 覆盖内容寻址 blob 层 | ✅ |
| （线索未提）生成包 | `@openmaic/generation` 包：outline / scene / PBL 单次调用规划迁入 | ✅ |
| （线索未提）SDK 契约归属 | 交互与 PBL 内容类型提升进 `@openmaic/dsl` | ✅ |
| （线索未提）文件夹分组 | Course folder grouping #1005 | ✅ |
| （线索未提）FunASR | 本地 FunASR ASR provider #1044 | ✅ |

#### v1.0.0（2026-08-27）——"Agent 驱动的专业工作台"**证实**，"先明确学习目标再反向规划"**部分证实** ✅/⚠️

| 线索说法 | CHANGELOG 实际内容 | 状态 |
|---|---|---|
| 从"一键生成器"升级为 Agent 驱动的专业工作台 | **Agent workbench (Pro mode)** — chat-first 从主页建课；可折叠工作区壳、agent 聊天界面、客户端数据层 | ✅ |
| （线索未提）持久化 agent 运行时 | **Durable agent runtime** — 服务端建课会话，会话可跨重启存活、接受跟进引导与取消、流式回放事件转录 | ✅ |
| 内置教学法 Skill 体系，可组合加载 | **Agent tools and skills** — skills 系统 #1189，含 Feynman 与螺旋课程法 #1240；Settings 中真实技能管理（列表/下载/删除/上传）#1244 | ✅ |
| 先明确课程学习目标，再反向规划每节课 | CHANGELOG 未直接出现该表述；最接近的是 `understanding-by-design`（UbD 逆向设计）Skill | ⚠️ 近似证实（见 4.4） |
| （线索未提）讲解稿导出 | 导出时可将讲解稿下载为 Markdown 或 DOCX #1144 | ✅ |
| （线索未提）德语 | de-DE 本地化 #1128 | ✅ |
| （线索未提）OpenClaw skill | OpenClaw skill：二次开发流程 #1119 | ✅ |
| （线索未提）provider-neutral | 服务端能力中立：图像/视频/ASR 模型从服务端配置解析；能力强制关闭的统一缺失密钥契约 | ✅ |

#### v1.0.0 之后的重要演进（线索未覆盖，但决策上重要）✅

- **1.1.0（2026-09-24）**：课堂聊天默认改为 **Pi agent loop**——学习者可指向**单个 PPT 元素、交互组件或白板元素**提问，交互页在提问时采样实时状态，教师可读取课件、检查交互实验实时状态、联网搜索后再回答；设置围绕课程工作流重构（每个生成步骤可选模型）；Token Plans 一键预设（TokenDance、MiniMax、Seed、Kimi 等）。
- **1.0.2 → 1.1.2**：**连续安全发布**（详见 4.5）。
- **Unreleased**：**服务端持久化强制开启**——`NEXT_PUBLIC_PERSISTENCE` 开关被移除，服务端启动时**必须**有 `DATABASE_URL`，否则退出；浏览器不再有自有存储后端。

【推断】这最后一条对教育部署影响极大：**从"纯前端可用"转向"必须配数据库"，部署复杂度上升，但同时获得了多用户、多设备、可审计的持久化底座。** 对学校/机构，这是必要的；对个人教师快速试用，则门槛变高（不过 `open.maic.chat` 云版仍是零部署路径）。

### 4.4 内置教学 Skill：这才是"教学协议"的真实所在地

【事实】本地仓库 `skills/agent-runtime/` 下共 **24 个**教学 Skill（✅，逐个列出）：

`understanding-by-design`、`curriculum-planner`、`feynman-learning`、`spiral-curriculum`、`zone-of-proximal-development`、`k12-core-literacy-planning`、`lecture-style`、`vocational`、`social-emotional-learning`、`deep-research`、`fact-check`、`deep-interactive`、`learning-to-learn`、`build-personal-skill`、`workshop-style`、`teacher-style-clone`、`style-clone`、`stage-dsl`、`stage-design`、`slide-dsl`、`slide-craft`、`pro-editing`、`pptx-import`、`page-clone`。

【事实】另有 `skills/openmaic/`——**这是 OpenClaw / ClawHub 技能**，配置文件为 `~/.openclaw/openclaw.json`，用于"设置、生成与扩展 OpenMAIC"的引导式 SOP，**不是 DSH 插件**。此处极易混淆，须明确区分。(✅)

【事实】以 `understanding-by-design`（理解本位设计 / UbD）为例，它明确要求三阶段逆向设计：① 确定预期结果（持久理解 + 基本问题）；② 先确定评估证据（GRASPS 表现性任务、概念诊断与辨析、迁移与应用）；③ 用 WHERETO 设计学习经历（Where&Why / Hook / Equip / Experience / Rethink&Revise / Tailor / Organize），并给出 OpenMAIC 页面节奏建议（slide → slide → interactive → quiz/interactive → pbl → quiz+收束 slide）。(✅)

【推断】**这解释了 3.1 节的"混淆"**：线索中所谓"完整课程教学协议（资料收集→结构化讲解→笔记→测验→错题重讲）"、"PBL 教练"、"教材转蓝本"、"评分量规/间隔重复"，在 OpenMAIC 的 Skill 集里都能找到对应物（`curriculum-planner`、`understanding-by-design`、`feynman-learning`、`spiral-curriculum`、`pptx-import`、`fact-check` 等），而**没有**对应的 DSH 教育插件。因此，若决策者要评估"教学协议"的真实成熟度，**应该看 OpenMAIC 的 Skill，而不是 DSH 的插件市场**。

### 4.5 安全态势：必须写进决策清单

【事实】OpenMAIC 在近一个月的连续安全发布（✅，均有一手 GHSA 公告）：

| 版本 | 日期 | 安全问题 |
|---|---|---|
| 1.0.2 | 2026-09-14 | 安全修复批次（含 `GHSA-725p-44hx-v52c`、`GHSA-9m7h-vh2h-rc3w`、`GHSA-7rhf-2798-mvcj`、`GHSA-p2wh-m28m-c5xw`、`GHSA-23xq-m3mm-3j49`、`GHSA-6xff-rgjg-v33f` 等） |
| 1.0.3 | 2026-09-15 | 访问码令牌不过期且验证无限流（`GHSA-qpmr-534w-hhpg`）；渲染服务对不可信 HTML 未施加 CSP（`GHSA-vqq3-22q7-289w`）；音频 provider 请求未校验重定向；**Next.js 16.2.11 → 16.3.3，修补 Windows 托管服务器上的未认证远程代码执行（`GHSA-p293-qw3h-jr36` / CVE-2026-75604）** |
| 1.1.1 | 2026-09-27 | MinerU Cloud 解析：上传/结果 URL 未受公共地址策略约束（SSRF）；共享 SSRF 守卫补充 IPv4 兼容 IPv6 分类 |
| 1.1.2 | 2026-09-28 | 服务端可被调用者选择 provider URL 的请求可连内网、跟随重定向并回显 provider 响应体/连接错误（**GHSA-g87c-cm4q-cw5x**）；课堂媒体下载改用严格 provider 传输 |

【事实】1.1.2 引入了多项**行为变更**，升级前必须阅读：调用方提供的 base URL 若返回重定向将被**拒绝**（不再跟随）；含 query string 或 fragment 的 base URL 被拒绝；调用方选择的 loopback/私有地址需要 `ALLOW_LOCAL_NETWORKS`；provider 错误改为固定文案，不再回显原文。(✅)

【建议】安全公告**高频出现本身是积极信号**（有人在认真修），但也说明该产品仍处在**攻击面快速收敛期**。学校部署应：锁定版本、订阅 GHSA、把 OpenMAIC 放在网关后、用 `ACCESS_CODE` 或 owner auth 做真实访问控制。

---

## 5. DSH × OpenMAIC 集成：`dsh-openmaic` 插件

### 5.1 基本事实

【事实】（✅，依据上游 README 原文）

- 仓库：`github.com/THU-MAIC/dsh-openmaic`，许可证 MIT，**由 THU-MAIC 维护**（即 OpenMAIC 团队，而非 DeepSeek 官方）。
- 安装（自带编译产物，无需自行 build）：

```sh
dsh plugin --profile web add git+https://github.com/THU-MAIC/dsh-openmaic.git
```

- 配置项：`baseUrl`（默认 `https://open.maic.chat`，可指向 `localhost:3000`）、`accessCode`（在线版未强制，可留空）、`pollIntervalMs`（5000）、`maxWaitMs`（600000）。
- API 流程：`POST /api/access-code/verify`（配置了访问码时）→ `POST /api/generate-classroom`（返回 `jobId` + `pollUrl`）→ 轮询 → 返回 `{baseUrl}/classroom/{classroomId}`。
- 第三方收录页显示 **5 stars**（说明生态热度尚低）。

### 5.2 注册的能力：4 个工具 + 1 个技能（纠正线索）

【事实/⚠️ 关键纠正】线索称注册了 2 个工具；**实际为 4 个工具 + 1 个技能**（✅ 依据上游 README）：

| 能力 | 类型 | 作用 |
|---|---|---|
| `openmaic_generate` | 工具 | 提交需求 → 轮询异步任务 → 返回**可播放的课堂链接** |
| `openmaic_slide` | 工具 | 写 PPTist 风格 Slide JSON，用 OpenMAIC 官方 renderer 渲染 |
| `openmaic_widget` | 工具 | 写交互式 widget（simulation / game / code）HTML，流式渲染为**沙箱卡片** |
| `openmaic_render` | 工具 | 写内联 HTML 教学片段（概念卡 / 测验 / 走查），渲染为**对话内沙箱卡片** |
| `openmaic-teach` | 技能 | **苏格拉底式教学会话**，引导追问式互动 |

【事实】**明确的范围界定**：`slide` / `widget` / `render` **不做服务端生成**，仅按 `@openmaic/dsl`、`@openmaic/generation`、`@openmaic/renderer` 的契约**渲染 agent 自己写的内容**。只有 `openmaic_generate` 会真正调用 OpenMAIC 服务端做完整课堂生成。(✅)

【事实】Roadmap（插件方自述）：补齐 `diagram` / `visualization3d` / `procedural-skill` 三类 widget；回传 action loop（高亮 / 批注 / 揭示）。(✅)

### 5.3 集成后形成的教学闭环

【推断】把上述能力串起来，得到这样一个闭环（证据强度分级标注）：

```text
① 教学目标澄清        [推断·由 openmaic-teach / UbD Skill 承担]
        │
② 内容/素材输入       [事实] 教材 PDF、URL（经 URL 信任门）、已有 PPTX
        │
③ 课堂生成           [事实] openmaic_generate → OpenMAIC 服务端 → classroom 链接
        │
④ 对话内即时教学片段  [事实] openmaic_render（概念卡/测验/走查）
   · 单页幻灯片       [事实] openmaic_slide
   · 交互实验/小游戏  [事实] openmaic_widget（simulation/game/code）
        │
⑤ 课堂内苏格拉底追问  [事实] 1.1.0 Pi agent loop——指向具体元素提问
        │
⑥ 学习过程持久化      [事实] 服务端持久化（课程/聊天/学习者运行时/媒体）
        │
⑦ 复习与评估          [⚠️ 部分·`quiz` 页存在，FSRS/间隔重复未见官方实现]
        │
⑧ 教研沉淀            [⚠️ 部分·讲解稿可导出 MD/DOCX；Skill 可上传/下载]
```

其中：

- **①→④ 是"已实现"**（有一手来源）。
- **⑤ 是"已实现且是 1.1.0 的核心亮点"**（元素级引用 + 交互页状态采样）。
- **⑥ 是"已实现"**（但 Unreleased 起强制要求 `DATABASE_URL`）。
- **⑦ 的"间隔重复/错题重讲"目前找不到官方实现**——`quiz` 页面类型存在，但没有证据表明有 FSRS 调度器。【❌ 未能核实】这与 3.1 节线索中"FSRS 间隔重复复习"的对应关系为**空**。
- **⑧ 部分实现**：讲解稿导出（MD/DOCX）与 Skill 管理是实的；"教研沉淀"作为完整工作流是推断。

### 5.4 一个重要的架构事实：DSH 侧的教学协议是"薄的"

【推断】**`dsh-openmaic` 提供的教学协议只有 1 个 Skill（`openmaic-teach`），而 OpenMAIC 侧有 24 个。** 也就是说：

- 如果你在 DSH 里用 `openmaic_generate` 建课，**真正施加强教学法约束的是 OpenMAIC 服务端的 Skill 体系**，不是 DSH。
- DSH 侧的价值在于**编排**：会话、工具审批、子代理、计划、持久化日志、以及在同一个对话里把"建课"和"其他工作"（如写文档、查资料、跑代码）混合起来。

【建议】因此不要问"DSH 的教育能力 vs OpenMAIC 的教育能力"，而应问"**把 OpenMAIC 作为一个工具，挂进 DSH 的通用 agent 工作流**，对我的场景是否有价值"。答案取决于你的教师/教研是否**已经在 DSH 里工作**。

---

## 6. 教育场景分析与案例走查

### 6.1 五类核心教学场景的适配度

【建议】以下评分为主观判断，依据是已验证的功能清单。

| 场景 | 适配度 | 依赖能力（已验证） | 主要缺口 |
|---|---|---|---|
| **备课**（教材/大纲 → 课件） | 高 | `pptx-import`、`openmaic_generate`、`curriculum-planner`、`understanding-by-design`、`openmaic_slide` | 复杂教材（图表密集、公式密集）的解析保真度仍需实测 |
| **授课**（课堂讲解、互动） | 高 | Pi agent loop 元素级提问、`openmaic_widget` 交互实验、TTS 讲解、白板 | 实时多学生并发互动的证据不足 |
| **练习**（测验、习题） | 中高 | `quiz` 页面类型、`@openmaic/dsl` 的 quiz 契约、1.1.0 起拒绝非 A–Z 选项值 | **自动评分/学情诊断的完整闭环未见官方实现** |
| **复习**（间隔重复、错题） | 低 ⚠️ | 无 | **FSRS / 间隔重复调度器未见官方实现**（线索主张未证实） |
| **评估**（学业评价、量规） | 低 ⚠️ | 无 | 评分量规 / 量规校验未见官方实现（线索主张未证实） |

【事实/❌ 关键提示】用户线索中的 **"FSRS 间隔重复复习"**、**"评分量规"**、**"测验校验"**、**"Anki 卡片"**，与本报告可及的一手来源**无法对应**。这些能力是否存在于这两个项目的任何版本中，**目前不可核实**。决策时应视为**空白**而非"已有"。

### 6.2 案例走查（走查式，标注证据强度）

**场景：一位大学物理教师，用 DSH + `dsh-openmaic` 备一节"电磁感应"课。**

| 步骤 | 操作 | 证据强度 |
|---|---|---|
| 1 | 在 DSH 会话里说"我想给大二学生讲电磁感应，重点是楞次定律的物理直觉，不是公式推导" | 【事实】`openmaic-teach` 技能 + Standard/Creator 模式支持 |
| 2 | Agent 追问学习目标与评估证据 | 【推断】`openmaic-teach` 宣称苏格拉底式；具体追问清单未见原文 |
| 3 | 教师上传教材 PDF（第 8 章） | 【事实】`pptx-import` / 材料上传合同 / PDF 解析（`verify-pdf-provider`） |
| 4 | Agent 调用 `openmaic_generate` 生成课堂 | 【事实】异步 job + 轮询 + 返回 classroom 链接 |
| 5 | 生成结果包含：概念 slide、楞次定律交互模拟（`interactive`）、诊断性 `quiz`、一个 GRASPS 表现性任务（`pbl`） | 【推断】UbD Skill 的页面节奏建议正是此顺序；前几个类型均有官方契约 |
| 6 | 教师在对话里要求"把第 3 页的磁场方向动画改成先出现再消失" | 【事实】`openmaic_slide` 按 DSL 渲染 agent 自写内容 |
| 7 | 课堂上，学生指着某个交互组件问"为什么这里电流方向反了" | 【事实】1.1.0 元素级引用 + 交互页状态采样 |
| 8 | 课后，教师导出讲解稿为 DOCX，放进教研组共享盘 | 【事实】#1144 |
| 9 | 一周后复习 | 【❌】**无官方间隔重复机制**，需外部工具（如 Anki）或自建 |

【建议】这个走查说明：**1–8 步是真实可走的，第 9 步是断的。** 任何以"完整学习闭环（含复习/评估）"为卖点的产品叙事，目前**缺少一手证据**。

### 6.3 与替代方案的对比

【建议】

| 维度 | DSH + dsh-openmaic | 直接用 open.maic.chat | 直接用商业 AI 课件工具 |
|---|---|---|---|
| 上手成本 | 高（需装 DSH、配 profile、装插件） | 低（访问码即可） | 低 |
| 可定制性 | 极高（一切皆插件） | 中（Skill / 二开 / SDK） | 低 |
| 教学法深度 | 中（1 个技能） | **高（24 个 Skill）** | 视产品 |
| 数据可控 | 高（自托管，但需配 DB） | 低（云版，数据在对方） | 低 |
| 生产就绪 | **低**（DSH 明示开发者预览） | 中 | 高 |
| 适合谁 | 开发者、研究者、能自建的技术型教研 | 教师个人、快速试课 | 学校采购 |

---

## 7. 优势、局限与风险

### 7.1 优势

【事实/推断】

1. **架构上的可组合性是真的**：DSH 的"一切皆插件 + 注册即副作用 + 无特权内核"不是营销词，`architecture.zh.md` 与 `AGENTS.md` 有明确的机制与硬约束支撑。教育机构可以替换模型适配器、工具、甚至 agent loop。【事实】
2. **教学法不是空话**：OpenMAIC 的 24 个 Skill（UbD、螺旋课程、费曼、ZPD、K12 核心素养、社会情感学习等）是**可读的具体协议文本**，不是黑箱 prompt。【事实】
3. **持久化底座在补课**：服务端持久化 + Postgres + 所有权模型（owner / 单用户 / 匿名 claim）——这是从 demo 走向机构部署的必要一步。【事实】
4. **多语言覆盖广**：中、英、日/韩、法、西（墨西哥）、越南、德、繁中等。【事实】
5. **模型中立**：provider-neutral，支持 OpenAI/Anthropic/Google/Azure/Bedrock/OpenRouter/阿里/硅基流动等，并有 Token Plan 一键预设。【事实】

### 7.2 局限

【事实】

1. **DSH 非生产就绪**，官方明示破坏性变更将至、未安全审计。【事实】
2. **教育插件生态几乎空白**：线索中的四个 DSH 教育插件未能核实；`dsh-openmaic` 仅 5 stars。【事实/❌】
3. **"完整学习闭环"缺后半段**：复习（间隔重复）与评估（评分量规）**无一手证据**。【❌】
4. **部署门槛上升**：Unreleased 起服务端必须有 `DATABASE_URL`。【事实】
5. **Token 数据不可信**：883B / 68B / +203% 无出处。【❌】

### 7.3 风险（按教育场景优先级排序）

| # | 风险 | 证据 | 缓解建议 |
|---|---|---|---|
| R1 | **安全**：DSH 明示沙箱/审批不保证隔离、不保证防损害；插件以用户权限运行 | 【事实】`SAFETY.zh.md` | 一次性 VM/容器；最小权限；教学机与学生机物理分离 |
| R2 | **OpenMAIC 近期高频 SSRF/RCE 公告** | 【事实】`GHSA-g87c-cm4q-cw5x`、`GHSA-cpjc-vgjh-c5jp`、`GHSA-qpmr-534w-hhpg`、`GHSA-vqq3-22q7-289w`、Next.js CVE-2026-75604 | 锁版本、订阅 GHSA、网关后部署、`ACCESS_CODE` + owner auth |
| R3 | **未成年人数据隐私**：服务端持久化会存课程/聊天/学习者运行时/媒体 | 【事实】Unreleased 持久化段落 | 自托管 + 数据不出校；访问控制；隐私影响评估（PIA）；符合当地法规 |
| R4 | **模型幻觉进入课堂**：生成的 quiz / 交互脚本可能错误 | 【事实】1.1.0 起会拒绝不可解析的交互脚本、非 A–Z 选项，说明问题真实存在 | 人工审核门；使用 `fact-check` Skill；关键课必须教研终审 |
| R5 | **版本快速迭代导致信息过时**：一个月内 1.0.2→1.1.2 连发 | 【事实】CHANGELOG | 报告结论标注"截至 2026-09-30"；建立版本追踪机制 |
| R6 | **插件名/项目名混淆**：教育能力被误记为 DSH 插件；`skills/openmaic` 是 OpenClaw 技能而非 DSH 插件 | 【事实】本报告 3.1 / 4.4 | 引用前逐一回溯一手来源；建立"来源白名单" |
| R7 | **第三方数据污染决策**：插件目录数字互相矛盾 | 【事实】三站点自报数据不一致 | 一律不引用第三方自报数字 |
| R8 | **开源许可证与合规**：两者均为 MIT（可商用），但需保留版权声明；`THIRD_PARTY_NOTICES.md` 列出依赖 | 【事实】LICENSE 文件 | 上线前做许可证清单审计 |
| R9 | **数据主权与"匿名 claim"**：匿名 cookie 是 bearer 凭证，其持有者可将匿名工作 claim 进账号 | 【事实】Unreleased 段落明确警告"clear it on shared devices" | 共享设备（如机房）必须清 cookie + 用 owner auth |
| R10 | **可及性/公平性**：依赖云服务、需访问码、需 API key | 【推断】 | 校内自托管；为无设备学生提供替代路径 |

---

## 8. 落地建议

### 8.1 面向教育产品团队

【建议】

1. **不要基于"DSH 有教育插件"做产品假设**——该假设目前无证据。要建教学协议，请直接研究 OpenMAIC 的 Skill 体系（24 个，文本可读），或自建 DSH 插件。
2. **把集成定位为"编排层"**：`dsh-openmaic` 的价值是让"建课"成为通用 agent 工作流中的一个工具。若你的用户不在 DSH 里工作，直接对接 OpenMAIC API 可能更简单。
3. **补齐闭环的后半段**：复习（间隔重复）与评估（量规/诊断）是明确的**市场空白 + 技术空白**。这是一条低竞争的产品机会。
4. **把安全与合规前置到架构**：R1/R2/R3 不是上线前才处理的事项。

### 8.2 面向教师

【建议】

1. **个人快速上手走云版**：`open.maic.chat` + `sk-` 访问码 + `skills/openmaic` 的引导式 SOP，零部署。
2. **需要数据可控时走自托管**：本地 clone + `pnpm db:up` + provider key（自行编辑配置文件，**不要把 API key 贴进对话**）。
3. **用 `understanding-by-design` 起手**：先定"持久理解 + 基本问题"，再定评估证据，最后才排页面——这是最不容易"生成一堆好看的废页"的路径。
4. **关键课必须人工终审**：模型可能生成错误的 quiz 或不可执行的交互脚本（官方已在 1.1.0 加了拒绝逻辑，但拒绝 ≠ 正确）。

### 8.3 面向开发者/二开

【建议】

1. **先用 Creator 模式探索**：`cordis_inspect_list` / `cordis_inspect_query` 是只读的，安全。
2. **持久变更写成组合包**，用 `dsh plugin --profile <name> add` 安装；不要用临时 patch 上线。
3. **遵守 DSH 的硬约束**：注册走 `ctx.effect()` / `ctx.on()`；"模型可见 ⟺ 已记录"。
4. **OpenMAIC 二开**：消费 `@openmaic/dsl`、`@openmaic/generation`、`@openmaic/renderer`、`@openmaic/storage` 等 workspace 包，走官方 Skill 的 extend 分支。

### 8.4 面向学习者

【建议】

1. 交互页（simulation / game / code）是 OpenMAIC 最有价值的形态——**动手做**比看幻灯片有效。
2. 课堂里可以**指着具体元素提问**（1.1.0 起支持），比泛泛提问更有效。
3. 注意：**目前没有内置的复习机制**，需要自己配合间隔重复工具。

### 8.5 分阶段落地路线图（摘要）

【建议】

| 阶段 | 目标 | 关键动作 | 退出条件 |
|---|---|---|---|
| P0 验证（1–2 周） | 证实/证伪价值假设 | 云版试课 3 门；核实四个"教育插件"是否真实存在；实测 PDF 解析保真度 | 明确"哪些环节真能用" |
| P1 试点（1 个月） | 单机自托管跑通 | 锁版本；容器隔离；配 Postgres；配 provider key；建立人工终审门 | 一门完整课走完 1–8 步 |
| P2 合规（并行） | 过安全/隐私关 | GHSA 订阅；PIA；访问控制；共享设备策略；许可证审计 | 合规签字 |
| P3 规模化 | 多教师/多班 | 引入 owner auth；建立 Skill 资产库；补外部复习工具对接 | — |
| P4 自建增强 | 补闭环缺口 | 用 Creator 模式自建"评估/复习"插件 | — |

---

## 9. 事实核查表

| # | 条目 | 结论 | 主要来源 | 核实状态 |
|---|---|---|---|---|
| 1 | DSH 是 DeepSeek AI 开源 agent harness，Cordis 驱动，"一切皆插件" | 成立 | 本地 `deepseek-harness/README.zh.md`、`AGENTS.md` | ✅ |
| 2 | DSH 处于开发者预览，将有破坏性变更，未安全审计 | 成立 | `README.zh.md`、`SAFETY.zh.md` | ✅ |
| 3 | DSH 官方三职责：编排、危险操作前人工批准、维护执行计划 | 成立 | 官方 README / 产品页 | ✅ |
| 4 | DSH 四种模式 Standard / Code / Minimal / Creator | 成立（Minimal 细节 ⚠️） | `docs/tool-catalog.md`、`docs/user/guide` | ⚠️ |
| 5 | `dsh plugin --profile <name> add` 转发 pnpm，支持本地/GitHub/npm/tarball | 成立 | `docs/user/develop/basic/publish.zh.md` | ✅ |
| 6 | 插件发现渠道是 GitHub 话题 `dsh-plugin` | 成立 | `README.zh.md` | ✅ |
| 7 | `dsh-edu-mode` 存在 | **未找到** | 四名称同查检索 | ❌ |
| 8 | `dsh-project-based-learning` 存在 | **未找到** | 同上 | ❌ |
| 9 | `dsh-craft-your-textbook` 存在 | **未找到** | 同上 | ❌ |
| 10 | `dsh-plugin-education` 存在 | **未找到** | 同上 | ❌ |
| 11 | 第三方插件目录数字（3034 / 14489 / 1146） | **互相矛盾，不采信** | dshai.org / dsh.do / dshplugin.dev | ❌ |
| 12 | OpenMAIC 由 THU-MAIC 开发，MIT，Next.js 16.3.3 + React 19 | 成立 | 本地 `OpenMAIC/package.json`、`LICENSE` | ✅ |
| 13 | 最新版本 v1.1.2（2026-09-28） | 成立 | `OpenMAIC/CHANGELOG.md` | ✅ |
| 14 | v0.3.2（2026-08-14）全部线索功能 | 成立 | `CHANGELOG.md` L341-375 | ✅ |
| 15 | v1.0.0（2026-08-27）Agent workbench / agent runtime / skills | 成立 | `CHANGELOG.md` L299-338 | ✅ |
| 16 | v1.0.0"先明确学习目标再反向规划" | **近似**（对应 `understanding-by-design`） | `CHANGELOG.md` + Skill 原文 | ⚠️ |
| 17 | OpenMAIC 内置 24 个教学 Skill | 成立 | `skills/agent-runtime/*/SKILL.md` | ✅ |
| 18 | `skills/openmaic` 是 OpenClaw 技能而非 DSH 插件 | 成立 | `skills/openmaic/SKILL.md` | ✅ |
| 19 | `dsh-openmaic` 由 THU-MAIC 维护，MIT | 成立 | 上游 README | ✅ |
| 20 | `dsh-openmaic` 注册 **4 工具 + 1 技能**（非线索中的 2 工具） | 成立 | 上游 README | ✅ |
| 21 | slide/widget/render 不做服务端生成，仅渲染 agent 自写内容 | 成立 | 上游 README | ✅ |
| 22 | Token 数据 883B / 68B / +203% | **仓库内无出处** | 全库检索 | ❌ |
| 23 | FSRS 间隔重复 / 评分量规 / Anki 卡片 / 测验校验 | **未能核实** | 全库检索 | ❌ |
| 24 | OpenMAIC 近月连续安全发布（SSRF / RCE / CSP） | 成立 | `CHANGELOG.md` 1.0.3 / 1.1.1 / 1.1.2 | ✅ |
| 25 | Unreleased：服务端持久化强制开启，必须有 `DATABASE_URL` | 成立 | `CHANGELOG.md` L11 | ✅ |
| 26 | 在线云版 `open.maic.chat`，访问码 `sk-` 前缀 | 成立 | Skill 原文 | ✅ |

---

## 10. 参考来源与可靠性分级

### 一级（官方一手，可直接引用）

- DSH 源码仓库（本地）：`e:\YJSearch\DSH-Openmaic\deepseek-harness\`
  - `README.zh.md`、`AGENTS.md`、`LICENSE`、`SAFETY.zh.md`
  - `docs/architecture.zh.md`、`docs/tool-catalog.md`
  - `docs/user/guide/index.zh.md`、`docs/user/develop/basic/publish.zh.md`
- DSH 官方线上：`github.com/deepseek-ai/deepseek-harness`、`deepseek-harness.github.io/deepseek-harness`、npm `@deepseek-ai/dsh`、`github.com/topics/dsh-plugin`、`deepseek.com/harness/en/`
- Cordis：`github.com/cordiverse/cordis`；论文 arXiv 2608.25512
- OpenMAIC 源码仓库（本地）：`e:\YJSearch\DSH-Openmaic\OpenMAIC\`
  - `CHANGELOG.md`（版本线权威）、`package.json`、`LICENSE`
  - `skills/agent-runtime/*/SKILL.md`（24 个）、`skills/openmaic/SKILL.md`
- OpenMAIC 线上：`github.com/THU-MAIC/OpenMAIC`、`open.maic.chat`、GitHub Security Advisories（GHSA-g87c-cm4q-cw5x、GHSA-cpjc-vgjh-c5jp、GHSA-qpmr-534w-hhpg、GHSA-vqq3-22q7-289w、GHSA-p293-qw3h-jr36 / CVE-2026-75604、GHSA-725p-44hx-v52c 等）
- `dsh-openmaic`：`github.com/THU-MAIC/dsh-openmaic`（README 原文）

### 二级（官方但间接）

- OpenMAIC 1.1.0 release notes 中的 PR 号引用（#1628、#1637、#1508 等）
- DSH `docs/user/develop/` 系列教程

### 三级（第三方，仅作线索，须交叉验证）

- `dshai.org`、`dsh.do`、`dshplugin.dev`、`deepseekharness.dev`、`open-design.ai`、`awesome-dsh-plugin.com`
- 上述站点的插件数量/stars/下载量数据：**本报告一律未采信**

---

## 11. 未能核实的线索清单（供后续复核）

| 线索 | 状态 | 建议核实路径 |
|---|---|---|
| `dsh-edu-mode` / `dsh-project-based-learning` / `dsh-craft-your-textbook` / `dsh-plugin-education` | ❌ 疑似不存在 | ① GitHub 话题 `dsh-plugin` 全量遍历；② npm 关键词 `dsh-plugin` 检索；③ 三个第三方目录内搜索；④ DSH 官方 Discussions |
| Token 数据 883B / 68B / +203% | ❌ 无出处 | 官方博客 / THU-MAIC 公告 / Release notes（如仍无，应视为传言） |
| FSRS 间隔重复复习 | ❌ 未找到 | OpenMAIC 仓库全量检索 `fsrs` / `spaced repetition`；Skill 列表逐个人工阅读 |
| 评分量规 / 测验校验 / Anki 卡片 | ❌ 未找到 | 同上 |
| `dsh-openmaic` 的实际运行表现（延迟、成功率、并发） | ❌ 未实测 | 部署后压测 |
| OpenMAIC 复杂教材（图表/公式密集）解析保真度 | ❌ 未实测 | 取 3 份真实教材做对照实验 |

---

## 12. 报告局限声明

1. 本报告所有版本结论**截止 2026-09-30**。DSH 明确处于快速迭代期，OpenMAIC 一个月内发布 6 个版本——**任何版本号都可能在数周内过期**。
2. 【推断】与【建议】标签下的内容为分析判断，不代表 DeepSeek 或 THU-MAIC 官方立场。
3. 第 3.1 节的"未找到"结论基于**一次针对性检索**，证据强度为弱——即"未找到"不等于"不存在"，只等于"本次未找到"。
4. 本报告未做任何运行时实测（未部署、未压测、未做教材对照实验），所有"适配度"评分为基于已验证功能清单的**主观判断**。
5. 用户制定计划阶段提出的 7 个确认问题未获回答，本报告按第 1 节的默认假设执行；若读者需求与之不同（如只需 3 页摘要、或需剔除所有社区来源），结论取舍需相应调整。