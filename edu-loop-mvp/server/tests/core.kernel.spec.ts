/**
 * 内核装配测试：验证项目所用的 Cordis 原生内核契约确实成立。
 *
 * 内核已由自研实现改为直接依赖 `@deepseek-ai/cordis`，本测试因此针对
 * Cordis 的行为打桩，覆盖项目实际依赖的四项能力：服务注册与读取、
 * `inject` 依赖门控、fiber 卸载回收服务、`Config`（Standard Schema）校验。
 *
 * 用 Node 内置 `node:test` 零依赖运行：
 *   node --import tsx --test tests/core.kernel.spec.ts
 *
 * @module tests/core.kernel
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 从注册表中取当前已加载插件的名字集合。 */
function pluginNames(ctx: Context): string[] {
  const names: string[] = []
  for (const runtime of ctx.registry.values()) {
    if (runtime.name) names.push(runtime.name)
  }
  return names
}

describe('Cordis 原生内核', () => {
  it('插件通过 ctx.provide 注册服务，可被 ctx.get 读取', async () => {
    const root = new Context()
    await root.plugin({
      name: 'svc',
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', 42)
      },
    })

    assert.equal(root.get('answer'), 42)
    assert.deepEqual(pluginNames(root), ['svc'])
  })

  it('inject 依赖未满足时不加载，满足后自动加载', async () => {
    const root = new Context()
    const ran: string[] = []

    // 消费者先声明：此时 'dep' 尚不存在，apply 不应执行。
    root.plugin({
      name: 'consumer',
      inject: ['dep'],
      apply() {
        ran.push('consumer')
      },
    })
    assert.deepEqual(ran, [])

    // 提供者出现后，依赖被唤醒，消费者加载。
    await root.plugin({
      name: 'provider',
      provide: 'dep',
      apply(ctx) {
        ctx.provide('dep', 1)
      },
    })
    await Promise.resolve()
    assert.deepEqual(ran, ['consumer'])
  })

  it('支持异步 apply：await 之后服务才可用', async () => {
    const root = new Context()
    await root.plugin({
      name: 'async-p',
      provide: 'svc',
      async apply(ctx) {
        await Promise.resolve()
        ctx.provide('svc', 'async')
      },
    })
    assert.equal(root.get('svc'), 'async')
  })

  it('fiber 卸载时自动回收其提供的服务', async () => {
    const root = new Context()
    const fiber = await root.plugin({
      name: 'life',
      provide: 'svc',
      apply(ctx) {
        ctx.provide('svc', 'alive')
      },
    })
    assert.equal(root.get('svc'), 'alive')

    await fiber.dispose()
    assert.equal(root.get('svc'), undefined)
    assert.deepEqual(pluginNames(root), [])
  })

  it('Config 校验失败时装载被拒绝（Standard Schema）', async () => {
    const root = new Context()
    const fiber = root.plugin(
      {
        name: 'cfg',
        provide: 'svc',
        Config: z.object({ v: z.number().required() }),
        apply(ctx: Context, config: { v: number }) {
          ctx.provide('svc', config.v)
        },
      },
      { v: 'not-a-number' } as unknown as { v: number },
    )
    await assert.rejects(() => fiber.await())
    assert.equal(root.get('svc'), undefined)
  })
})
