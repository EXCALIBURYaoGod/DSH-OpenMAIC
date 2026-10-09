/**
 * OpenMAIC 核心路由表。
 *
 * vendor 进来的 `src/routes/**` 保留了 Next.js 的文件路由目录结构（`app/api/**`）。
 * 这里把它们登记为显式路由表：**静态 import** 保证 esbuild 能一次性把整棵依赖闭包
 * 打进单文件产物（动态 import + 变量 specifier 会让打包器无法静态分析）。
 *
 * 路径按 Next.js 约定编译为 regex：
 * - `[name]`      → 单段动态参数；
 * - `[...name]`   → 尾部 catch-all（参数为段数组，与 Next 语义一致）。
 *
 * 路径均带 `/api` 前缀：本处理器直接挂在 Express 的 `/api` 之下，与运行中
 * OpenMAIC（`next start` 后 `/api/*`）的 URL 形状完全一致 —— `persistence` 路由
 * 会从 `request.url` 里剥掉 `/api/persistence` 前缀，因此必须是完整路径。
 *
 * @module openmaic-core/router
 */

import * as accessCodeStatus from './routes/access-code/status/route'
import * as accessCodeVerify from './routes/access-code/verify/route'
import * as classroom from './routes/classroom/route'
import * as extractDocument from './routes/extract-document/route'
import * as generateAgentProfiles from './routes/generate/agent-profiles/route'
import * as generateSceneActions from './routes/generate/scene-actions/route'
import * as generateSceneContent from './routes/generate/scene-content/route'
import * as generateSceneOutlinesStream from './routes/generate/scene-outlines-stream/route'
import * as generateClassroom from './routes/generate-classroom/route'
import * as generateClassroomJob from './routes/generate-classroom/[jobId]/route'
import * as health from './routes/health/route'
import * as identityClaim from './routes/identity/claim/route'
import * as identityLegacyImportBinding from './routes/identity/legacy-import-binding/route'
import * as materials from './routes/materials/route'
import * as materialById from './routes/materials/[id]/route'
import * as persistence from './routes/persistence/[...path]/route'
import * as probeModels from './routes/provider/probe-models/route'
import * as serverProviders from './routes/server-providers/route'
import * as stageMeta from './routes/stage-meta/[stageId]/route'
import * as stages from './routes/stages/route'
import * as stageById from './routes/stages/[id]/route'
import * as stageFreshness from './routes/stages/[id]/freshness/route'
import * as stageGenerationComplete from './routes/stages/[id]/generation-complete/route'
import * as stageManifest from './routes/stages/[id]/manifest/route'
import * as stagePublish from './routes/stages/[id]/publish/route'
import * as stageScenes from './routes/stages/[id]/scenes/route'
import * as stageStatus from './routes/stages/[id]/status/route'
import * as stageUnpublish from './routes/stages/[id]/unpublish/route'
import * as usage from './routes/usage/route'
import * as verifyImageProvider from './routes/verify-image-provider/route'
import * as verifyModel from './routes/verify-model/route'
import * as verifyPdfProvider from './routes/verify-pdf-provider/route'
import * as verifyVideoProvider from './routes/verify-video-provider/route'
import * as webSearch from './routes/web-search/route'

/**
 * route handler 签名（Next.js App Router 的宽松版）。
 *
 * 参数用 `any`：端口代码里各 handler 的形参类型各不相同（`NextRequest` /
 * `Request` / `Request` + `{ params }`），要能把整棵已 vendor 的模块命名空间直接
 * 赋给 {@link RouteHandlers} 而不做逐条类型体操。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (request: any, context?: any) => Response | Promise<Response>

/** 一个 route 模块导出的方法集合。 */
export interface RouteHandlers {
  GET?: RouteHandler
  POST?: RouteHandler
  PUT?: RouteHandler
  PATCH?: RouteHandler
  DELETE?: RouteHandler
  HEAD?: RouteHandler
  OPTIONS?: RouteHandler
}

interface RouteDefinition {
  /** Next.js 风格的完整路径（含 `/api` 前缀）。 */
  pattern: string
  handlers: RouteHandlers
}

