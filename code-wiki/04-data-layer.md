# 04 · 数据层

数据层位于 `server/src/db/`，使用 Node 内置的 `node:sqlite`，做到**零原生依赖、无需编译**。

| 文件 | 职责 |
| --- | --- |
| [sqlite.ts](file:///workspace/edu-loop-mvp/server/src/db/sqlite.ts) | `node:sqlite` 的最小类型化封装 + 参数绑定归一化 |
| [index.ts](file:///workspace/edu-loop-mvp/server/src/db/index.ts) | SQLite schema（建表 / 索引）与连接创建 |
| [repo.ts](file:///workspace/edu-loop-mvp/server/src/db/repo.ts) | `Repository`：集中所有 SQL，行 → 领域对象映射 |
| [plugin.ts](file:///workspace/edu-loop-mvp/server/src/db/plugin.ts) | Cordis 插件，注册 `db` / `repo` 服务 |

## 1. `sqlite.ts` — 底层封装

选用 `createRequire` 载入 `node:sqlite`，以避开不同 `@types/node` 版本对声明差异。

```ts
export interface SqliteStatement {
  all(...params): Record<string, unknown>[]
  get(...params): Record<string, unknown> | undefined
  run(...params): { changes: number | bigint; lastInsertRowid: number | bigint }
}
export interface SqliteDatabase { exec(sql): void; prepare(sql): SqliteStatement; close(): void }

export function openDatabase(path: string): SqliteDatabase { return new sqlite.DatabaseSync(path) }
```

**`bindable(value)`**：把 JS 值归一化为 `node:sqlite` 可绑定的类型——它不接受 `boolean` / `undefined`：

- `undefined` / `null` → `null`
- `boolean` → `1 | 0`
- `string | number | bigint | Uint8Array` → 原样
- 其它 → `JSON.stringify`

## 2. `index.ts` — schema 与连接

`createDatabase(filePath)`：先 `mkdirSync(dirname)`，再打开连接并 `exec(SCHEMA)`。

SCHEMA 开头两条 PRAGMA：

```sql
PRAGMA journal_mode = WAL;     -- 预写日志，读写并发更好
PRAGMA foreign_keys = ON;      -- 开启外键约束（级联删除依赖它）
```

### 表结构总览（9 张表）

表结构与五步闭环直接对应：

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `courses` | 课程 | `id` 主键；`objectives` 存 JSON 字符串 |
| `lessons` | 课次 | FK → courses，`ON DELETE CASCADE`；含 `explanation` / `explained_at` |
| `questions` | 题目 | FK → courses(CASCADE) / lessons(SET NULL)；`options` 存 JSON |
| `attempts` | 作答记录 | FK → questions / courses；含 `correct` / `score` / `feedback` / `graded_by` |
| `reviews` | 间隔重复调度 | `question_id` 为主键；含 `ease` / `interval_days` / `repetitions` / `due_at` |
| `rubrics` | 评估量规 | `criteria` 存 JSON |
| `rubric_evaluations` | 量规评估结果 | FK → courses / rubrics |
| `llm_call_logs` | LLM 调用审计 | 含 tokens / latency / status / error_code |
| `eval_runs` | LLM Judge 评测运行 | `target_type` ∈ outline/explain/quiz/grade |

### 关键 DDL 摘要

```sql
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
```

> `openmaic-storage` 插件会在同一个连接上再建 `storage_kv` / `storage_docs` 两张表
> （见 [07-openmaic-plugins.md](./07-openmaic-plugins.md)），因此实际库中共 **11 张表**。

## 3. `repo.ts` — 数据访问层

### 3.1 领域类型

`repo.ts` 导出与表一一对应的领域接口：`Course`、`Lesson`、`Question`、`Attempt`、
`Review`、`Rubric` / `RubricCriterion` / `RubricCriterionLevel`、`LlmCallLog`、`EvalRun`。
这些类型是**服务端领域对象的唯一真相**，前端 `web/src/api/types.ts` 手工对齐同一形状。

工具函数：

- `newId(prefix)`：`{prefix}_{uuid去横线前16位}`；
- `parseJson<T>(value, fallback)`：宽容解析 JSON 列，失败回退。

### 3.2 `Repository` 方法分组

| 分组 | 方法 |
| --- | --- |
| courses | `insertCourse` / `getCourse` / `listCourses` |
| lessons | `insertLessons` / `getLesson` / `listLessons` / `setLessonExplanation` |
| questions | `insertQuestions` / `listQuestions` / `getQuestion` / `countQuestions` |
| attempts | `insertAttempt` / `listAttempts` / `attemptStats` |
| reviews | `getReview` / `upsertReview` / `listDueReviews` / `listReviews` |
| rubrics | `insertRubric` / `latestRubric` / `insertRubricEvaluation` / `latestEvaluation` |
| LLM 日志 | `insertLlmLog` / `listLlmLogs` |
| 评测运行 | `insertEvalRun` / `listEvalRuns` / `latestEvalPerType` |

### 3.3 值得注意的实现

- **`attemptStats(courseId)`**：取每题**最近一次**作答统计「已作答 / 正确 / 正确率%」。
  实现上按 `created_at ASC` 遍历、`Map.set` 覆盖，最后 `Map.size` 即去重后的题目数。
- **`upsertReview(review)`**：`INSERT ... ON CONFLICT(question_id) DO UPDATE`，
  让复习调度可反复覆盖更新。
- **`listDueReviews(courseId?, nowIso, limit=50)`**：按 `due_at <= now` 取到期项；
  可选按课程过滤，`courseId` 为 `undefined` 时取全局。
- **`latestRubric` / `latestEvaluation`**：`ORDER BY created_at DESC LIMIT 1`，
  保证每次取最新一份。
- **`latestEvalPerType(courseId)`**：取最多 500 条后按 `target_type` 去重保留最新，
  供前端「各类型最近一次评测」快捷展示。
- **`listLlmLogs(limit)`**：把下划线列名映射为驼峰，`degraded` 归一化布尔。

### 3.4 行映射函数

每个表有对应的 `mapXxx(row)`，把 `snake_case` 列转成领域对象（`created_at → createdAt`、
JSON 列 → 数组/对象、`INTEGER` 布尔 → `boolean`）。集中在此，避免 SQL 细节渗入上层。

## 4. `plugin.ts` — Cordis 插件

```ts
export const name = 'edu-loop:db'
export const provide = ['db', 'repo']
export const Config = z.object({ filePath: z.string().required() })

export function apply(ctx: Context, config: Config): () => void {
  const db = createDatabase(config.filePath)
  const repo = new Repository(db)
  ctx.provide('db', db)
  ctx.provide('repo', repo)
  return () => { try { db.close() } catch (e) { console.error('[db] 关闭连接时抛错', e) } }
}
```

- 依赖 `Config.filePath`（由 `index.ts` 传入 `server/data/edu-loop.db`）；
- **连接关闭挂在返回的 disposer 上**，随 fiber 卸载自动回收；
- 扩展 `Context` 接口声明 `db: SqliteDatabase` / `repo: Repository`；
- 便捷读取 `useRepo(ctx)`。

下一篇：[05-teaching-domain.md](./05-teaching-domain.md)。