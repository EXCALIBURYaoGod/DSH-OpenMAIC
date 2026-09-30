/**
 * openmaic-storage 插件：把 `@openmaic/storage` 的持久化契约（KVStore + DocumentStore）
 * 用内置 `node:sqlite` 落地为本地后端，注册为内核服务，作为所有数据能力的统一出口。
 *
 * 契约对齐，不引入浏览器/HTTP 实现：
 * - `kv.store`：KVStore 契约（get/set/remove/keys，按 scope 分设备/账户）。
 * - `docs.store`：DocumentStore 契约（save/load/list/delete + 增量 scene/stage）。
 * 两张 SQLite 表（`storage_kv` / `storage_docs`）挂在由 `db` 插件提供的同一连接上。
 *
 * @module plugins/openmaic-storage
 */

import type { Context } from '../../core/context.js'
import type { Plugin } from '../../core/plugin.js'
import type { SqliteDatabase } from '../../db/sqlite.js'
import { bindable } from '../../db/sqlite.js'

// ---------------------------------------------------------------------------
// 契约类型（对齐 @openmaic/storage 的最小可接入子集）
// ---------------------------------------------------------------------------

export type KVScope = 'device' | 'account'

/** 与 dsl 契约对齐：JSON 可序列化键值，默认 scope 为 account。 */
export interface KVStoreContract {
  get<T>(key: string, scope?: KVScope): Promise<T | null>
  set<T>(key: string, value: T, scope?: KVScope): Promise<void>
  remove(key: string, scope?: KVScope): Promise<void>
  keys(prefix?: string, scope?: KVScope): Promise<string[]>
}

/** 文档结构概要（listDocuments 返回的轻量行，不加载正文）。 */
export interface DocumentSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  sceneCount: number
}

/** 一个持久化的课程文档（stage 元数据 + 有序 scenes，dsl 契约的归一化视图）。 */
export interface StoredDocument {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** 每页场景（各自含 title 等，顺序即播放顺序）。 */
  scenes: Array<{ id: string; title?: string; content?: unknown }>
  /** 附加的 dsl 契约元数据。 */
  meta?: Record<string, unknown>
}

export interface DocumentStoreContract {
  saveDocument(doc: StoredDocument): Promise<void>
  loadDocument(id: string): Promise<StoredDocument | null>
  listDocuments(): Promise<DocumentSummary[]>
  /** 增量 upsert 单个 scene：已存在则替换（保持原有位置），否则追加到末尾。对齐 dsl 契约的 putScene。 */
  putScene(id: string, scene: StoredDocument['scenes'][number]): Promise<void>
  deleteDocument(id: string): Promise<void>
}

export interface OpenmaicStorageService {
  kv: KVStoreContract
  docs: DocumentStoreContract
}

// ---------------------------------------------------------------------------
// SQLite 后端
// ---------------------------------------------------------------------------

const STORAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS storage_kv (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );
  CREATE TABLE IF NOT EXISTS storage_docs (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    scenes     TEXT NOT NULL DEFAULT '[]',
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

function assertScope(scope: KVScope): KVScope {
  if (scope !== 'device' && scope !== 'account') {
    throw new Error(`openmaic-storage: unknown KV scope ${JSON.stringify(scope)}`)
  }
  return scope
}

function parseDoc(row: Record<string, unknown>): StoredDocument {
  return {
    id: String(row.id),
    name: String(row.name),
    scenes: JSON.parse(String(row.scenes)) as StoredDocument['scenes'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.meta ? { meta: JSON.parse(String(row.meta)) as Record<string, unknown> } : {}),
  }
}

/** KVStore 契约的 SQLite 实现。 */
class SqliteKVStore implements KVStoreContract {
  constructor(private readonly db: SqliteDatabase) {}

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    assertScope(scope)
    const row = this.db
      .prepare('SELECT value FROM storage_kv WHERE scope = ? AND key = ?')
      .get(scope, key)
    if (!row) return null
    return JSON.parse(String(row.value)) as T
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    assertScope(scope)
    this.db
      .prepare('INSERT INTO storage_kv (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value')
      .run(scope, key, bindable(JSON.stringify(value)))
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    assertScope(scope)
    this.db.prepare('DELETE FROM storage_kv WHERE scope = ? AND key = ?').run(scope, key)
  }

  async keys(prefix?: string, scope: KVScope = 'account'): Promise<string[]> {
    assertScope(scope)
    const rows =
      prefix === undefined
        ? this.db.prepare('SELECT key FROM storage_kv WHERE scope = ? ORDER BY key').all(scope)
        : this.db
            .prepare('SELECT key FROM storage_kv WHERE scope = ? AND key LIKE ? ORDER BY key')
            .all(scope, `${prefix}%`)
    return rows.map((r) => String(r.key))
  }
}

