/**
 * db 插件：把 SQLite 连接与 Repository 注册为 Cordis 服务 `db` / `repo`。
 *
 * DSH 范式：命名导出 `name` / `provide` / `Config` / `apply`；服务经 `ctx.provide()`
 * 注册并随 fiber 卸载自动回收，连接关闭挂在 `apply` 返回的 disposer 上。
 *
 * @module db/plugin
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createDatabase } from './index.js'
import { Repository } from './repo.js'
import type { SqliteDatabase } from './sqlite.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 已打开的 SQLite 连接。 */
    db: SqliteDatabase
    /** 五步教学闭环的仓储。 */
    repo: Repository
  }
}

export const name = 'edu-loop:db'
export const provide = ['db', 'repo']

/** db 插件配置。 */
export interface Config {
  /** SQLite 库文件路径。 */
  filePath: string
}

export const Config: z<Config> = z.object({
  filePath: z.string().required().description('SQLite 库文件路径'),
})

export function apply(ctx: Context, config: Config): () => void {
  const db = createDatabase(config.filePath)
  const repo = new Repository(db)
  ctx.provide('db', db)
  ctx.provide('repo', repo)
  return () => {
    try {
      db.close()
    } catch (error) {
      console.error('[db] 关闭连接时抛错', error)
    }
  }
}

/** 便捷读取：从内核取 Repository。 */
export function useRepo(ctx: Context): Repository {
  return ctx.get('repo')!
}
