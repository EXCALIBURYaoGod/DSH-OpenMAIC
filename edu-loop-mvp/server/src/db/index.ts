/**
 * SQLite schema 与连接管理。
 *
 * 表结构直接映射五步教学闭环：
 * courses / lessons / questions / attempts / reviews（间隔重复）/ rubrics / rubric_evaluations / llm_call_logs
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
`

export function createDatabase(filePath: string): SqliteDatabase {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = openDatabase(filePath)
  db.exec(SCHEMA)
  return db
}