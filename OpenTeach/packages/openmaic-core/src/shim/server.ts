/**
 * `next/server` 的最小 shim。
 *
 * 端口代码（vendor 的 OpenMAIC route handler 及其依赖）只用到三样东西：
 * - `NextRequest`：仅作类型标注 + 读取 `nextUrl`（`searchParams` / `origin`）；
 * - `NextResponse.json(body, init?)`：唯一的响应构造入口；
 * - `after(task)`：响应发送后执行的后台任务（`generate-classroom` 用）。
 *
 * 这里用原生 `Request` / `Response` 实现等价语义：`NextRequest` 在 `Request`
 * 之上补 `nextUrl`；`NextResponse` 在 `Response` 之上补静态 `json`；`after`
 * 把任务登记到当前请求作用域，由分发器在响应写完后执行。
 *
 * @module openmaic-core/shim/server
 */

import { currentRequestScope, type AfterTask } from './context'
import { createCookieStore, type CookieStoreLike } from './cookie-store'

/** 端口代码里 `NextRequest` 只用到的扩展面：`nextUrl` 与（可选的）cookie 读。 */
export class NextRequest extends Request {
  readonly nextUrl: URL

  constructor(input: string | URL | Request, init?: RequestInit) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    super(input as string | Request, init)
    this.nextUrl = new URL(url)
  }

  /** 惰性构造的 cookie 存储；端口代码未直接使用，保留以对齐契约。 */
  get cookies(): CookieStoreLike {
    const existing = currentRequestScope()?.cookies
    if (existing) return existing
    return createCookieStore(this.headers.get('cookie') ?? undefined)
  }
}

/** 端口代码里 `NextResponse` 只用到的扩展面：静态 `json` / `redirect`。 */
export class NextResponse<Body = unknown> extends Response {
  static json<JsonBody>(body: JsonBody, init?: ResponseInit): NextResponse<JsonBody> {
    const headers = new Headers(init?.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new NextResponse(JSON.stringify(body), { ...init, headers })
  }

  static redirect(url: string | URL, init?: number | ResponseInit): NextResponse<null> {
    const status = typeof init === 'number' ? init : (init?.status ?? 307)
    const headers = new Headers(typeof init === 'number' ? undefined : init?.headers)
    headers.set('location', typeof url === 'string' ? url : url.toString())
    return new NextResponse(null, { status, headers })
  }
}

/**
 * 登记一个响应发送后执行的任务（`next/server` 的 `after`）。
 *
 * 必须在请求作用域内调用；不在作用域内时退化为 `setImmediate`，保证任务不丢。
 */
export function after(task: AfterTask): void {
  const scope = currentRequestScope()
  if (scope) {
    scope.afterTasks.push(task)
    return
  }
  setImmediate(() => {
    void Promise.resolve()
      .then(task)
      .catch((error) => console.error('[openmaic-core] after() task failed', error))
  })
}