/** DocumentStore 契约的 SQLite 实现（stage 归一化到单行 + scenes JSON 列）。 */
class SqliteDocumentStore implements DocumentStoreContract {
  constructor(private readonly db: SqliteDatabase) {}

  async saveDocument(doc: StoredDocument): Promise<void> {
    const now = Date.now()
    this.db
      .prepare(`INSERT INTO storage_docs (id, name, scenes, meta, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, scenes = excluded.scenes,
                  meta = excluded.meta, updated_at = excluded.updated_at`)
      .run(
        doc.id,
        doc.name,
        bindable(JSON.stringify(doc.scenes)),
        bindable(JSON.stringify(doc.meta ?? {})),
        doc.createdAt || now,
        now,
      )
  }

  async loadDocument(id: string): Promise<StoredDocument | null> {
    const row = this.db.prepare('SELECT * FROM storage_docs WHERE id = ?').get(id)
    if (!row) return null
    return parseDoc(row)
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const rows = this.db
      .prepare('SELECT id, name, scenes, created_at, updated_at FROM storage_docs ORDER BY updated_at DESC')
      .all()
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      sceneCount: (JSON.parse(String(r.scenes)) as unknown[]).length,
    }))
  }

  async putScene(id: string, scene: StoredDocument['scenes'][number]): Promise<void> {
    const row = this.db.prepare('SELECT scenes FROM storage_docs WHERE id = ?').get(id)
    if (!row) return
    const scenes = JSON.parse(String(row.scenes)) as StoredDocument['scenes']
    const idx = scenes.findIndex((s) => s.id === scene.id)
    if (idx >= 0) scenes[idx] = scene
    else scenes.push(scene)
    this.db
      .prepare('UPDATE storage_docs SET scenes = ?, updated_at = ? WHERE id = ?')
      .run(bindable(JSON.stringify(scenes)), Date.now(), id)
  }

  async deleteDocument(id: string): Promise<void> {
    this.db.prepare('DELETE FROM storage_docs WHERE id = ?').run(id)
  }
}

// ---------------------------------------------------------------------------
// 桩：让插件保持同步 apply（SQLite 全部为同步调用，包装为 Promise 契约）
// ---------------------------------------------------------------------------

export const openmaicStoragePlugin: Plugin = {
  name: 'openmaic:storage',
  inject: ['db'],
  provide: ['kv.store', 'docs.store'],
  apply(ctx: Context) {
    const db = ctx.get<SqliteDatabase>('db')
    db.exec(STORAGE_SCHEMA)

    const kv = new SqliteKVStore(db)
    const docs = new SqliteDocumentStore(db)

    ctx.service('kv.store', kv as unknown, 'openmaic:storage')
    ctx.service('docs.store', docs as unknown, 'openmaic:storage')

    return () => {
      // 表由 db 插件统一管理生命周期；此处无需额外清理（连接不在本插件掌控）。
    }
  },
}

/** 便捷读取。 */
export function useOpenmaicStorage(ctx: Context): OpenmaicStorageService {
  return {
    kv: ctx.get<KVStoreContract>('kv.store'),
    docs: ctx.get<DocumentStoreContract>('docs.store'),
  }
}