/**
 * 从模型输出里提取 JSON。
 *
 * 真实模型经常在 JSON 前后附带说明文字或 ```json 代码围栏，因此这里做三档尝试：
 * 1) 直接 parse；2) 剥离代码围栏后 parse；3) 取第一个 `{` 到最后一个配平的 `}` 再 parse。
 *
 * @module teaching/json
 */

export function extractJson<T>(text: string): T {
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim())

  const balanced = sliceBalancedObject(trimmed)
  if (balanced !== undefined) candidates.push(balanced)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error(`无法从模型输出中解析 JSON：${trimmed.slice(0, 200)}`)
}

/** 取第一个 `{` 到与之配平的 `}`（忽略字符串内部的花括号）。 */
function sliceBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}