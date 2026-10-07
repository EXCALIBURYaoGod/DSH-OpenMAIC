# 02 · 后端装配与启动流程

本篇覆盖后端「内核装配 → HTTP 服务启动」这条主线，涉及文件：
[index.ts](file:///workspace/edu-loop-mvp/server/src/index.ts)、
[app.ts](file:///workspace/edu-loop-mvp/server/src/app.ts)、
[context.ts](file:///workspace/edu-loop-mvp/server/src/context.ts)、
[config/env.ts](file:///workspace/edu-loop-mvp/server/src/config/env.ts)、
[config/mode.ts](file:///workspace/edu-loop-mvp/server/src/config/mode.ts)、
[http/plugin.ts](file:///workspace/edu-loop-mvp/server/src/http/plugin.ts)。

## 1. Cordis 插件范式

本项目直接依赖 `@deepseek-ai/cordis` 作为插件内核。一个插件就是一个模块，通过**命名导出**声明：

| 导出 | 作用 |
| --- | --- |
| `name` | 插件名（出现在诊断日志与 `/api/plugins`） |
| `provide` | 本插件注册的服务名（`string` 或 `string[]`） |
| `inject` | 依赖的服务名数组；未满足时插件不执行 `apply`，满足后自动唤醒 |
| `Config` | schemastery 的 Standard Schema，用于校验传给 `root.plugin()` 的配置 |
| `apply(ctx, config)` | 插件主体；可同步或异步，可返回 disposer 做清理 |

服务通过 `ctx.provide(name, value)` 注册，随插件 fiber 卸载自动回收——这是本项目
「生命周期不泄漏」的基础保障（见 [tests/core.kernel.spec.ts](file:///workspace/edu-loop-mvp/server/tests/core.kernel.spec.ts) 的验证）。

其中 llm / db / http / openmaic-slide / openmaic-layout / openmaic-storage 等插件均遵循该范式，
且通过在 `declare module '@deepseek-ai/cordis'` 中扩展 `Context` 接口，使 `ctx.get('db')`
等读取具备类型推导。

## 2. 服务入口：`index.ts`

入口负责「读配置 → 装配插件 → 起 HTTP 服务」，路径常量集中在文件顶部：

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `CONFIG_PATH` | `edu-loop-mvp/llm.config.json` | provider profile |
| `ENV_PATH` | `edu-loop-mvp/.env` | 凭据文件 |
| `DB_PATH` | `server/data/edu-loop.db` | SQLite 库文件 |
| `WEB_DIST` | `edu-loop-mvp/web/dist` | 生产模式前端构建产物 |
| `PORT` | `process.env.PORT ?? 8787` | 监听端口 |

`main()` 的流程：

```ts
async function main(): Promise<void> {
  loadDotEnv(ENV_PATH)                 // 1. 先读 .env，凭据解析依赖它
  const mode = resolveAppMode()        // 2. 解析 development / production
  const llmConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  assertValidConfig(llmConfig)         // 3. 启动前校验 provider 配置不变量

  const root = new Context()           // 4. 逐个装配插件（顺序即依赖顺序）
  await root.plugin(llmPlugin, llmConfig)
  await root.plugin(dbPlugin, { filePath: DB_PATH })
  await root.plugin(openmaicStoragePlugin)
  await root.plugin(openmaicGenerationPlugin)
  await root.plugin(openmaicLayoutPlugin)
  await root.plugin(openmaicSlidePlugin)
  await root.plugin(openmaicAudioPlugin)
  await root.plugin(httpPlugin, {
    mode,
    ...(mode === 'production' ? { webDist: WEB_DIST } : {}),
  })

  const app = root.get('app')!          // 5. 取回 Express 实例并监听
  app.listen(PORT, () => { /* 打印模式 / provider / 插件清单 */ })
}
```

启动日志会打印：运行模式、`defaultProvider` / `defaultModel`、以及从
`root.registry.values()` 收集到的**已加载插件名**（`pluginNames()`）。

> `main().catch()` 在启动失败时设置 `process.exitCode = 1`，不做静默吞错。

## 3. 应用上下文：`context.ts`

`AppContext` 是路由层与领域层之间的**依赖袋**，把 Cordis 服务「拍平」成普通对象传给 `createApp`：

```ts
export interface AppContext {
  runtime: LlmRuntime                 // 适配器注册表 + 流式调用
  repo: Repository                    // 数据访问
  llm: LoadedLlm                      // 默认 provider/model + 降级集合 + 配置
  slide?: OpenmaicSlideService        // 可选；未装配时为 undefined（调用方降级）
}
```

两个关键函数：

### `resolveRoute(context, provider?, model?) → ResolvedRoute`

解析本次请求要用的路由。规则：

1. `provider` 缺省 → `context.llm.defaultProvider`；
2. provider 不在 `runtime.listProviders()` 中 → **抛出可读错误**（含可选列表）；
3. `model` 缺省时：若目标是默认 provider 用 `defaultModel`，否则取该 provider 的
   `providers[provider].models[0].id`（`firstModelOrDefault`）；
4. `degraded` 取自 provider 元信息（`info.degraded === true`）。

### `taskContext(context, route, { temperature? }) → LlmTaskContext`

把 `runtime / repo / provider / model / degraded` 与温度打包成 `teaching/llm` 需要的调用上下文。

## 4. Express 装配：`app.ts`

`createApp(context, options)` 负责组装所有中间件与路由，**不关心内核**。

- **中间件**：开发模式 `cors()`（前端跑在 5173）；`express.json({ limit: '2mb' })`。
- **`GET /api/health`**：返回 `{ ok, mode, defaultProvider, defaultModel, providers, time }`，
  前端 `system` store 据此感知运行模式。
- **`GET /api/plugins`**（可选）：诊断拓扑，暴露已加载插件名与已注册服务（由 `http/plugin.ts` 注入）。
- **路由挂载**：`/api/llm`、`/api/eval`、`/api/courses`、`/api/quiz`、`/api/review`、
  `/api/rubric`、`/api/slides`。
- **模式差异**：**评测中心仅开发模式开放**。生产模式下 `/api/eval` 直接返回
  `403 { error: { message: '评测中心仅在开发模式可用' } }`，与前端隐藏入口保持一致。
- **`/api` 404 兜底**：未命中的 API 一律返回 `404 { error: { message: '接口不存在' } }`。
- **生产静态托管**：`options.webDist` 存在且 `index.html` 就绪时，`express.static` 托管构建产物，
  其余路径 `sendFile(index.html)` 支持前端 history 路由（单端口访问）。

`AppOptions` 结构：

```ts
export interface AppOptions {
  mode?: AppMode                    // development | production
  webDist?: string                  // 生产模式前端产物目录
  plugins?: {                       // 插件/服务诊断（供 /api/plugins）
    listPlugins(): string[]
    listServices(): Array<{ name: string; providedBy?: string; available: boolean }>
  }
}
```

## 5. HTTP 插件：`http/plugin.ts`

把「Cordis 服务」转成「Express 应用」的桥梁：

```ts
export const name = 'edu-loop:http'
export const inject = ['llm', 'repo']
export const provide = 'app'

export function apply(ctx: Context, config: HttpPluginConfig = {}): void {
  const llm = ctx.get('llm')!
  const repo = ctx.get('repo')!
  const slide = ctx.get('openmaic.slide')          // 可选，未装配为 undefined
  const appContext: AppContext = { runtime: llm.runtime, repo, llm, ...(slide ? { slide } : {}) }
  const app = createApp(appContext, { mode, webDist, plugins: { listPlugins, listServices } })
  ctx.provide('app', app)
}
```

- `inject: ['llm', 'repo']` 保证进入 `apply` 时依赖已就绪；
- `provide: 'app'` 让 `index.ts` 用 `root.get('app')` 取回实例（因此 http 必须最后装配）；
- **诊断拓扑**：`listPlugins` 遍历 `ctx.registry.values()`；`listServices` 遍历
  `ctx.reflect.store` 的符号键，读取每个服务的 `name` / `fiber.name` / 是否已有值。
- `slide` 服务缺失时不阻断——路由层遇到 `context.slide === undefined` 返回 501，前端隐藏预览。

## 6. 配置与模式

### `config/env.ts` — 极简 `.env` 读取器（零依赖）

- `loadDotEnv(filePath)`：只支持 `KEY=VALUE`、`#` 注释、两侧去引号；**不覆盖已存在的进程环境变量**。
- `resolveCredential(ref)`：`ref` 是**环境变量名**（非明文），读取并 trim；空串视为未配置。
  这是 DSH「凭据引用」约定的落地——`llm.config.json` 里的 `apiKeyEnv` 存的就是变量名。

### `config/mode.ts` — 运行模式

```ts
export type AppMode = 'development' | 'production'
export function resolveAppMode(): AppMode {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
}
```

两套模式的差异汇总：

| 维度 | development | production |
| --- | --- | --- |
| 前端 | vite dev server（5173，HMR） | 后端静态托管 `web/dist`（8787） |
| 跨域 | 需要 `cors()` | 同源，无 CORS |
| `/api` 代理 | vite 代理到 8787 | 不适用 |
| 评测中心 | 开放 | 屏蔽（403 + 前端隐藏入口） |

## 7. 启动相关的小结

- **装配顺序是硬约束**：`llm → db → openmaic* → http`。
- **配置在装配前完成两道校验**：`assertValidConfig`（业务不变量）与插件 `Config`（结构 schema）。
- **降级在 loader 阶段完成**：无凭据的 provider 被 mock 顶替，`degraded` 集合记录该事实，
  随 `LoadedLlm` 向上传播到路由层与前端 UI。

下一篇：[03-llm-layer.md](./03-llm-layer.md) 深入 LLM 抽象层。