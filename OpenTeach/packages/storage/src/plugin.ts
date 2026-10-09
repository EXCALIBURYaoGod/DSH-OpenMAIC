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

import type { Context } from '@deepseek-ai/cordis'
import type { SqliteDatabase } from '@openteach/plugin-db/sqlite'
import { bindable } from '@openteach/plugin-db/sqlite'

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

/**
 * 一个持久化场景。既可承载本项目的轻量视图（`id`/`title`/`content`），
 * 也可承载 dsl 契约的完整 {@link Scene}（`type`/`stageId`/`order`/`actions`）。
 * 含 `type` 与 `stageId` 时按 dsl `validateScene` 校验。
 */
export interface StoredScene {
  id: string
  title?: string
  content?: unknown
  /** dsl Scene 类型判别字段（slide / interactive / pbl …）。 */
  type?: string
  /** 所属 dsl Stage id。 */
  stageId?: string
  /** 场景播放顺序。 */
  order?: number
  /** dsl 动作序列。 */
  actions?: unknown
}

/** 一个持久化的课程文档（dsl Stage 元数据 + 有序 scenes，dsl 契约的归一化视图）。 */
export interface StoredDocument {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** 每页场景（各自含 title 等，顺序即播放顺序）。 */
  scenes: StoredScene[]
  /** dsl Stage 聚合根（存在时按 dsl `validateStage` 校验）。 */
  stage?: unknown
  /** 附加的 dsl 契约元数据。 */
  meta?: Record<string, unknown>
}

export interface DocumentStoreContract {
  saveDocument(doc: StoredDocument): Promise<void>
  loadDocument(id: string): Promise<StoredDocument | null>
  listDocuments(): Promise<DocumentSummary[]>
  /** 增量 upsert 单个 scene：已存在则替换（保持原有位置），否则追加到末尾。对齐 dsl 契约的 putScene。 */
  putScene(id: string, scene: StoredScene): Promise<void>
  deleteDocument(id: string): Promise<void>
}

export type DslValidation = { valid: boolean; issues?: string[] }

export interface OpenmaicStorageService {
  kv: KVStoreContract
  docs: DocumentStoreContract
  /** 真机 @openmaic/dsl 是否可用（false 时保存不做 dsl 结构校验，仅宽松断言）。 */
  dslAvailable: boolean
  /** 接入的 dsl 版本（降级为 null）。 */
  dslVersion: string | null
  /** 按 dsl 契约校验 Stage（dsl 不可用时降级为宽松断言）。 */
  validateStage(doc: unknown): DslValidation
  /** 按 dsl 契约校验 Scene（dsl 不可用时降级为宽松断言）。 */
  validateScene(doc: unknown): DslValidation
  /** 校验整个文档（`stage` + dsl 形状的 `scenes`）。 */
  validateDocument(doc: StoredDocument): DslValidation
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** KVStore 契约（按 scope 分设备/账户）。 */
    'kv.store': KVStoreContract
    /** DocumentStore 契约（stage 元数据 + 有序 scenes）。 */
    'docs.store': DocumentStoreContract
    /** 聚合存储服务（含 @openmaic/dsl 校验能力）。 */
    'openmaic.storage': OpenmaicStorageService
  }
}

// ---------------------------------------------------------------------------
// @openmaic/dsl 校验（复用真机 validateStage / validateScene，可降级）
// ---------------------------------------------------------------------------

type DslValidationResult =
  | { valid: true }
  | { valid: false; errors: Array<{ path: string; message: string }> }

interface LoadedDsl {
  DSL_VERSION: string
  validateStage: (doc: unknown) => DslValidationResult
  validateScene: (doc: unknown) => DslValidationResult
}

/** 动态加载真机 @openmaic/dsl（specifier 动态拼装以规避 tsc 静态解析）；失败返回 null。 */
async function tryLoadOpenmaicDsl(): Promise<LoadedDsl | null> {
  try {
    const spec = ['@openmaic', 'dsl'].join('/')
    const mod = (await import(/* @vite-ignore */ spec)) as Partial<LoadedDsl>
    if (typeof mod?.validateStage !== 'function' || typeof mod?.validateScene !== 'function') return null
    return {
      DSL_VERSION: typeof mod.DSL_VERSION === 'string' ? mod.DSL_VERSION : 'unknown',
      validateStage: mod.validateStage,
      validateScene: mod.validateScene,
    }
  } catch {
    return null
  }
}

/** 判断一个场景是否为 dsl 契约形状（含 `type` 与 `stageId`）。 */
function isDslScene(scene: unknown): boolean {
  if (scene === null || typeof scene !== 'object') return false
  const record = scene as Record<string, unknown>
  return typeof record.type === 'string' && typeof record.stageId === 'string'
}

