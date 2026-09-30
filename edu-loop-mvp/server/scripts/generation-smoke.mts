/**
 * openmaic-generation 插件 smoke：用内核装配 llm( mock ) + generation，
 * 验证两阶段生成与服务随插件卸载而移除。
 *
 * 运行：node --import tsx scripts/generation-smoke.mts
 *
 * @module scripts/generation-smoke
 */

import { strict as assert } from 'node:assert'
import { createKernel } from '../src/core/kernel.js'
import { llmPlugin } from '../src/llm/plugin.js'
import type { LlmConfigFile } from '../src/llm/config.js'
import {
  openmaicGenerationPlugin,
  useOpenmaicGeneration,
} from '../src/plugins/openmaic-generation/plugin.js'

async function run(): Promise<void> {
  const kernel = createKernel()

  // mock provider：无凭据也能本地跑通。
  const llmConfig: LlmConfigFile = {
    defaultProvider: 'mock-teacher',
    providers: {
      'mock-teacher': {
        api: 'mock',
        displayName: 'Mock Teacher',
        models: [{ id: 'mock-teacher' }],
      },
    },
  }

  const llmHandle = await kernel.plugin(llmPlugin, llmConfig)
  const genHandle = await kernel.plugin(openmaicGenerationPlugin)
  const generation = useOpenmaicGeneration(kernel.root)

  // 默认路由为 mock → source 应为 mock 且 available=false。
  assert.equal(generation.source, 'mock', '默认路由降级时 source 应为 mock')
  assert.equal(generation.available, false, '默认路由降级时 available 应为 false')

  // 第一阶段：需求 → 大纲。
  const result = await generation.generateSceneOutlinesFromRequirements({
    topic: '矢量与标量',
    learningGoals: '理解矢量加法与合成',
  })
  assert.equal(result.success, true, 'outline 生成应成功')
  const data = result.data!
  assert.equal(typeof data.courseTitle, 'string', '应有课程标题')
  assert.ok(data.outlines.length >= 1, '应至少产出一页大纲')
  assert.ok(data.outlines.every(o => o.type === 'slide' && typeof o.title === 'string'), '每页都有标题')

  // 第二阶段：outline → complete scene（兼容 storage docs.store 场景形状）。
  const scene = generation.buildCompleteScene(data.outlines[0]!, '讲解正文内容')
  assert.equal(scene.content.type, 'slide', 'scene 应为 slide')
  assert.equal(scene.title, data.outlines[0]!.title, 'scene 标题应对齐 outline')

  console.log('[generation] smoke 通过  outline=✓  buildScene=✓  source=mock（降级态）')

  genHandle.dispose()
  assert.equal(kernel.root.has('openmaic.generation'), false, '卸载后服务应移除')
  llmHandle.dispose()
}

run().catch(error => {
  console.error('[generation] smoke 失败', error)
  process.exitCode = 1
})