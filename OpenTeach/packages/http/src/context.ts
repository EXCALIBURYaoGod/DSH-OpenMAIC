/**
 * 应用上下文与 provider 选择。
 *
 * @module context
 */

import type { LoadedLlm } from '@openteach/plugin-llm/loader'
import type { LlmRuntime } from '@openteach/plugin-llm/registry'
import type { Repository } from '@openteach/plugin-db/repo'
import type { OpenmaicSlideService } from '@openteach/plugin-slide'
import type { OpenmaicClassroomService } from '@openteach/plugin-classroom'
import type { OpenmaicStorageService } from '@openteach/plugin-storage'

export interface AppContext {
  runtime: LlmRuntime
  repo: Repository
  llm: LoadedLlm
  /** 可选：openmaic-slide 服务；未装配时为 undefined（调用方需降级处理）。 */
  slide?: OpenmaicSlideService
  /** 可选：openmaic-classroom 编排服务；未装配时为 undefined（课堂路由降级 501）。 */
  classroom?: OpenmaicClassroomService
  /** 可选：openmaic 文档存储（场景取数 / dsl 校验）。 */
  storage?: OpenmaicStorageService
}