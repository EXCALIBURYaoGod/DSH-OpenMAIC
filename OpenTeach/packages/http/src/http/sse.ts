/**
 * Server-Sent Events 输出通道。
 *
 * 选 SSE 而不是 WebSocket：教学流程是「一问一答的流式文本」，单向推送足够，
 * 且 SSE 在浏览器侧只需 fetch + ReadableStream，无额外依赖。
 *
 * @module http/sse
 */

import type { Response } from 'express'

export interface SseChannel {
  /**
   * 下发一帧 SSE。`id` 为可选的帧序号：写入后浏览器端会在断线重连时通过
   * `Last-Event-ID` 请求头回传，服务端据此续传（课堂事件流使用会话内 `seq`）。
   */
  send(event: string, data: unknown, id?: string | number): void
  close(): void
  readonly closed: boolean
}

export function openSse(res: Response): SseChannel {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  // 注意：不能用 `req.on('close')` 判断客户端断开——请求体被 express.json 读完后
  // `req` 会立刻触发 'close'，会把通道误判为已关闭，导致响应永不结束。
  // 这里只监听 `res` 的 'close'（连接真正关闭时才触发）。
  let ended = false
  const onClose = (): void => {
    ended = true
  }
  res.on('close', onClose)

  return {
    get closed() {
      return ended
    },
    send(event, data, id) {
      if (ended) return
      try {
        const idLine = id === undefined ? '' : `id: ${id}\n`
        res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        ended = true
      }
    },
    close() {
      if (ended) return
      ended = true
      res.off('close', onClose)
      res.end()
    },
  }
}

/** 统一错误响应。 */
export function sendError(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({ error: { message, ...(code === undefined ? {} : { code }) } })
}