import type { DatabaseSync } from 'node:sqlite';

/** 三张同步触发器的名字，测试和维护时按名字核对。 */
export const FTS_TRIGGER_NAMES = [
  'experiences_fts_ai',
  'experiences_fts_au',
  'experiences_fts_ad',
] as const;

/**
 * 四张核心表 + 经历全文索引（外部内容、trigram 分词）+ 三个同步触发器。
 * 所有语句都带 IF NOT EXISTS，重复执行是安全的。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS iron_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'personal',
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('correction', 'preference', 'pitfall', 'decision', 'fact')),
  summary TEXT NOT NULL,
  evidence TEXT,
  source TEXT NOT NULL CHECK (source IN ('review', 'correction', 'flush', 'manual', 'import')),
  source_session TEXT,
  embedding BLOB,
  embedding_model TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);

CREATE INDEX IF NOT EXISTS experiences_scope_pending
  ON experiences (scope, processed_at, id);

CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  summary,
  evidence,
  content = 'experiences',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS experiences_fts_ai
AFTER INSERT ON experiences
BEGIN
  INSERT INTO experiences_fts (rowid, summary, evidence)
  VALUES (new.id, new.summary, new.evidence);
END;

CREATE TRIGGER IF NOT EXISTS experiences_fts_au
AFTER UPDATE ON experiences
BEGIN
  INSERT INTO experiences_fts (experiences_fts, rowid, summary, evidence)
  VALUES ('delete', old.id, old.summary, old.evidence);
  INSERT INTO experiences_fts (rowid, summary, evidence)
  VALUES (new.id, new.summary, new.evidence);
END;

CREATE TRIGGER IF NOT EXISTS experiences_fts_ad
AFTER DELETE ON experiences
BEGIN
  INSERT INTO experiences_fts (experiences_fts, rowid, summary, evidence)
  VALUES ('delete', old.id, old.summary, old.evidence);
END;

CREATE TABLE IF NOT EXISTS principles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  trigger_when TEXT NOT NULL,
  rule TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'merged', 'superseded', 'retired')),
  is_core INTEGER NOT NULL DEFAULT 0 CHECK (is_core IN (0, 1)),
  parent_ids TEXT NOT NULL DEFAULT '[]',
  source_experience_ids TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  embedding_model TEXT,
  strength REAL NOT NULL DEFAULT 1.0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  violated_count INTEGER NOT NULL DEFAULT 0,
  retire_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS principles_scope_status ON principles (scope, status, id);

CREATE TABLE IF NOT EXISTS dilemmas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('iron_rule_collision', 'value_conflict')),
  summary TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  related_principle_ids TEXT NOT NULL DEFAULT '[]',
  source_experience_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution TEXT,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`;

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}
