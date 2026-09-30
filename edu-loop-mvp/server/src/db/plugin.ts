/**
 * db 插件：把 SQLite 连接与 Repository 注册为内核服务。
 *
 * `provide: ['db', 'repo']`（SQLiteDatabase + Repository）。卸载时关闭连接。
 *
 * @module db/plugin
 */

import type { Context } from '../core/context.js'
import type { Plugin } from '../core/plugin.js'
import { createDatabase } from './index.js'
import { Repository } from './repo.js'

export interface DbPluginConfig {
  /** SQLite 库文件路径。 */
  filePath: string
}

export const dbPlugin: Plugin<DbPluginConfig> = {
  name: 'edu-loop:db',
  provide: ['db', 'repo'],
  apply(ctx: Context, config: DbPluginConfig) {
    const db = createDatabase(config.filePath)
    const repo = new Repository(db)
    ctx.service('db', db, 'edu-loop:db')
    ctx.service('repo', repo, 'edu-loop:db')
    return () => {
      try {
        db.close()
      } catch (error) {
        console.error('[db] 关闭连接时抛错', error)
      }
    }
  },
}

/** 便捷读取：从内核取 Repository。 */
export function useRepo(ctx: Context): Repository {
  return ctx.get<Repository>('repo')
}