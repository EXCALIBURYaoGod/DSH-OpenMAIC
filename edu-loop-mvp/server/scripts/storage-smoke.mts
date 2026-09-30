/**
 * openmaic-storage 插件 smoke：用内核装配 + 真实 SQLite 注入，验证 KVStore + DocumentStore
 * 契约读写，并断言服务随插件卸载而移除。
 *
 * 运行：node --import tsx scripts/storage-smoke.mts
 *
 * @module scripts/storage-smoke
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../src/core/kernel.js'
import { createDatabase } from '../src/db/index.js'
import { openmaicStoragePlugin, useOpenmaicStorage } from '../src/plugins/openmaic-storage/plugin.js'

async function run(): Promise<void> {
  const kernel = createKernel()
  const dir = mkdtempSync(join(tmpdir(), 'eduloop-storage-'))
  const db = createDatabase(join(dir, 'storage.db'))
  // 注册 db 服务以满足插件 inject 依赖。
  kernel.root.service('db', db, 'harness')
  const handle = await kernel.plugin(openmaicStoragePlugin)

  const { kv, docs } = useOpenmaicStorage(kernel.root)

  // --- KVStore 契约 ---
  await kv.set('theme', { dark: true }, 'device')
  assert.deepEqual(await kv.get('theme', 'device'), { dark: true }, 'device KV 读回不一致')
  await kv.set('provider', 'doubao', 'account')
  assert.equal(await kv.get('provider', 'account'), 'doubao', 'account KV 读回不一致')
  assert.equal((await kv.keys('pro', 'account')).includes('provider'), true, 'keys 前缀过滤失败')
  await kv.remove('provider', 'account')
  assert.equal(await kv.get('provider', 'account'), null, 'remove 后应无值')

  // --- DocumentStore 契约 ---
  await docs.saveDocument({
    id: 'course-1',
    name: '矢量与标量',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scenes: [
      { id: 's1', title: '区分', content: { type: 'slide' } },
      { id: 's2', title: '合成', content: { type: 'quiz' } },
    ],
    meta: { author: 'openmaic' },
  })

  const loaded = await docs.loadDocument('course-1')
  assert.equal(loaded?.name, '矢量与标量', 'loadDocument 名称不符')
  assert.equal(loaded?.scenes.length, 2, 'scenes 条数不符')
  assert.equal(loaded?.meta?.author, 'openmaic', 'meta 未持久化')

  const list = await docs.listDocuments()
  assert.equal(list.length, 1, 'listDocuments 应有一条')
  assert.equal(list[0].sceneCount, 2, 'sceneCount 应为 2')
  assert.equal(list[0].id, 'course-1', 'list id 不符')

  await docs.putScene('course-1', { id: 's3', title: '小结', content: { type: 'slide' } })
  assert.equal((await docs.loadDocument('course-1'))?.scenes.length, 3, 'putScene 后应为 3')

  await docs.deleteDocument('course-1')
  assert.equal(await docs.loadDocument('course-1'), null, 'delete 后应无文档')

  console.log('[storage] smoke 通过  kv=✓  docs=save/load/list/putScene/delete=✓')

  handle.dispose()
  assert.equal(kernel.root.has('kv.store'), false, '卸载后 kv.store 应移除')
  assert.equal(kernel.root.has('docs.store'), false, '卸载后 docs.store 应移除')
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

run().catch(error => {
  console.error('[storage] smoke 失败', error)
  process.exitCode = 1
})