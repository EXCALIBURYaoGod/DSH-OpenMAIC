/**
 * 服务端到 provider 的 SSE 解析（用于 OpenAI 兼容流式响应）。
 *
 * @module llm/sse
 */

export interface SseEvent {
  event?: string
  data: string
}

/**
 * 把 fetch 的响应体解析为 SSE 事件序列。
 * 按 `\n\n` 切分事件块，逐个提取 `data:` 行（多行 data 以 `\n` 连接）。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseSseBlock(rawEvent)
        if (parsed !== undefined) yield parsed
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    const tail = parseSseBlock(buffer)
    if (tail !== undefined) yield tail
  } finally {
    reader.releaseLock()
  }
}

function parseSseBlock(raw: string): SseEvent | undefined {
  const dataLines: string[] = []
  let event: string | undefined
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
  }
  if (dataLines.length === 0) return undefined
  return { data: dataLines.join('\n'), ...(event === undefined ? {} : { event }) }
}