/** 校验器束：dsl 可用时用真机校验，否则降级为「必须是对象」的宽松断言。 */
interface DslValidators {
  dslAvailable: boolean
  dslVersion: string | null
  validateStage(doc: unknown): DslValidation
  validateScene(doc: unknown): DslValidation
  validateDocument(doc: StoredDocument): DslValidation
}

function toValidation(result: DslValidationResult): DslValidation {
  return result.valid
    ? { valid: true }
    : { valid: false, issues: result.errors.map((e) => `${e.path}: ${e.message}`) }
}

/** dsl 不可用时的宽松断言：至少是一个对象。 */
function looseValidate(doc: unknown): DslValidation {
  if (doc === null || typeof doc !== 'object') {
    return { valid: false, issues: ['期望一个对象（@openmaic/dsl 未接入，仅做宽松断言）'] }
  }
  return { valid: true }
}

function createValidators(dsl: LoadedDsl | null): DslValidators {
  const validateStage = dsl ? (doc: unknown) => toValidation(dsl.validateStage(doc)) : looseValidate
  const validateScene = dsl ? (doc: unknown) => toValidation(dsl.validateScene(doc)) : looseValidate
  return {
    dslAvailable: dsl !== null,
    dslVersion: dsl?.DSL_VERSION ?? null,
    validateStage,
    validateScene,
    validateDocument(doc) {
      const issues: string[] = []
      if (doc.stage !== undefined) {
        const result = validateStage(doc.stage)
        if (!result.valid) issues.push(...(result.issues ?? []).map((issue) => `stage/${issue}`))
      }
      for (const scene of doc.scenes) {
        if (!isDslScene(scene)) continue
        const result = validateScene(scene)
        if (!result.valid) issues.push(...(result.issues ?? []).map((issue) => `scene(${scene.id})/${issue}`))
      }
      return issues.length === 0 ? { valid: true } : { valid: false, issues }
    },
  }
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
  constructor(
    private readonly db: SqliteDatabase,
    private readonly validators: DslValidators,
  ) {}

  async saveDocument(doc: StoredDocument): Promise<void> {
    // 保存前按 dsl 契约校验 stage 与 dsl 形状的 scenes；不通过则拒绝写入。
    const check = this.validators.validateDocument(doc)
    if (!check.valid) {
      throw new Error(`openmaic-storage: 文档 ${doc.id} 未通过 dsl 校验：${(check.issues ?? []).join('; ')}`)
    }
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

  async putScene(id: string, scene: StoredScene): Promise<void> {
    // dsl 形状的 scene 先校验，不通过则拒绝写入。
    if (isDslScene(scene)) {
      const check = this.validators.validateScene(scene)
      if (!check.valid) {
        throw new Error(`openmaic-storage: 场景 ${scene.id} 未通过 dsl 校验：${(check.issues ?? []).join('; ')}`)
      }
    }
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
// 插件（Cordis 原生：命名导出 name / provide / inject / apply）
// ---------------------------------------------------------------------------

export const name = 'openmaic:storage'
export const inject = ['db']
export const provide = ['kv.store', 'docs.store', 'openmaic.storage']

export async function apply(ctx: Context): Promise<() => void> {
  const db = ctx.get('db')!
  db.exec(STORAGE_SCHEMA)

  // 复用真机 @openmaic/dsl 的 validateStage / validateScene 做保存时校验（不可用时降级）。
  const dsl = await tryLoadOpenmaicDsl()
  const validators = createValidators(dsl)

  const kv = new SqliteKVStore(db)
  const docs = new SqliteDocumentStore(db, validators)

  const service: OpenmaicStorageService = {
    kv,
    docs,
    dslAvailable: validators.dslAvailable,
    dslVersion: validators.dslVersion,
    validateStage: (doc) => validators.validateStage(doc),
    validateScene: (doc) => validators.validateScene(doc),
    validateDocument: (doc) => validators.validateDocument(doc),
  }

  ctx.provide('kv.store', kv)
  ctx.provide('docs.store', docs)
  ctx.provide('openmaic.storage', service)

  if (!dsl) {
    console.warn('[openmaic] 未解析到 @openmaic/dsl 产物，storage 保存校验降级为宽松断言（不阻断闭环）。')
  }

  return () => {
    // 表由 db 插件统一管理生命周期；此处无需额外清理（连接不在本插件掌控）。
  }
}

/** 便捷读取（含 dsl 校验能力）。 */
export function useOpenmaicStorage(ctx: Context): OpenmaicStorageService {
  return ctx.get('openmaic.storage')!
}