/**
 * `next/headers` 的最小 shim：仅 `cookies()`。
 *
 * 返回当前请求作用域里的 cookie 存储；在 `access-code/verify` 里写入的
 * `Set-Cookie` 会由分发器合并到响应上。
 *
 * @module openmaic-core/shim/headers
 */

import { currentRequestScope } from './context'
import type { CookieStoreLike } from './cookie-store'

export async function cookies(): Promise<CookieStoreLike> {
  const scope = currentRequestScope()
  if (!scope) {
    throw new Error('openmaic-core: cookies() was called outside a request scope')
  }
  return scope.cookies
}