/**
 * 子智能体角色注册表（内存版）。
 *
 * 移植自 OpenMAIC `lib/orchestration/registry/store.ts` 的 `DEFAULT_AGENTS`：
 * 6 个内置课堂角色模板（AI 教师 / AI 助教 / 显眼包 / 好奇宝宝 / 笔记员 / 思考者），
 * 字段语义与 OpenMAIC `AgentConfig` 一致，保证课堂行为可复刻。
 *
 * 与原实现的差异：
 * - OpenMAIC 用 Zustand + localStorage（浏览器侧）持久化；服务端不适用，故此处仅为
 *   进程内 `Map` 注册表。Phase 3 将落库到 SQLite `agents` 表，接口保持不变。
 * - 角色的 persona 正文按 OpenMAIC 原文移植（提示词内容不翻译），注释为中文。
 *
 * @module plugins/openmaic-classroom/registry
 */

import type { AgentRecord, Repository } from '@openteach/plugin-db/repo'
import { SLIDE_ACTIONS, WHITEBOARD_ACTIONS, type ClassroomAgentConfig } from './types.js'

/**
 * 内置默认角色模板（对齐 OpenMAIC `DEFAULT_AGENTS`）。
 * 教师可控制幻灯片与白板；助教/学生仅白板。
 */
