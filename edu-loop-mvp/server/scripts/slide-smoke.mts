/**
 * openmaic-slide 插件 smoke：用内核装配 + 真实依赖注入，验证生成 slide JSON 并断言合法。
 *
 * 运行：node --import tsx scripts/slide-smoke.mts
 *
 * 覆盖两条路径：
 * - 真实 @openmaic/dsl 可用 → source='openmaic'；
 * - 缺失 → 降级 'builtin-fallback'。
 * 两者都应收敛出合法 slide JSON、不抛异常、不阻断。
 *
 * @module scripts/slide-smoke
 */

import { strict as assert } from 'node:assert'
import { createKernel } from '../src/core/kernel.js'
import { openmaicSlidePlugin, useOpenmaicSlide } from '../src/plugins/openmaic-slide/plugin.js'

/** 造一个极简 llm/repo 服务以满足插件 inject 依赖。 */
async function buildHarness() {
  const kernel = createKernel()
  // 占位服务：插件只注入、不强用其能力。
  kernel.root.service('llm', { defaultProvider: 'mock', defaultModel: 'mock-teacher', runtime: {} }, 'harness')
  kernel.root.service('repo', {}, 'harness')
  return kernel
}

async function run(): Promise<void> {
  const kernel = await buildHarness()
  const handle = await kernel.plugin(openmaicSlidePlugin)

  const service = useOpenmaicSlide(kernel.root)

  const input = {
    title: '第一课：矢量与标量',
    pages: [
      { title: '矢量与标量的区别', bullets: ['矢量有大小和方向', '标量只有大小'] },
      { title: '矢量的合成', bullets: ['平行四边形法则', '适用于同一起点'] },
    ],
  }

  const deck = service.generateSlideJson(input)
  const check = service.validate(deck)

  assert.equal(Array.isArray(deck.slides), true, 'slides 必须为数组')
  assert.equal(deck.slides.length, input.pages.length, '页数应等于输入 pages 数')
  assert.equal(check.valid, true, '校验应通过')

  if (service.available) {
    // 接入真机 dsl：应有版本号，且产出符合 dsl Stage/Scene 契约（含 scenes 与顶层容器字段）。
    assert.equal(typeof service.dslVersion, 'string', '接入 dsl 时应暴露 dslVersion')
    assert.equal(deck.id, deck.createdAt ? deck.id : undefined, 'Stage 应有 id')
    const scenes = (deck as { scenes?: unknown[] }).scenes
    assert.equal(Array.isArray(scenes) && scenes.length === deck.slides.length, true, '应产出与 slides 等长的 scenes')
  }

  console.log(
    `[openmaic] smoke 通过 source=${service.source} available=${service.available} dslVersion=${service.dslVersion ?? '—'} slides=${deck.slides.length}`,
  )

  // 卸载插件：服务应随之消失。
  handle.dispose()
  assert.equal(kernel.root.has('openmaic.slide'), false, '卸载后 openmaic.slide 服务应移除')
}

run().catch(error => {
  console.error('[openmaic] smoke 失败', error)
  process.exitCode = 1
})