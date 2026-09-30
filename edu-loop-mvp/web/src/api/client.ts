/**
 * HTTP 客户端与 SSE 读取。
 *
 * 流式接口用 POST，因此不能使用浏览器的 EventSource（它只支持 GET）。
 * 这里用 fetch + ReadableStream 手动解析 SSE 帧。
 *
 * @module api/client
 */

interface ApiErrorBody {
  error?: { message?: string; code?: string }
}

async function toError(response: Response): Promise<Error> {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as ApiErrorBody
    if (body.error?.message !== undefined) return new Error(body.error.message)
  } catch {
    // 非 JSON 响应，直接透传文本
  }
  return new Error(text.length > 0 ? text : `HTTP ${response.status}`)
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw await toError(response)
  return (await response.json()) as T
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw await toError(response)
  return (await response.json()) as T
}

export interface SseHandlers {
  /** 收到某个命名事件时回调。 */
  on?: (event: string, data: unknown) => void
  signal?: AbortSignal
}

/**
 * 发起一个返回 SSE 的 POST 请求，按事件名分发。
 * 返回一个在流结束（或被取消）时 resolve 的函数。
 */
export async function postSse(path: string, body: unknown, handlers: SseHandlers = {}): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
  })
  if (!response.ok) throw await toError(response)
  if (response.body === null) throw new Error('响应没有可读流')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (rawFrame: string): void => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    try {
      handlers.on?.(event, JSON.parse(payload) as unknown)
    } catch {
      handlers.on?.(event, payload)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        dispatch(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim().length > 0) dispatch(buffer)
  } finally {
    reader.releaseLock()
  }
}