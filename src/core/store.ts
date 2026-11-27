import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { applySchema } from './schema.js';
import {
  PRINCIPLE_LIMITS,
  assertScope,
  type DilemmaInput,
  type DilemmaRow,
  type DilemmaStatus,
  type ExperienceInput,
  type ExperienceKind,
  type ExperienceRow,
  type ExperienceSource,
  type IronRuleRow,
  type PrincipleInput,
  type PrincipleRow,
  type PrincipleStatus,
  type CapacityReport,
} from './types.js';

/* ---------- 读出来的行 → 领域对象 ---------- */

function num(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库里的数字字段读出来不是数字：${String(value)}`);
}

function text(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库里的文字字段读出来不是文字：${String(value)}`);
}

function textOrNull(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function bool(value: SQLOutputValue | undefined): boolean {
  return num(value) !== 0;
}

function idList(value: SQLOutputValue | undefined): number[] {
  const raw = textOrNull(value) ?? '[]';
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is number => Number.isSafeInteger(x) && (x as number) > 0);
}

function blob(value: SQLOutputValue | undefined): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  throw new Error('数据库里的向量字段读出来不是二进制');
}

type Row = Record<string, SQLOutputValue>;

function toIronRule(row: Row): IronRuleRow {
  return {
    id: num(row.id),
    scope: text(row.scope),
    content: text(row.content),
    active: bool(row.active),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toExperience(row: Row): ExperienceRow {
  return {
    id: num(row.id),
    scope: text(row.scope),
    kind: text(row.kind) as ExperienceKind,
    summary: text(row.summary),
    evidence: textOrNull(row.evidence),
    source: text(row.source) as ExperienceSource,
    sourceSession: textOrNull(row.source_session),
    embedding: blob(row.embedding),
    embeddingModel: textOrNull(row.embedding_model),
    occurredAt: text(row.occurred_at),
    createdAt: text(row.created_at),
    processedAt: textOrNull(row.processed_at),
    hitCount: num(row.hit_count),
    lastHitAt: textOrNull(row.last_hit_at),
  };
}

function toPrinciple(row: Row): PrincipleRow {
  return {
    id: num(row.id),
    scope: text(row.scope),
    triggerWhen: text(row.trigger_when),
    rule: text(row.rule),
    rationale: textOrNull(row.rationale),
    status: text(row.status) as PrincipleStatus,
    isCore: bool(row.is_core),
    parentIds: idList(row.parent_ids),
    sourceExperienceIds: idList(row.source_experience_ids),
    embedding: blob(row.embedding),
    embeddingModel: textOrNull(row.embedding_model),
    strength: num(row.strength),
    appliedCount: num(row.applied_count),
    violatedCount: num(row.violated_count),
    retireReason: textOrNull(row.retire_reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    lastUsedAt: textOrNull(row.last_used_at),
  };
}

function toDilemma(row: Row): DilemmaRow {
  return {
    id: num(row.id),
    scope: text(row.scope),
    kind: text(row.kind) as DilemmaRow['kind'],
    summary: text(row.summary),
    optionA: text(row.option_a),
    optionB: text(row.option_b),
    relatedPrincipleIds: idList(row.related_principle_ids),
    sourceExperienceIds: idList(row.source_experience_ids),
    status: text(row.status) as DilemmaStatus,
    resolution: textOrNull(row.resolution),
    surfacedCount: num(row.surfaced_count),
    createdAt: text(row.created_at),
    resolvedAt: textOrNull(row.resolved_at),
  };
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function assertIdList(ids: readonly number[], label: string): number[] {


  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label}里有不合法的编号：${String(id)}`);
  }
  return [...ids];
}

/** LIKE 通配符转义，配合 ESCAPE '\\' 使用，保证短词按字面匹配。 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * 单一数据真源：一个 SQLite 文件（或 `:memory:`），四张核心表 + 经历全文索引。
 * 同一个库里可以用 scope 隔离多个主体；所有查询都带 scope，绝不串读。
 * 经历正文（summary / evidence）只追加：这里没有任何修改它们的入口。
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;
  private closed = false;

  constructor(path: string) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('打开数据库必须显式给出文件路径（或 :memory:），不提供默认路径');
    }
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      applySchema(this.db);
    } catch (error) {
      throw new Error(`打不开数据库「${path}」：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 读一个 PRAGMA 的值，用于体检和测试（例如 journal_mode、foreign_keys）。 */
  pragma(name: string): SQLOutputValue | undefined {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`PRAGMA 名字不合法：${name}`);
    const row = this.prepare(`PRAGMA ${name}`).get();
    return row ? (Object.values(row)[0] as SQLOutputValue | undefined) : undefined;
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * 在一个立即写事务里跑 fn：任何一步抛错就整体回滚，库里不留半截结果。
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error('不能在事务里再开事务');
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** 关库可以重复调用；已关闭再关不会报错。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  /* ---------- 铁律：只有这两个显式的人工入口能改 ---------- */

  addIronRule(input: { scope: string; content: string; now: string }): IronRuleRow {
    assertScope(input.scope);
    const content = input.content.trim();
    if (!content) throw new Error('铁律正文不能为空');
    const result = this.prepare(
      'INSERT INTO iron_rules (scope, content, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run(input.scope, content, input.now, input.now);
    return this.getIronRule(Number(result.lastInsertRowid));
  }

  /** 人工停用或重新启用一条铁律；后台凝结永远调不到这里。 */
  setIronRuleActive(id: number, active: boolean, now: string): IronRuleRow {
    const changes = this.prepare('UPDATE iron_rules SET active = ?, updated_at = ? WHERE id = ?').run(
      active ? 1 : 0,
      now,
      id,
    );
    if (Number(changes.changes) === 0) throw new Error(`找不到编号为 ${id} 的铁律`);
    return this.getIronRule(id);
  }

  getIronRule(id: number): IronRuleRow {
    const row = this.prepare('SELECT * FROM iron_rules WHERE id = ?').get(id);
    if (!row) throw new Error(`找不到编号为 ${id} 的铁律`);
    return toIronRule(row);
  }

  listIronRules(scope: string, options: { activeOnly?: boolean } = {}): IronRuleRow[] {
    assertScope(scope);
    const rows =
      options.activeOnly === false
        ? this.prepare('SELECT * FROM iron_rules WHERE scope = ? ORDER BY id').all(scope)
        : this.prepare('SELECT * FROM iron_rules WHERE scope = ? AND active = 1 ORDER BY id').all(scope);
    return rows.map(toIronRule);
  }

  /* ---------- 经历：只追加 ---------- */

  addExperience(input: ExperienceInput): ExperienceRow {
    assertScope(input.scope);
    const summary = input.summary.trim();
    if (!summary) throw new Error('经历总结不能为空');
    const evidence = input.evidence == null ? null : input.evidence.trim() || null;
    const now = input.createdAt ?? new Date().toISOString();
    const occurredAt = input.occurredAt ?? now;
    const result = this.prepare(
      `INSERT INTO experiences
        (scope, kind, summary, evidence, source, source_session, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.scope,
      input.kind,
      summary,
      evidence,
      input.source,
      input.sourceSession ?? null,
      occurredAt,
      now,
    );
    const row = this.getExperience(Number(result.lastInsertRowid));
    if (!row) throw new Error('经历写入后读不回来，数据库状态不对');
    return row;
  }

  getExperience(id: number): ExperienceRow | null {
    const row = this.prepare('SELECT * FROM experiences WHERE id = ?').get(id);
    return row ? toExperience(row) : null;
  }

  /** 同一批编号的经历，顺序按编号升序；缺的不返回。 */
  getExperiences(ids: readonly number[]): ExperienceRow[] {
    if (ids.length === 0) return [];
    const rows = this.prepare(
      `SELECT * FROM experiences WHERE id IN (${placeholders(ids.length)}) ORDER BY id`,
    ).all(...assertIdList(ids, '经历编号'));
    return rows.map(toExperience);
  }

  listExperiences(
    scope: string,
    options: { processed?: boolean; limit?: number } = {},
  ): ExperienceRow[] {
    assertScope(scope);
    const limit = options.limit ?? 100;
    const base = 'FROM experiences WHERE scope = ?';
    const rows =
      options.processed === undefined
        ? this.prepare(`SELECT * ${base} ORDER BY id DESC LIMIT ?`).all(scope, limit)
        : options.processed
          ? this.prepare(`SELECT * ${base} AND processed_at IS NOT NULL ORDER BY id DESC LIMIT ?`).all(scope, limit)
          : this.prepare(`SELECT * ${base} AND processed_at IS NULL ORDER BY id DESC LIMIT ?`).all(scope, limit);
    return rows.map(toExperience);
  }

  /** 待凝结的经历，先进先出。 */
  listPendingExperiences(scope: string, limit: number): ExperienceRow[] {
    assertScope(scope);
    const rows = this.prepare(
      'SELECT * FROM experiences WHERE scope = ? AND processed_at IS NULL ORDER BY id LIMIT ?',
    ).all(scope, limit);
    return rows.map(toExperience);
  }

  countPendingExperiences(scope: string): number {
    assertScope(scope);
    const row = this.prepare(
      'SELECT count(*) AS c FROM experiences WHERE scope = ? AND processed_at IS NULL',
    ).get(scope);
    return num(row?.c);
  }

  /** 只改元数据：正文不动，全文索引照旧。 */
  markExperiencesProcessed(ids: readonly number[], at: string): void {
    if (ids.length === 0) return;
    this.prepare(
      `UPDATE experiences SET processed_at = ? WHERE id IN (${placeholders(ids.length)}) AND processed_at IS NULL`,
    ).run(at, ...assertIdList(ids, '经历编号'));
  }

  recordExperienceHit(id: number, at: string): void {
    this.prepare(
      'UPDATE experiences SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?',
    ).run(at, id);
  }

  /* ---------- 原则 ---------- */

  insertPrinciple(input: PrincipleInput): PrincipleRow {
    assertScope(input.scope);
    const result = this.prepare(
      `INSERT INTO principles
        (scope, trigger_when, rule, rationale, status, is_core, parent_ids, source_experience_ids,
         strength, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1.0, ?, ?)`,
    ).run(
      input.scope,
      input.triggerWhen,
      input.rule,
      input.rationale ?? null,
      input.isCore ? 1 : 0,
      JSON.stringify(input.parentIds ?? []),
      JSON.stringify(input.sourceExperienceIds ?? []),
      input.now,
      input.now,
    );
    return this.getPrinciple(Number(result.lastInsertRowid));
  }

  getPrinciple(id: number): PrincipleRow {
    const row = this.prepare('SELECT * FROM principles WHERE id = ?').get(id);
    if (!row) throw new Error(`找不到编号为 ${id} 的原则`);
    return toPrinciple(row);
  }

  findPrinciple(id: number): PrincipleRow | null {
    const row = this.prepare('SELECT * FROM principles WHERE id = ?').get(id);
    return row ? toPrinciple(row) : null;
  }

  listPrinciples(
    scope: string,
    options: { status?: PrincipleStatus | 'all'; limit?: number } = {},
  ): PrincipleRow[] {
    assertScope(scope);
    const limit = options.limit ?? 500;
    const status = options.status ?? 'active';
    const rows =
      status === 'all'
        ? this.prepare('SELECT * FROM principles WHERE scope = ? ORDER BY id LIMIT ?').all(scope, limit)
        : this.prepare('SELECT * FROM principles WHERE scope = ? AND status = ? ORDER BY id LIMIT ?').all(
            scope,
            status,
            limit,
          );
    return rows.map(toPrinciple);
  }

  /** reinforce：补证据、加强度，不改写原意。 */
  reinforcePrinciple(id: number, options: { delta: number; addSourceIds: readonly number[]; now: string }): PrincipleRow {
    const current = this.getPrinciple(id);
    const merged = [...new Set([...current.sourceExperienceIds, ...options.addSourceIds])].sort((a, b) => a - b);
    this.prepare('UPDATE principles SET strength = ?, source_experience_ids = ?, updated_at = ? WHERE id = ?').run(
      Math.min(5, Math.round((current.strength + options.delta) * 100) / 100),
      JSON.stringify(merged),
      options.now,
      id,
    );
    return this.getPrinciple(id);
  }

  /** 软退役 / 合并 / 替代：只改状态和原因，绝不删行，也绝不复活旧行。 */
  setPrincipleStatus(
    id: number,
    status: Exclude<PrincipleStatus, 'active'>,
    options: { retireReason: string; now: string },
  ): PrincipleRow {
    this.prepare('UPDATE principles SET status = ?, retire_reason = ?, updated_at = ? WHERE id = ?').run(
      status,
      options.retireReason,
      options.now,
      id,
    );
    return this.getPrinciple(id);
  }

  capacity(scope: string): CapacityReport {
    const kind = assertScope(scope).kind;
    const limits = PRINCIPLE_LIMITS[kind];
    const row = this.prepare(
      `SELECT count(*) AS active_count,
              coalesce(sum(length(trigger_when) + length(rule)), 0) AS active_chars,
              coalesce(sum(is_core), 0) AS core_count
       FROM principles WHERE scope = ? AND status = 'active'`,
    ).get(scope);
    const activeCount = num(row?.active_count);
    const activeChars = num(row?.active_chars);
    const coreCount = num(row?.core_count);
    return {
      scope,
      activeCount,
      softCount: limits.softCount,
      hardCount: limits.hardCount,
      activeChars,
      hardChars: limits.hardChars,
      coreCount,
      maxCore: limits.maxCore,
      nearLimit:
        activeCount >= limits.softCount * 0.8 || activeChars >= limits.hardChars * 0.8,
    };
  }

  /* ---------- 字面检索（SQL 在这里，中文查询怎么切在 recall.ts） ---------- */

  /** 用 FTS5 MATCH 表达式查经历全文索引，只取当前作用域，按相关度升序（越靠前越相关）。 */
  searchExperiencesByFts(scope: string, matchExpr: string, limit: number): ExperienceRow[] {
    assertScope(scope);
    const rows = this.prepare(
      `SELECT e.* FROM experiences_fts f JOIN experiences e ON e.id = f.rowid
       WHERE f.experiences_fts MATCH ? AND e.scope = ? ORDER BY f.rank LIMIT ?`,
    ).all(matchExpr, scope, limit);
    return rows.map(toExperience);
  }

  /** 短词兜底：参数化 LIKE，summary 和 evidence 都找。 */
  searchExperiencesByLike(scope: string, term: string, limit: number): ExperienceRow[] {
    assertScope(scope);
    const pattern = `%${escapeLike(term)}%`;
    const rows = this.prepare(
      "SELECT * FROM experiences WHERE scope = ? AND (summary LIKE ? ESCAPE '\\' OR evidence LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT ?",
    ).all(scope, pattern, pattern, limit);
    return rows.map(toExperience);
  }

  /** 生效原则的字面匹配（M1 没有语义向量，这一层只是字面检索，不冒充语义召回）。 */
  searchActivePrinciplesByLike(scope: string, term: string, limit: number): PrincipleRow[] {
    assertScope(scope);
    const pattern = `%${escapeLike(term)}%`;
    const rows = this.prepare(
      "SELECT * FROM principles WHERE scope = ? AND status = 'active' AND (trigger_when LIKE ? ESCAPE '\\' OR rule LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT ?",
    ).all(scope, pattern, pattern, limit);
    return rows.map(toPrinciple);
  }
  /* ---------- 分歧 ---------- */

  insertDilemma(input: DilemmaInput): DilemmaRow {
    assertScope(input.scope);
    const result = this.prepare(
      `INSERT INTO dilemmas
        (scope, kind, summary, option_a, option_b, related_principle_ids, source_experience_ids,
         status, surfaced_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
    ).run(
      input.scope,
      input.kind,
      input.summary,
      input.optionA,
      input.optionB,
      JSON.stringify(input.relatedPrincipleIds ?? []),
      JSON.stringify(input.sourceExperienceIds ?? []),
      input.now,
    );
    return this.getDilemma(Number(result.lastInsertRowid));
  }

  getDilemma(id: number): DilemmaRow {
    const row = this.prepare('SELECT * FROM dilemmas WHERE id = ?').get(id);
    if (!row) throw new Error(`找不到编号为 ${id} 的分歧`);
    return toDilemma(row);
  }

  listDilemmas(scope: string, options: { status?: DilemmaStatus | 'all' } = {}): DilemmaRow[] {
    assertScope(scope);
    const status = options.status ?? 'open';
    const rows =
      status === 'all'
        ? this.prepare('SELECT * FROM dilemmas WHERE scope = ? ORDER BY id').all(scope)
        : this.prepare('SELECT * FROM dilemmas WHERE scope = ? AND status = ? ORDER BY id').all(scope, status);
    return rows.map(toDilemma);
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