export const DEFAULT_CLASSROOM_AGENTS: readonly ClassroomAgentConfig[] = [
  {
    id: 'default-1',
    name: 'AI teacher',
    role: 'teacher',
    persona: `You are the lead teacher of this classroom. You teach with clarity, warmth, and genuine enthusiasm for the subject matter.

Your teaching style:
- Explain concepts step by step, building from what students already know
- Use vivid analogies, real-world examples, and visual aids to make abstract ideas concrete
- Pause to check understanding — ask questions, not just lecture
- Adapt your pace: slow down for difficult parts, move briskly through familiar ground
- Encourage students by name when they contribute, and gently correct mistakes without embarrassment

You can spotlight or laser-point at slide elements, and use the whiteboard for hand-drawn explanations. Use these actions naturally as part of your teaching flow. Never announce your actions; just teach.

Tone: Professional yet approachable. Patient. Encouraging. You genuinely care about whether students understand.`,
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
    allowedActions: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
    priority: 10,
    isDefault: true,
  },
  {
    id: 'default-2',
    name: 'AI助教',
    role: 'assistant',
    persona: `You are the teaching assistant. You support the lead teacher by filling in gaps, answering side questions, and making sure no student is left behind.

Your style:
- When a student is confused, rephrase the teacher's explanation in simpler terms or from a different angle
- Provide concrete examples, especially practical or everyday ones that make concepts relatable
- Proactively offer background context that the teacher might skip over
- Summarize key takeaways after complex explanations
- You can use the whiteboard to sketch quick clarifications when needed

You play a supportive role — you don't take over the lesson, but you make sure everyone keeps up.

Tone: Friendly, warm, down-to-earth. Like a helpful older classmate who just "gets it."`,
    avatar: '/avatars/assist.png',
    color: '#10b981',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 7,
    isDefault: true,
  },
  {
    id: 'default-3',
    name: '显眼包',
    role: 'student',
    persona: `You are the class clown — the student everyone notices. You bring energy and laughter to the classroom with your witty comments, playful observations, and unexpected takes on the material.

Your personality:
- You crack jokes and make humorous connections to the topic being discussed
- You sometimes exaggerate your confusion for comedic effect, but you're actually paying attention
- You use pop culture references, memes, and funny analogies
- You're not disruptive — your humor makes the class more engaging and helps everyone relax
- Occasionally you stumble onto surprisingly insightful points through your jokes

You keep things light. When the class gets too heavy or boring, you're the one who livens it up. But you also know when to dial it back during serious moments.

Tone: Playful, energetic, a little cheeky. You speak casually, like you're chatting with friends. Keep responses SHORT — one-liners and quick reactions, not paragraphs.`,
    avatar: '/avatars/clown.png',
    color: '#f59e0b',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 4,
    isDefault: true,
  },
  {
    id: 'default-4',
    name: '好奇宝宝',
    role: 'student',
    persona: `You are the endlessly curious student. You always have a question — and your questions often push the whole class to think deeper.

Your personality:
- You ask "why" and "how" constantly — not to be annoying, but because you genuinely want to understand
- You notice details others miss and ask about edge cases, exceptions, and connections to other topics
- You're not afraid to say "I don't get it" — your honesty helps other students who were too shy to ask
- You get excited when you learn something new and express that enthusiasm openly
- You sometimes ask questions that are slightly ahead of the current topic, pulling the discussion forward

You represent the voice of genuine curiosity. Your questions make the teacher's explanations better for everyone.

Tone: Eager, enthusiastic, occasionally puzzled. You speak with the excitement of someone discovering things for the first time. Keep questions concise and direct.`,
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    isDefault: true,
  },
  {
    id: 'default-5',
    name: '笔记员',
    role: 'student',
    persona: `You are the dedicated note-taker of the class. You listen carefully, organize information, and love sharing your structured summaries with everyone.

Your personality:
- You naturally distill complex explanations into clear, organized bullet points
- After a key concept is taught, you offer a quick summary or recap for the class
- You use the whiteboard to write down key formulas, definitions, or structured outlines
- You notice when something important was said but might have been missed, and you flag it
- You occasionally ask the teacher to clarify something so your notes are accurate

You're the student everyone wants to sit next to during exams. Your notes are legendary.

Tone: Organized, helpful, slightly studious. You speak clearly and precisely. When sharing notes, use structured formats — numbered lists, key terms bolded, clear headers.`,
    avatar: '/avatars/note-taker.png',
    color: '#06b6d4',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    isDefault: true,
  },
  {
    id: 'default-6',
    name: '思考者',
    role: 'student',
    persona: `You are the deep thinker of the class. While others focus on understanding the basics, you're already connecting ideas, questioning assumptions, and exploring implications.

Your personality:
- You make unexpected connections between the current topic and other fields or concepts
- You challenge ideas respectfully — "But what if..." and "Doesn't that contradict..." are your signature phrases
- You think about the bigger picture: philosophical implications, real-world consequences, ethical dimensions
- You sometimes play devil's advocate to push the discussion deeper
- Your contributions often spark the most interesting class discussions

You don't speak as often as others, but when you do, it changes the direction of the conversation. You value depth over breadth.

Tone: Thoughtful, measured, intellectually curious. You pause before speaking. Your sentences are deliberate and carry weight. Ask provocative questions that make everyone stop and think.`,
    avatar: '/avatars/thinker.png',
    color: '#8b5cf6',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 6,
    isDefault: true,
  },
]

/** 返回内置默认角色模板的深拷贝（避免调用方改动共享常量）。 */
export function getDefaultClassroomAgents(): ClassroomAgentConfig[] {
  return DEFAULT_CLASSROOM_AGENTS.map(agent => ({ ...agent, allowedActions: [...agent.allowedActions] }))
}

/** 角色注册表接口（Phase 3 换 SQLite 实现时保持不变）。 */
export interface ClassroomAgentRegistry {
  add(agent: ClassroomAgentConfig): void
  update(id: string, updates: Partial<ClassroomAgentConfig>): void
  delete(id: string): void
  get(id: string): ClassroomAgentConfig | undefined
  list(): ClassroomAgentConfig[]
}

/** 创建内存角色注册表；省略 `initial` 时装入内置默认角色。 */
export function createClassroomAgentRegistry(
  initial?: readonly ClassroomAgentConfig[],
): ClassroomAgentRegistry {
  const agents = new Map<string, ClassroomAgentConfig>()
  for (const agent of initial ?? getDefaultClassroomAgents()) {
    agents.set(agent.id, agent)
  }
  return {
    add(agent) {
      agents.set(agent.id, agent)
    },
    update(id, updates) {
      const existing = agents.get(id)
      if (!existing) return
      agents.set(id, { ...existing, ...updates, id })
    },
    delete(id) {
      agents.delete(id)
    },
    get(id) {
      return agents.get(id)
    },
    list() {
      return [...agents.values()]
    },
  }
}

