/**
 * SQLite schema 与连接管理。
 *
 * 表结构直接映射五步教学闭环：
 * courses / lessons / questions / attempts / reviews（间隔重复）/ rubrics / rubric_evaluations / llm_call_logs / eval_runs
 *
 * Phase 3 追加互动课堂领域表（复用五步闭环既有数据为数据源）：
 * agents（课堂角色配置）/ classroom_sessions / classroom_events（SSE tail + Last-Event-ID）
 * / whiteboard_elements（白板动作流水）/ tts_assets（语音产物登记）。
 *
 * @module db/index
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase, type SqliteDatabase } from './sqlite.js'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  material      TEXT,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  objectives    TEXT NOT NULL DEFAULT '[]',
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  degraded      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  objective     TEXT NOT NULL DEFAULT '',
  key_points    TEXT NOT NULL DEFAULT '[]',
  explanation   TEXT,
  explained_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, idx);

CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id     TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  idx           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  stem          TEXT NOT NULL,
  options       TEXT,
  answer        TEXT NOT NULL,
  explanation   TEXT NOT NULL DEFAULT '',
  difficulty    TEXT NOT NULL DEFAULT 'medium',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id, idx);

CREATE TABLE IF NOT EXISTS attempts (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  answer        TEXT NOT NULL,
  correct       INTEGER NOT NULL,
  score         REAL NOT NULL,
  feedback      TEXT NOT NULL DEFAULT '',
  graded_by     TEXT NOT NULL DEFAULT 'llm',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);

CREATE TABLE IF NOT EXISTS reviews (
  question_id       TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  course_id         TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  ease              REAL NOT NULL DEFAULT 2.5,
  interval_days     INTEGER NOT NULL DEFAULT 0,
  repetitions       INTEGER NOT NULL DEFAULT 0,
  due_at            TEXT NOT NULL,
  last_grade        INTEGER,
  last_reviewed_at  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON reviews(due_at);

CREATE TABLE IF NOT EXISTS rubrics (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  criteria      TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rubrics_course ON rubrics(course_id);

CREATE TABLE IF NOT EXISTS rubric_evaluations (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  rubric_id     TEXT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  total_score   REAL NOT NULL,
  level         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rubric_evaluations_course ON rubric_evaluations(course_id);

CREATE TABLE IF NOT EXISTS llm_call_logs (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  degraded          INTEGER NOT NULL DEFAULT 0,
  task              TEXT NOT NULL,
  prompt_chars      INTEGER NOT NULL DEFAULT 0,
  output_chars      INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  error_code        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_call_logs_created ON llm_call_logs(created_at);

-- LLM Judge 评测运行：对某一类教学产物（大纲/讲解/题目/判分反馈）打分。
CREATE TABLE IF NOT EXISTS eval_runs (
  id              TEXT PRIMARY KEY,
  course_id       TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  target_type     TEXT NOT NULL,            -- outline | explain | quiz | grade
  target_id       TEXT,                     -- lesson/question/attempt id，大纲为 course id
  judge_provider  TEXT NOT NULL,
  judge_model     TEXT NOT NULL,
  degraded        INTEGER NOT NULL DEFAULT 0,
  total_score     REAL NOT NULL,            -- 加权总分（0-100）
  level           TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_course ON eval_runs(course_id, target_type);

-- ---------------------------------------------------------------------------
-- Phase 3：互动课堂领域表
-- ---------------------------------------------------------------------------

-- 课堂角色配置（对齐 openmaic-classroom 的 ClassroomAgentConfig / OpenMAIC AgentConfig）。
-- Phase 2 的内存注册表 DEFAULT_CLASSROOM_AGENTS 在 Phase 3 落库到此表。
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  persona         TEXT NOT NULL DEFAULT '',
  avatar          TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  priority        INTEGER NOT NULL DEFAULT 1,
  voice_config    TEXT,                          -- JSON：{ providerId, modelId?, voiceId }
  is_default      INTEGER NOT NULL DEFAULT 0,
  is_generated    INTEGER NOT NULL DEFAULT 0,
  bound_stage_id  TEXT,                          -- 生成该角色的 stage id
  course_id       TEXT REFERENCES courses(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_course ON agents(course_id, priority DESC);
CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);

-- 课堂会话（对齐 ClassroomSessionMeta）。course/lesson 复用五步闭环数据，作为课堂场景数据源。
CREATE TABLE IF NOT EXISTS classroom_sessions (
  id            TEXT PRIMARY KEY,
  course_id     TEXT REFERENCES courses(id) ON DELETE SET NULL,
  lesson_id     TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  stage_id      TEXT,                            -- 关联 dsl Stage id（场景容器）
  session_type  TEXT NOT NULL DEFAULT 'qa',      -- qa | discussion | lecture
  status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | error
  input         TEXT NOT NULL DEFAULT '{}',      -- ClassroomSessionInput JSON
  last_seq      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classroom_sessions_course ON classroom_sessions(course_id, created_at);

-- 课堂事件流（SSE tail）。PK(session_id, seq) 直接支撑 Last-Event-ID 断点续传查询。
CREATE TABLE IF NOT EXISTS classroom_events (
  session_id    TEXT NOT NULL REFERENCES classroom_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,               -- 会话内单调自增，从 1 开始（= SSE event id）
  type          TEXT NOT NULL,                  -- agent_start | agent_end | text_delta | action | cue_user | done | error
  data          TEXT NOT NULL DEFAULT '{}',     -- 事件载荷 JSON（ClassroomEvent['data']）
  created_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- 白板动作流水（对齐 WhiteboardActionRecord）：记录每个 wb_* 动作，供回放/白板重建。
CREATE TABLE IF NOT EXISTS whiteboard_elements (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES classroom_sessions(id) ON DELETE CASCADE,
  seq           INTEGER,                         -- 对应课堂事件的 seq
  course_id     TEXT REFERENCES courses(id) ON DELETE CASCADE,
  scene_id      TEXT,
  action_name   TEXT NOT NULL,                   -- wb_open | wb_draw_text | wb_clear | ...
  agent_id      TEXT NOT NULL DEFAULT '',
  agent_name    TEXT NOT NULL DEFAULT '',
  params        TEXT NOT NULL DEFAULT '{}',      -- 动作参数 JSON
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whiteboard_elements_session ON whiteboard_elements(session_id, seq);

-- TTS 语音产物登记（对齐 openmaic:audio 的 TTSModelConfig / TTSGenerationResult）。
-- 仅登记元数据与落盘路径，音频字节不入库；apiKey 等凭据绝不落库。
CREATE TABLE IF NOT EXISTS tts_assets (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES classroom_sessions(id) ON DELETE CASCADE,
  message_id    TEXT,                            -- 关联的课堂发言 messageId
  agent_id      TEXT,
  provider_id   TEXT NOT NULL,                   -- openai-tts | browser-native-tts
  model_id      TEXT,
  voice         TEXT NOT NULL,
  speed         REAL,
  format        TEXT NOT NULL DEFAULT 'mp3',
  text          TEXT NOT NULL,                   -- 合成文本
  text_chars    INTEGER NOT NULL DEFAULT 0,
  audio_path    TEXT,                            -- 音频落盘路径
  audio_bytes   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ready',   -- ready | error
  error_code    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tts_assets_session ON tts_assets(session_id, created_at);
`

export function createDatabase(filePath: string): SqliteDatabase {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = openDatabase(filePath)
  db.exec(SCHEMA)
  return db
}