/** 路由清单（顺序无关：路径互不重叠，catch-all 仅一条）。 */
const DEFINITIONS: RouteDefinition[] = [
  { pattern: '/api/access-code/status', handlers: accessCodeStatus },
  { pattern: '/api/access-code/verify', handlers: accessCodeVerify },
  { pattern: '/api/classroom', handlers: classroom },
  { pattern: '/api/extract-document', handlers: extractDocument },
  { pattern: '/api/generate/agent-profiles', handlers: generateAgentProfiles },
  { pattern: '/api/generate/scene-actions', handlers: generateSceneActions },
  { pattern: '/api/generate/scene-content', handlers: generateSceneContent },
  { pattern: '/api/generate/scene-outlines-stream', handlers: generateSceneOutlinesStream },
  { pattern: '/api/generate-classroom', handlers: generateClassroom },
  { pattern: '/api/generate-classroom/[jobId]', handlers: generateClassroomJob },
  { pattern: '/api/health', handlers: health },
  { pattern: '/api/identity/claim', handlers: identityClaim },
  { pattern: '/api/identity/legacy-import-binding', handlers: identityLegacyImportBinding },
  { pattern: '/api/materials', handlers: materials },
  { pattern: '/api/materials/[id]', handlers: materialById },
  { pattern: '/api/persistence/[...path]', handlers: persistence },
  { pattern: '/api/provider/probe-models', handlers: probeModels },
  { pattern: '/api/server-providers', handlers: serverProviders },
  { pattern: '/api/stage-meta/[stageId]', handlers: stageMeta },
  { pattern: '/api/stages', handlers: stages },
  { pattern: '/api/stages/[id]', handlers: stageById },
  { pattern: '/api/stages/[id]/freshness', handlers: stageFreshness },
  { pattern: '/api/stages/[id]/generation-complete', handlers: stageGenerationComplete },
  { pattern: '/api/stages/[id]/manifest', handlers: stageManifest },
  { pattern: '/api/stages/[id]/publish', handlers: stagePublish },
  { pattern: '/api/stages/[id]/scenes', handlers: stageScenes },
  { pattern: '/api/stages/[id]/status', handlers: stageStatus },
  { pattern: '/api/stages/[id]/unpublish', handlers: stageUnpublish },
  { pattern: '/api/usage', handlers: usage },
  { pattern: '/api/verify-image-provider', handlers: verifyImageProvider },
  { pattern: '/api/verify-model', handlers: verifyModel },
  { pattern: '/api/verify-pdf-provider', handlers: verifyPdfProvider },
  { pattern: '/api/verify-video-provider', handlers: verifyVideoProvider },
  { pattern: '/api/web-search', handlers: webSearch },
]

const CATCH_ALL = /^\[\.\.\.(.+)\]$/
const DYNAMIC = /^\[(.+)\]$/

/** 把一段路径字面量转义为正则片段。 */
function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledRoute {
  regex: RegExp
  /** 有序参数名，与匹配组一一对应。 */
  params: Array<{ name: string; catchAll: boolean }>
  handlers: RouteHandlers
}

function compile(definition: RouteDefinition): CompiledRoute {
  const segments = definition.pattern.split('/').filter((segment) => segment !== '')
  const params: Array<{ name: string; catchAll: boolean }> = []
  let source = '^'

  segments.forEach((segment, index) => {
    const catchAll = CATCH_ALL.exec(segment)
    if (catchAll) {
      if (index !== segments.length - 1) {
        throw new Error(`openmaic-core: catch-all segment must be last in ${definition.pattern}`)
      }
      params.push({ name: catchAll[1], catchAll: true })
      source += '(?:/(.*))'
      return
    }
    const dynamic = DYNAMIC.exec(segment)
    if (dynamic) {
      params.push({ name: dynamic[1], catchAll: false })
      source += '/([^/]+)'
      return
    }
    source += `/${escapeSegment(segment)}`
  })

  source += '/?$'
  return { regex: new RegExp(source), params, handlers: definition.handlers }
}

const COMPILED: CompiledRoute[] = DEFINITIONS.map(compile)

/** 命中结果：路由 + 处理函数 + 解析出的参数。 */
export interface RouteMatch {
  handler: RouteHandler
  /** 提供给 handler 的 `context.params` 原始值（非 Promise）。 */
  params: Record<string, string | string[]>
  /** 该路径允许的方法（用于 405）。 */
  allowed: string[]
}

const METHOD_KEYS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/**
 * 按 pathname 与方法查找处理函数。
 *
 * - 路径未命中任何路由 → `null`（分发器交还控制权，不消费请求体）；
 * - 路径命中但方法未导出 → `{ handler: undefined, allowed }`（分发器回 405）。
 */
export function matchRoute(pathname: string, method: string): RouteMatch | null {
  for (const route of COMPILED) {
    const matched = route.regex.exec(pathname)
    if (!matched) continue

    const params: Record<string, string | string[]> = {}
    route.params.forEach((param, index) => {
      const raw = matched[index + 1] ?? ''
      if (param.catchAll) {
        params[param.name] = raw === '' ? [] : raw.split('/').map((part) => decodeURIComponent(part))
        return
      }
      params[param.name] = decodeURIComponent(raw)
    })

    const allowed = METHOD_KEYS.filter((key) => typeof route.handlers[key] === 'function')
    const handler = route.handlers[method as (typeof METHOD_KEYS)[number]]
    return {
      handler: handler as RouteHandler,
      params,
      allowed,
    }
  }
  return null
}