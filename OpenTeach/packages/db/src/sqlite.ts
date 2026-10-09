/**
 * `node:sqlite` 的最小类型化封装。
 *
 * Node 22.5+ 内置 `node:sqlite`，因此本项目**零原生依赖**即可落库，
 * 不需要 `better-sqlite3` 那种编译工具链——这对「本地一条命令跑起来」很重要。
 * 通过 `createRequire` 载入以避开不同 @types/node 版本对该模块声明的差异。
 *
 * @module db/sqlite
 */

import { createRequire } from 'node:module'

export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const require_ = createRequire(import.meta.url)
const sqlite = require_('node:sqlite') as SqliteModule

export function openDatabase(path: string): SqliteDatabase {
  return new sqlite.DatabaseSync(path)
}

/** 把 JS 值归一化为 `node:sqlite` 能绑定的类型（它不接受 boolean/undefined）。 */
export function bindable(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  return JSON.stringify(value)
}