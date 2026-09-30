/**
 * 极简 Markdown 渲染（零依赖）。
 *
 * 为什么不直接用现成的 markdown 库 + v-html：渲染内容是模型输出，属于不可信输入，
 * 直接 v-html 有 XSS 风险。这里先做 HTML 转义，再只放行一个很小的语法子集。
 *
 * @module utils/markdown
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内语法：`code`、**bold**、*italic*。输入必须是已转义的文本。 */
function inline(text: string): string {
  const codes: string[] = []
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`)
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split(/\r?\n/)
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let inCode = false
  let paragraph: string[] = []

  const closeList = (): void => {
    if (listType !== null) {
      html.push(`</${listType}>`)
      listType = null
    }
  }
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph()
      closeList()
      html.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) {
      html.push(`${line}\n`)
      continue
    }

    const trimmed = line.trim()
    if (trimmed.length === 0) {
      flushParagraph()
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushParagraph()
      closeList()
      const level = heading[1]!.length
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    const quote = /^&gt;\s?(.*)$/.exec(trimmed)
    if (quote !== null) {
      flushParagraph()
      closeList()
      html.push(`<blockquote>${inline(quote[1]!)}</blockquote>`)
      continue
    }

    const ordered = /^(\d+)[.、)]\s+(.*)$/.exec(trimmed)
    if (ordered !== null) {
      flushParagraph()
      if (listType !== 'ol') {
        closeList()
        html.push('<ol>')
        listType = 'ol'
      }
      html.push(`<li>${inline(ordered[2]!)}</li>`)
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      flushParagraph()
      if (listType !== 'ul') {
        closeList()
        html.push('<ul>')
        listType = 'ul'
      }
      html.push(`<li>${inline(bullet[1]!)}</li>`)
      continue
    }

    closeList()
    paragraph.push(trimmed)
  }

  flushParagraph()
  closeList()
  if (inCode) html.push('</code></pre>')
  return html.join('\n')
}