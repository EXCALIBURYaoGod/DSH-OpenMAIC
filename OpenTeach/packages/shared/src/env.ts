/**
 * 极简 `.env` 读取器（零依赖）。
 * 只支持 `KEY=VALUE`、`#` 注释、以及两侧去引号；不覆盖已存在的进程环境变量。
 *
 * @module config/env
 */

import { existsSync, readFileSync } from 'node:fs'

export function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/**
 * 读取凭据引用。
 * DSH 的 provider profile 用「环境变量名」而非明文持有凭据，这里沿用同一约定。
 */
export function resolveCredential(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined
  const value = process.env[ref]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}