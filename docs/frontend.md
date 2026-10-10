# 前端移植与集成

## 1. 移植策略

`OpenTeach-frontend/`（包名 `@openteach/frontend`，Next.js 16 + React 19）**直接移植自
OpenMAIC 前端**，客户端仍以相对路径 `/api/*` 发起请求。改动集中在三处：

1. **接口改向**：`next.config.ts` 的 `rewrites.beforeFiles` 把 `/api/:path*` 转发到 OpenTeach 后端；
2. **入口裁剪**：后端未实现的能力域，前端隐藏入口（见第 3 节）；
3. **契约适配**：少量 API 响应形状与前端调用点对齐。

`packages/` 下的 `@openmaic/dsl`、`@openmaic/generation`、`@openmaic/renderer`、
`@openmaic/editor`、`@openmaic/importer`、`@openmaic/storage` 等 SDK 包保持原位，
由 `postinstall` 的 `build:packages` 依次构建。

## 2. 前后端对接：rewrite 代理

[`next.config.ts`](../OpenTeach-frontend/next.config.ts)：

```ts
const openTeachApiBase = process.env.OPENTEACH_API_BASE?.trim().replace(/\/+$/, '')

async rewrites() {
  if (!openTeachApiBase) return []
  return {
    beforeFiles: [{ source: '/api/:path*', destination: `${openTeachApiBase}/api/:path*` }],
  }
}
```

- **未设置 `OPENTEACH_API_BASE` 时保持原状**：请求回落到 Next 自带的 `app/api/**` 路由，前端自给自足；
- **设置后**（如 `http://127.0.0.1:8787`）：`beforeFiles` 在进入本应用自身的路由处理器**之前**
  转发到 OpenTeach 后端，因此 `app/api/**` 被遮蔽（仅作 fallback 保留）；
- **该值在 `next.config` 求值时读取**（`next dev` 启动时 / `next build` 时），
  必须在启动或构建**之前**设置好，运行期改环境变量不生效；
- [`middleware.ts`](../OpenTeach-frontend/middleware.ts) 同样识别该变量：一旦设置，
  `/api/*` 的访问码 / 身份拦截整体交还 OpenTeach 后端，中间件直接放行
  （中间件先于 rewrite 执行，两边必须一致）。

**为什么用同源转发而不是前端直连后端**：直接跨源 fetch 会在 `localhost` 与
`127.0.0.1` 之间触发 SameSite Cookie 问题，导致凭据丢失。同源 rewrite 规避了这一点，
同时让后端生成的课堂链接自然落在前端域名上。

**超时**：`experimental.proxyTimeout` 放宽到 **600 000 ms（10 分钟）**。Next 的
rewrite 代理默认把上游请求限在 30s，会把 `/api/generate/scene-content` 这类
非流式重 LLM 阶段砍成 `socket hang up`。SSE 阶段有心跳保活，不受影响。

其它相关配置：`proxyClientMaxBodySize: '200mb'`；`output: 'standalone'`（非 Vercel）；
`outputFileTracingIncludes` 显式纳入 `skills/openmaic/**`、`undici`、各 sharp-libvips
原生库目录（动态加载 / 运行时 import，追踪器看不到）。

## 3. 入口裁剪与 501

后端未实现的能力域返回 **501 NOT_IMPLEMENTED**（而非 404），前端据此隐藏入口。
当前被隐藏的典型项：

- 文件夹相关操作（`app/page.tsx` 中的入口被硬编码隐藏；`app/api/folders/route.ts`
  依赖 server persistence，无 `DATABASE_URL` 时 404）；
- 部分图像 / 视频 / TTS / ASR 服务入口。

原则：**不让用户点进空页面**。新增能力时，后端实现 → 前端恢复入口。

## 4. 交互 widget 运行时

互动场景（widget）的 HTML 由模型生成，经 `srcDoc` 渲染在 `<iframe>` 中。
[`lib/utils/iframe.ts`](../OpenTeach-frontend/lib/utils/iframe.ts) 的 `patchHtmlForIframe`
注入两段 shim（顺序有意：**错误捕获在最前**，以便也观察到 storage shim）：

| shim | 解决的问题 |
| --- | --- |
| **storage shim** | iframe 是 `allow-scripts` **不带** `allow-same-origin` 的沙箱（有意为之：两者同时开会让沙箱对模型生成的 HTML 失效）。在 null-origin 文档里触碰 `localStorage` 会抛 `SecurityError`，而很多生成页面在 setup 阶段读写 storage → 脚本在渲染前就崩溃，widget 变空白。shim 在真实 storage 不可访问时替换为内存实现 |
| **runtime-error 捕获** | 生成页面常因运行期错误整体中断。沙箱 iframe 无法被编辑器读取，但可以 `postMessage`：把 `window.onerror`、未处理的 rejection、`console.error` 转发给父页，按场景存储并喂给编辑 AI。因同步错误可能在父页订阅 `message` 监听器之前发生，每次 post 同时入缓冲，父页监听就绪后发 `{ __maicErrorReplayRequest: true }` 触发重放（父页去重） |

另有 `InteractiveIframeHost` + `interactive-iframe-pool.ts`：iframe 元素由 `Stage` 根部的
**稳定宿主**持有（在场景子树之外），按 sceneId 维护条目与 keep-alive（LRU 上限 3），
避免 mode 切换 / 场景切换导致文档被重新解析、丢失 iframe 内状态。

### 4.1 生成侧约束（重要）

由于 widget HTML 里任何未捕获异常都会**中断整个 `<script>`**，互动全部失效
（前端表现为「这个互动未能运行」）。因此生成侧有硬性约定：

- **只用纯文本或 widget 自身实现的 `**粗体**` markdown 语法**，不要调用字符串上
  不存在的方法（曾出现 `'...'.code.bold()` → `undefined.bold` 抛
  `TypeError: Cannot read properties of undefined (reading 'bold')`，整个脚本因此中断）；
- 无意义的自定义方法链一律避免；需要富文本时使用模板已提供的约定。

> 排查提示：前端显示的行号是 `srcDoc` 里的行号（= 存储文件行号 + 注入 shim 的偏移），
> 定位原始文件行号时需要减去该偏移。

## 5. 关键环境变量

| 变量 | 作用 |
| --- | --- |
| `OPENTEACH_API_BASE` | 后端基址（如 `http://127.0.0.1:8787`）。设置后启用 `/api/*` rewrite 代理；未设置则回落到前端自带路由 |
| `DATABASE_URL` | Postgres 连接串。前端服务端持久化与 openmaic-core 的 stages / persistence 路由均必需 |
| `ACCESS_CODE` | 站点访问码（OpenMAIC 原有能力）；设置后未通过校验的 `/api/*` 返回 401 |
| `ALLOWED_FRAME_ANCESTORS` | 额外允许的 iframe 祖先源；未设置时用 `X-Frame-Options: SAMEORIGIN` |
| `NEXT_PUBLIC_PI_CHAT_ENABLED` | 构建期固定值，运行期覆盖不会关闭客户端已构建的路由 |

## 6. 本地启动

```sh
cd OpenTeach-frontend
pnpm install            # postinstall 会构建 packages/ 下的 SDK
pnpm db:up              # 启动 docker compose 的 Postgres（DATABASE_URL 必需）
pnpm dev                # next dev，默认 http://localhost:3000
```

记得先把 `OPENTEACH_API_BASE` 与 `DATABASE_URL` 写入 `.env.local`（模板见
`OpenTeach-frontend/.env.example`），并在启动**之前**设置 —— 前者在 config 求值时读取。
后端单独启动见 [development.md](./development.md)。
