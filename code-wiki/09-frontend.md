# 09 · 前端 Web 应用

前端位于 `web/`，是 Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router 的单页应用。

## 1. 目录结构

| 位置 | 职责 |
| --- | --- |
| [src/main.ts](file:///workspace/edu-loop-mvp/web/src/main.ts) | 启动引导：先读运行模式，再装 router 并挂载 |
| [src/App.vue](file:///workspace/edu-loop-mvp/web/src/App.vue) | 布局骨架：侧边步骤条 + 顶部选择器 + 内容区 |
| [src/router/index.ts](file:///workspace/edu-loop-mvp/web/src/router/index.ts) | `STEPS` 常量 + 六条路由 |
| [src/api/client.ts](file:///workspace/edu-loop-mvp/web/src/api/client.ts) | `apiGet` / `apiPost` / `postSse` |
| [src/api/types.ts](file:///workspace/edu-loop-mvp/web/src/api/types.ts) | 与后端共享的类型定义 |
| [src/stores/llm.ts](file:///workspace/edu-loop-mvp/web/src/stores/llm.ts) | provider / model 状态 |
| [src/stores/course.ts](file:///workspace/edu-loop-mvp/web/src/stores/course.ts) | 五步闭环全部状态与 actions |
| [src/stores/system.ts](file:///workspace/edu-loop-mvp/web/src/stores/system.ts) | 运行模式（是否开放评测中心） |
| [src/views/](file:///workspace/edu-loop-mvp/web/src/views) | 六个页面组件 |
| [src/components/MarkdownView.vue](file:///workspace/edu-loop-mvp/web/src/components/MarkdownView.vue) | 安全 Markdown 渲染 |
| [src/components/SlidePreview.vue](file:///workspace/edu-loop-mvp/web/src/components/SlidePreview.vue) | Vue↔React 桥接的幻灯片预览 |
| [src/utils/markdown.ts](file:///workspace/edu-loop-mvp/web/src/utils/markdown.ts) | 白名单 Markdown → HTML（防 XSS） |

## 2. 启动引导（`main.ts`）

```ts
async function bootstrap(): Promise<void> {
  const app = createApp(App)
  const pinia = createPinia()

  const system = useSystemStore(pinia)
  await system.load()                     // 先拿运行模式（请求 /api/health）

  router.beforeEach(to => {               // 必须在 app.use(router) 之前注册
    if (to.name === 'eval' && !system.evalEnabled) return { path: '/course' }
    return true
  })

  app.use(pinia).use(router).use(ElementPlus, { locale: zhCn })
  app.mount('#app')
}
```

要点：**先拿到运行模式再挂载**，因为生产模式下评测中心的路由与入口都需据此屏蔽；
路由守卫必须在 `app.use(router)` 之前注册（安装时会立即触发首次导航）。

## 3. 路由（`router/index.ts`）

`STEPS` 是「步骤条 + 路由」的单一真相，每项含 `path / name / title / description`：

| # | path | name | 标题 |
| --- | --- | --- | --- |
| 1 | `/course` | course | 生成课程 |
| 2 | `/explain` | explain | 结构化讲解 |
| 3 | `/quiz` | quiz | 测验 |
| 4 | `/review` | review | 间隔重复 |
| 5 | `/rubric` | rubric | 评估量规 |
| - | `/eval` | eval | 评测中心（仅开发模式） |

`/` 与未匹配路径均 `redirect` 到 `/course`；页面组件全部用动态 `import()` 懒加载。

## 4. 布局（`App.vue`）

- **侧边栏**：`el-steps` 纵向步骤条，点击切换路由（页内路由，不整页刷新）。
  `visibleSteps` 按 `system.evalEnabled` 过滤掉评测中心入口；底部展示「题目 N · 到期 N」。
- **顶部栏**：课程选择器（切课程 → `course.selectCourse`）、provider 选择器
  （`llm.setProvider`）、model 选择器，以及一个 **「本地降级 / 真实模型」标签**
  （`llm.isDegraded` 决定颜色与 tooltip 文案）。
- **挂载时**：`llm.load()` 拉 provider 目录；`course.loadCourses()` 拉历史课程。
- `currentStep` 由当前路由反查 `STEPS` 得到，驱动页头标题与描述。

## 5. API 客户端（`api/client.ts`）

### `apiGet` / `apiPost`

基于 `fetch`；非 2xx 时 `toError` 尝试解析 `{ error: { message } }`，否则透传文本。

### `postSse(path, body, handlers)`

**为什么不用 EventSource**：流式接口是 `POST`，而浏览器 `EventSource` 只支持 GET。
因此用 `fetch + ReadableStream` **手动解析 SSE 帧**：

- `dispatch(rawFrame)`：逐行识别 `event:` 与 `data:`，多行 data 以 `\n` 连接；
  优先 `JSON.parse`，失败则回传原始字符串；
- 循环读取 reader，按 `\n\n` 切分事件块；流末尾残留 buffer 也会派发；
- 全程 `try/finally` 释放 reader lock。

```ts
export interface SseHandlers { on?: (event: string, data: unknown) => void; signal?: AbortSignal }
```

## 6. 状态管理（Pinia）

### `stores/system.ts`

读 `/api/health` 得到 `mode`；getter `evalEnabled = mode === 'development'`。
读取失败时保持默认开发模式（避免误藏功能，接口侧仍会拦截）。

### `stores/llm.ts`

- state：`providers`、`provider`、`model`、`defaultProvider`、`defaultModel`；
- getters：`currentProvider` / `currentModels` / `isDegraded` / **`route`**（`{ provider, model }`，
  所有请求体统一携带）；
- actions：`load()`（拉 `/api/llm/providers` 并初始化选择）、`setProvider()`（切换后重置模型）。

### `stores/course.ts`（核心 store）

管理五步闭环全部状态：`courses`、`course`、`lessons`、`questions`、`attempts`、`stats`、
`due`、`reviews`、`rubric`、`evaluation`、`slideDeck`、`slideTask`。

- **getters**：`latestAttemptByQuestion`（每题最近作答）、`wrongQuestions`（错题）、`dueCount`；
- **actions**（对应五步）：
  - `loadCourses` / `selectCourse(id)`（拉详情 + 并发加载题目/复习/量规）；
  - **步骤 1** `createCourse({ topic, material, route, onDelta, onMeta })`：`postSse('/api/courses')`,
    按 `meta/delta/outline/error` 事件更新状态并回调 `onDelta`/`onMeta`；
  - **步骤 2** `explainLesson(lessonId, route, onDelta)`：`postSse(.../explain)`；
  - `generateSlides(lessonId)`：`apiPost(.../slides)`，失败置 `slideTask = 'error'` 但不抛；
  - **步骤 3** `generateQuiz(route, { lessonId?, count? })` / `submitAttempt(questionId, answer, route)`；
  - `loadQuestions` / `loadDue` / `loadReviews`；
  - **步骤 4** `submitReview(questionId, grade)`；
  - **步骤 5** `generateRubric(route)` / `loadRubric()` / `evaluate(route)`。

> 课程状态存于前端内存。**刷新页面后**需用顶部「选择课程」下拉重新选中，`selectCourse`
> 会从后端把讲解、题目、复习、量规全部加载回来。

## 7. 视图组件

| 视图 | 做什么 |
| --- | --- |
| [CourseView.vue](file:///workspace/edu-loop-mvp/web/src/views/CourseView.vue) | 输入主题/资料 → `createCourse` 流式生成；展示实时流文本与生成结果 |
| [ExplainView.vue](file:///workspace/edu-loop-mvp/web/src/views/ExplainView.vue) | 选课次 → 生成讲解（流式）；就绪后并行生成幻灯片预览 |
| [QuizView.vue](file:///workspace/edu-loop-mvp/web/src/views/QuizView.vue) | 按课次/数量出题 → 作答 → 提交判分；展示统计 |
| [ReviewView.vue](file:///workspace/edu-loop-mvp/web/src/views/ReviewView.vue) | 展示今日到期；用五档回味评分（脱口而出→完全不会）提交复习 |
| [RubricView.vue](file:///workspace/edu-loop-mvp/web/src/views/RubricView.vue) | 生成量规 + 依据学习证据评估；维度得分用进度条呈现 |
| [EvalView.vue](file:///workspace/edu-loop-mvp/web/src/views/EvalView.vue) | 评测中心：展示维度锚点、最近/全部评测运行，可触发「最新/全部」评测 |

### `MarkdownView.vue` + `utils/markdown.ts`

渲染模型输出属于**不可信输入**，直接 `v-html` 有 XSS 风险。因此 `markdown.ts` 自实现
零依赖渲染：**先 HTML 转义，再只放行一个很小的语法子集**（标题、列表、代码块、
行内 `` `code` `` / `**bold**` / `*italic*`）。`MarkdownView.vue` 只做
`computed(() => renderMarkdown(source))` + `v-html`。

### `SlidePreview.vue`（Vue↔React 桥接）

用 `@openmaic/renderer` 的 `SlideCanvas` 渲染 PPTist 风格 SlideDeck：

- 采用 **懒加载** React 段；失败时显示占位而不阻断讲解主流程；
- watcher 在 deck 到位时 `await nextTick()` 再 `paint()`（否则容器未渲染，首屏空白）；
- React root **惰性创建**，容器元素变化时重新绑定（容器被 `v-if` 重建后旧 root 已脱离 DOM）；
- 提供分页切换（`slideIndex`）。

## 8. 构建配置（`vite.config.ts`）

- 插件：`@vitejs/plugin-vue` + `@vitejs/plugin-react`（因 SlidePreview 需编译 React 组件）；
- **alias**：
  - `@` → `web/src`；
  - `@openmaic/renderer` → 直接指向 OpenMAIC 源码 `src/index.ts`，`@openmaic/dsl` → 其 `dist/index.js`，
    从而避免安装 OpenMAIC 整棵依赖树；
  - renderer 的外部运行时依赖（react / react-dom / clsx / tailwind-merge / tinycolor2 /
    motion / lucide-react / echarts / html2canvas-pro / html-to-image）**alias 回 web 自己的 node_modules**，
    只 alias 顶层包入口（子路径由各包 exports map 解析）；
- **dev server**：`port: 5173`，`proxy['/api'] → http://127.0.0.1:8787`（后端）。

下一篇：[10-dependencies.md](./10-dependencies.md)。