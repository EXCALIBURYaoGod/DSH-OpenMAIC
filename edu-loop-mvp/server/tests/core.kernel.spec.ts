/**
 * 内核单元测试：插件装配 / 依赖注入 / 生命周期。
 *
 * 用 Node 内置 `node:test` 零依赖运行：
 *   node --import tsx --test tests/core.kernel.spec.ts
 *
 * @module tests/core.kernel
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createKernel } from '../src/core/kernel.js'
import { KernelError } from '../src/core/errors.js'
import type { Plugin } from '../src/core/plugin.js'

describe('createKernel()', () => {
  it('按序加载插件、提供服务并可在卸载时删除服务', async () => {
    const kernel = createKernel()
    const spy: string[] = []

    await kernel.plugin<{ v: number }>({
      name: 'tier-1',
      provide: 'a',
      apply(ctx, config) {
        ctx.service('a', { value: config.v }, 'tier-1')
        spy.push('apply-a')
        return () => spy.push('dispose-a')
      },
    }, { v: 1 })

    // 依赖注入：b 依赖 a。
    await kernel.plugin({
      name: 'tier-2',
      inject: ['a'],
      provide: 'b',
      apply(ctx) {
        const a = ctx.get<{ value: number }>('a')
        ctx.service('b', a.value + 1, 'tier-2')
      },
    })

    assert.equal(kernel.root.get<{ value: number }>('a').value, 1)
    assert.equal(kernel.root.get<number>('b'), 2)
    assert.deepEqual(kernel.listPlugins(), ['tier-1', 'tier-2'])
    assert.deepEqual(spy, ['apply-a'])
  })

  it('支持异步 apply：await 后服务才注册', async () => {
    const kernel = createKernel()
    const handle = await kernel.plugin({
      name: 'async-p',
      provide: 'svc',
      async apply(ctx) {
        await Promise.resolve()
        ctx.service('svc', 'async', 'async-p')
      },
    })
    assert.equal(kernel.root.get('svc'), 'async')
    assert.equal(kernel.root.has('svc'), true)
    handle.dispose()
    assert.equal(kernel.root.has('svc'), false)
  })

  it('依赖缺失时抛 MISSING_DEPENDENCY', async () => {
    const kernel = createKernel()
    await assert.rejects(
      kernel.plugin({ name: 'x', inject: ['nope'], apply: () => {} }),
      (e: KernelError) => e.code === 'MISSING_DEPENDENCY',
    )
  })

  it('重复提供同一服务时抛 DUPLICATE_SERVICE（全有或全无）', async () => {
    const kernel = createKernel()
    await kernel.plugin({ name: 'p1', provide: 'svc', apply: ctx => ctx.service('svc', 1, 'p1') })
    await assert.rejects(
      kernel.plugin({ name: 'p2', provide: 'svc', apply: () => {} }),
      (e: KernelError) => e.code === 'DUPLICATE_SERVICE',
    )
  })

  it('config 校验失败抛 INVALID_CONFIG', async () => {
    const kernel = createKernel()
    await assert.rejects(
      kernel.plugin({
        name: 'cfg',
        Config: (c: { v?: number }) => c.v !== undefined,
        apply: () => {},
      }, {}),
      (e: KernelError) => e.code === 'INVALID_CONFIG',
    )
  })

  it('apply 抛错时不留下已注册服务（回滚）', async () => {
    const kernel = createKernel()
    await assert.rejects(kernel.plugin({
      name: 'boom',
      provide: ['s1', 's2'],
      apply(ctx) {
        ctx.service('s1', 1, 'boom')
        throw new Error('boom')
      },
    }))
    assert.equal(kernel.root.has('s1'), false)
    assert.equal(kernel.root.has('s2'), false)
  })

  it('dispose 幂等：调用 disposer 并删除其提供的服务', async () => {
    const kernel = createKernel()
    let disposed = 0
    const handle = await kernel.plugin({
      name: 'life',
      provide: 'svc',
      apply(ctx) {
        ctx.service('svc', 'alive', 'life')
        return () => { disposed += 1 }
      },
    })
    assert.equal(kernel.root.get('svc'), 'alive')

    handle.dispose()
    handle.dispose() // 幂等
    assert.equal(disposed, 1)
    assert.equal(kernel.root.has('svc'), false)
    assert.deepEqual(kernel.listPlugins(), [])
  })

  it('事件总线：plugin.loaded / plugin.disposed', async () => {
    const kernel = createKernel()
    const events: string[] = []
    kernel.root.on('plugin.loaded', (name: unknown) => events.push(`loaded:${name as string}`))
    kernel.root.on('plugin.disposed', (name: unknown) => events.push(`disposed:${name as string}`))
    const handle = await kernel.plugin({ name: 'evt', apply: () => {} })
    handle.dispose()
    assert.deepEqual(events, ['loaded:evt', 'disposed:evt'])
  })
})