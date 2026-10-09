/**
 * 请求作用域（AsyncLocalStorage）。
 *
 * OpenMAIC 的 route handler 直接调用 `next/headers` 的 `cookies()`，它们没有显式
 * 传参的入口。为在没有 Next.js 运行时的 Express 进程里复刻这一行为，分发器在调用
 * handler 前用 {@link runWithRequestScope} 建立作用域，shim 的 `cookies()` 从当前
 * 作用域读取。
 *
 * @module openmaic-core/shim/context
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createCookieStore, type CookieStoreLike } from './cookie-store'

/** `next/server` 的 `after()` 注册的回调。 */
export type AfterTask = () => void | Promise<void>

/** 一次请求的生命周期内可用的上下文。 */
export interface RequestScope {
  /** 由请求 `cookie` 头构造、并承载本次响应 `Set-Cookie` 的 cookie 存储。 */
  cookies: CookieStoreLike
  /** `after()` 注册、响应发送后执行的任务。 */
  afterTasks: AfterTask[]
}

const storage = new AsyncLocalStorage<RequestScope>()

/** 在给定作用域内执行异步函数；作用域内所有 `await` 之后仍可读取。 */
export function runWithRequestScope<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn)
}

/** 当前请求作用域；不在请求内时为 `undefined`。 */
export function currentRequestScope(): RequestScope | undefined {
  return storage.getStore()
}

/** 新建一个请求作用域。 */
export function createRequestScope(cookieHeader: string | undefined): RequestScope {
  return { cookies: createCookieStore(cookieHeader), afterTasks: [] }
}