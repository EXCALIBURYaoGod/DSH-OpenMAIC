/**
 * `next/headers` 的 `cookies()` 返回值的 shim。
 *
 * OpenMAIC 只在 `access-code/{status,verify}` 两处用 cookie：读取 `openmaic_access`
 * 与写入 `openmaic_access`。这里实现读/写两用、行为与 Next.js 对齐的最小存储：
 * - 读：解析请求的 `cookie` 头；
 * - 写：把 `set`/`delete` 序列化成 `Set-Cookie`，由分发器合并到响应上。
 *
 * @module openmaic-core/shim/cookie-store
 */

/** `set()` 的选项，字段名与 Next.js / `cookie` 包一致。 */
export interface CookieOptions {
  path?: string
  domain?: string
  maxAge?: number
  expires?: Date
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none' | boolean
  priority?: 'low' | 'medium' | 'high'
}

export interface CookieRecord {
  name: string
  value: string
}

export interface CookieStoreLike {
  get(name: string): CookieRecord | undefined
  getAll(): CookieRecord[]
  has(name: string): boolean
  set(name: string, value: string, options?: CookieOptions): CookieStoreLike
  delete(name: string): CookieStoreLike
  /** `set`/`delete` 产生的完整 `Set-Cookie` 头值，按写入顺序。 */
  readonly setCookieHeaders: string[]
}

/** 解析 `cookie` 请求头；对畸形片段采取「跳过」而非抛错。 */
function parseCookieHeader(header: string | undefined): CookieRecord[] {
  if (!header) return []
  const out: CookieRecord[] = []
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (name === '') continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      out.push({ name, value: decodeURIComponent(value) })
    } catch {
      out.push({ name, value })
    }
  }
  return out
}

function serializeSameSite(value: CookieOptions['sameSite']): string | null {
  if (value === undefined || value === false) return null
  if (value === true) return 'Strict'
  const normalized = value.toLowerCase()
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'none') return 'None'
  return null
}

/** 序列化一个 cookie（同 `cookie` 包的 `serialize`）。 */
function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  let str = `${name}=${encodeURIComponent(value)}`
  const sameSite = serializeSameSite(options.sameSite)
  if (options.maxAge !== undefined) str += `; Max-Age=${Math.floor(options.maxAge)}`
  if (options.domain) str += `; Domain=${options.domain}`
  if (options.path) str += `; Path=${options.path}`
  if (options.expires) str += `; Expires=${options.expires.toUTCString()}`
  if (options.httpOnly) str += '; HttpOnly'
  if (options.secure) str += '; Secure'
  if (sameSite) str += `; SameSite=${sameSite}`
  if (options.priority) str += `; Priority=${options.priority[0].toUpperCase()}${options.priority.slice(1)}`
  return str
}

/** 创建一次请求的 cookie 存储。 */
export function createCookieStore(cookieHeader: string | undefined): CookieStoreLike {
  const jar = new Map<string, string>()
  for (const record of parseCookieHeader(cookieHeader)) jar.set(record.name, record.value)
  const setCookieHeaders: string[] = []

  const store: CookieStoreLike = {
    get(name) {
      const value = jar.get(name)
      return value === undefined ? undefined : { name, value }
    },
    getAll() {
      return [...jar.entries()].map(([name, value]) => ({ name, value }))
    },
    has(name) {
      return jar.has(name)
    },
    set(name, value, options) {
      jar.set(name, value)
      setCookieHeaders.push(serializeCookie(name, value, options))
      return store
    },
    delete(name) {
      jar.delete(name)
      setCookieHeaders.push(
        serializeCookie(name, '', { path: '/', expires: new Date(0), maxAge: 0 }),
      )
      return store
    },
    setCookieHeaders,
  }
  return store
}