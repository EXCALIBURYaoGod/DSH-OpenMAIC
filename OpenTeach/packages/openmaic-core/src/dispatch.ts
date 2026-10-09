/**
 * OpenMAIC 核心分发器：把 Node `IncomingMessage` 适配成 Next.js route handler 的
 * `NextRequest`，并把返回的 `Response` 写回 `ServerResponse`。
 *
 * 设计要点：
 * - **不消费未命中的请求**：只有路径命中路由表后才读取请求体，未命中立即 `next()`，
 *   把控制权交还给 Express 的其余中间件（`express.json()` 等）。
 * - **完整 URL**：用含 `/api` 的完整路径构造 `NextRequest`，因为 `persistence` 路由
 *   依赖 `request.url` 剥前缀。
 * - **请求体缓冲**：命中后把 body 收成 `Buffer` 交给 `Request`；Fetch 会把 Buffer
 *   规范化成 `ReadableStream`，因此 `request.body`（persistence 依赖）与
 *   `request.json()` / `formData()`（其余路由依赖）同时成立，且无需 `duplex`。
 * - **响应流式回写**：`Readable.fromWeb(response.body).pipe(res)` 保留 SSE 语义。
 * - **Cookie 合并**：`cookies().set()` 写入的 `Set-Cookie` 由请求作用域收集后并到响应。
 *
 * @module openmaic-core/dispatch
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { NextRequest } from './shim/server'
import { createRequestScope, runWithRequestScope, type RequestScope } from './shim/context'
import { matchRoute, type RouteMatch } from './router'

/** Express 可直接 `app.use()` 的 Node 风格中间件。 */
export type OpenmaicCoreHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

/** 构造 `Request` 时应从入站头里剔除的逐跳/长度相关字段。 */
const SKIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
])

/** 读取请求体；无体的方法返回 `undefined`。 */
async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined
  if (req.readableEnded) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

/** 由入站头构造 `Headers`。 */
function buildRequestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (SKIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.append(key, value)
    }
  }
  return headers
}

/**
 * 解析请求来源。优先 `x-forwarded-*`（前端 dev server 反代时由 Next 重写补齐，
 * 使生成的课堂分享链接指向前端域名而非后端端口），否则退回 `Host`。
 */
function resolveOrigin(req: IncomingMessage): string {
  const forwardedHost = req.headers['x-forwarded-host']
  const forwardedProto = req.headers['x-forwarded-proto']
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost
  if (host) {
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto
    return `${proto ?? 'http'}://${host}`
  }
  const rawHost = req.headers.host
  const proto = (req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http'
  return rawHost ? `${proto}://${rawHost}` : 'http://localhost'
}

/** 从 `req.url` 中剥离查询串，得到 pathname。 */
function pathnameOf(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?')
  return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl
}

/** 把 handler 返回的 `Response` 写回 `ServerResponse`。 */
async function writeResponse(
  res: ServerResponse,
  response: Response,
  scope: RequestScope,
  method: string,
): Promise<void> {
  if (res.writableEnded || res.destroyed) return

  res.statusCode = response.status

  // `Set-Cookie` 不能在 Headers 迭代里逐条 setHeader（会被覆盖），单独收集。
  const setCookies: string[] = []
  const cookieHeader = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof cookieHeader.getSetCookie === 'function') {
    setCookies.push(...cookieHeader.getSetCookie())
  }
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue
    res.setHeader(key, value)
  }
  setCookies.push(...scope.cookies.setCookieHeaders)
  if (setCookies.length > 0) res.setHeader('set-cookie', setCookies)

  scheduleAfterTasks(scope)

  const bodyless =
    method === 'HEAD' ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304 ||
    response.body === null

  if (bodyless) {
    res.end()
    return
  }

  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('error', (error) => {
    console.error('[openmaic-core] response stream failed', error)
    res.destroy(error as Error)
  })
  stream.pipe(res)
}

/** 响应写出后执行 `after()` 登记的任务（`generate-classroom` 的后台生成）。 */
function scheduleAfterTasks(scope: RequestScope): void {
  if (scope.afterTasks.length === 0) return
  const tasks = scope.afterTasks.splice(0)
  setImmediate(() => {
    for (const task of tasks) {
      void Promise.resolve()
        .then(task)
        .catch((error) => console.error('[openmaic-core] after() task failed', error))
    }
  })
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function handleMatch(
  match: RouteMatch,
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()

  if (match.handler === undefined) {
    res.setHeader('allow', match.allowed.join(', '))
    sendJson(res, 405, {
      success: false,
      errorCode: 'METHOD_NOT_ALLOWED',
      error: `该路由不支持 ${method}`,
    })
    return
  }

  const body = await readRequestBody(req)
  const headers = buildRequestHeaders(req)
  const url = new URL(rawUrl, resolveOrigin(req))

  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body
  const request = new NextRequest(url, init)

  const scope = createRequestScope(headers.get('cookie') ?? undefined)
  const context = { params: Promise.resolve(match.params) }

  const response = await runWithRequestScope(scope, async () => await match.handler(request, context))
  await writeResponse(res, response, scope, method)
}

/**
 * 创建 Express 中间件。命中路由表则由本处理器应答，否则 `next()` 透传。
 */
export function createOpenmaicCoreHandler(): OpenmaicCoreHandler {
  return function openmaicCore(req, res, next) {
    const rawUrl = req.originalUrl ?? req.url ?? '/'
    const match = matchRoute(pathnameOf(rawUrl), (req.method ?? 'GET').toUpperCase())
    if (match === null) {
      next()
      return
    }
    void handleMatch(match, req, res, rawUrl).catch((error: unknown) => {
      console.error('[openmaic-core] dispatch failed', error)
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, 500, {
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: 'OpenMAIC 核心路由执行失败',
      })
    })
  }
}