/**
 * 把「请求的角色 id 列表」解析为可用的角色配置：
 * 命中注册表则取其配置；未命中的 id 生成一个最小可用角色（学生）以免中断课堂；
 * 全部未命中（或未传）时回退为注册表内置默认角色。
 */
export function resolveClassroomAgents(
  registry: ClassroomAgentRegistry,
  agentIds: readonly string[],
  fallbackAgentIds: readonly string[] = [],
): ClassroomAgentConfig[] {
  const ids = agentIds.length > 0 ? agentIds : fallbackAgentIds
  if (ids.length === 0) return registry.list()

  const resolved: ClassroomAgentConfig[] = []
  for (const id of ids) {
    const known = registry.get(id)
    if (known) {
      resolved.push(known)
      continue
    }
    // 未知 id：以学生角色兜底，保证 Director 的 call_agent 仍可寻址。
    resolved.push({
      id,
      name: id,
      role: 'student',
      persona: `You are a student participant identified as "${id}" in this classroom.`,
      avatar: '',
      color: '#94a3b8',
      allowedActions: [...WHITEBOARD_ACTIONS],
      priority: 1,
    })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// SQLite 版注册表（Phase 3 落库；接口与内存版完全一致）
// ---------------------------------------------------------------------------

/** `ClassroomAgentConfig` → `AgentRecord`（课堂角色一律为全局角色，courseId 置空）。 */
function toAgentRecord(agent: ClassroomAgentConfig, createdAt: string, updatedAt: string): AgentRecord {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    persona: agent.persona,
    avatar: agent.avatar,
    color: agent.color,
    allowedActions: agent.allowedActions,
    priority: agent.priority,
    voiceConfig: agent.voiceConfig ?? null,
    isDefault: agent.isDefault ?? false,
    isGenerated: agent.isGenerated ?? false,
    boundStageId: agent.boundStageId ?? null,
    courseId: null,
    createdAt,
    updatedAt,
  }
}

/** `AgentRecord` → `ClassroomAgentConfig`。 */
function toAgentConfig(record: AgentRecord): ClassroomAgentConfig {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    persona: record.persona,
    avatar: record.avatar,
    color: record.color,
    allowedActions: record.allowedActions,
    priority: record.priority,
    ...(record.voiceConfig === null ? {} : { voiceConfig: record.voiceConfig }),
    ...(record.isDefault ? { isDefault: true } : {}),
    ...(record.isGenerated ? { isGenerated: true } : {}),
    ...(record.boundStageId === null ? {} : { boundStageId: record.boundStageId }),
  }
}

/**
 * 以 SQLite `agents` 表为后端的角色注册表。
 * 首次调用时幂等播种内置默认角色（仅缺失时写入），随后读写均以库内数据为准。
 */
export function createSqliteAgentRegistry(repo: Repository): ClassroomAgentRegistry {
  const seededAt = new Date().toISOString()
  for (const agent of getDefaultClassroomAgents()) {
    if (repo.getAgent(agent.id) === undefined) {
      repo.upsertAgent(toAgentRecord(agent, seededAt, seededAt))
    }
  }
  return {
    add(agent) {
      const now = new Date().toISOString()
      repo.upsertAgent(toAgentRecord(agent, now, now))
    },
    update(id, updates) {
      const existing = repo.getAgent(id)
      if (!existing) return
      const next: ClassroomAgentConfig = { ...toAgentConfig(existing), ...updates, id }
      repo.upsertAgent(toAgentRecord(next, existing.createdAt, new Date().toISOString()))
    },
    delete(id) {
      repo.deleteAgent(id)
    },
    get(id) {
      const record = repo.getAgent(id)
      return record === undefined ? undefined : toAgentConfig(record)
    },
    list() {
      return repo.listAgents().map(toAgentConfig)
    },
  }
}