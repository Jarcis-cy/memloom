import type { Store } from './store.js';
import type { ExperienceRow, PrincipleRow } from './types.js';

/**
 * 中文字面召回（M1 只有 FTS5 trigram + 参数化 LIKE，没有语义向量，不冒充语义检索）。
 *
 * 查询切分规则：
 * - 连续汉字串直接取全部三字窗口进 FTS5 MATCH（trigram 最短匹配就是 3 个字，从不把 2 字切片拼回 3 字）；
 * - 不足 3 个字的汉字词、不足 3 个字符的技术词走参数化字面 LIKE；
 * - 英文命令、路径、报错码等技术词整词加引号进 MATCH，大小写不敏感，保证精确词不漏。
 */

export type SegmentKind = 'han' | 'tech' | 'short';

export interface QuerySegment {
  kind: SegmentKind;
  text: string;
  /** 进 FTS5 MATCH 的短语 */
  phrases: string[];
  /** 走参数化 LIKE 的短词 */
  likes: string[];
}

export interface QueryPlan {
  segments: QuerySegment[];
  /** 全部是加引号的短语、用 OR 连接的 MATCH 表达式；没有可用短语时为 null */
  ftsExpr: string | null;
  likeTerms: string[];
}

const HAN_RUN = /\p{Script=Han}+/gu;
const TOKEN = /(?:--?)?[A-Za-z0-9_][A-Za-z0-9_.:/\\@%+#-]*/g;

function trigrams(run: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 3 <= run.length; i += 1) out.push(run.slice(i, i + 3));
  return out;
}

function quotePhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildQueryPlan(query: string): QueryPlan {
  const segments: QuerySegment[] = [];
  for (const match of query.matchAll(HAN_RUN)) {
    const run = match[0];
    if (run === undefined) continue;
    if (run.length >= 3) {
      segments.push({ kind: 'han', text: run, phrases: trigrams(run), likes: [] });
    } else {
      segments.push({ kind: 'short', text: run, phrases: [], likes: [run] });
    }
  }
  for (const match of query.matchAll(TOKEN)) {
    const token = match[0];
    if (token === undefined) continue;
    if (token.length >= 3) {
      segments.push({ kind: 'tech', text: token, phrases: [token], likes: [] });
    } else {
      segments.push({ kind: 'short', text: token, phrases: [], likes: [token] });
    }
  }
  const phrases = [...new Set(segments.flatMap((s) => s.phrases))];
  const likeTerms = [...new Set(segments.flatMap((s) => s.likes))];
  return {
    segments,
    ftsExpr: phrases.length > 0 ? phrases.map(quotePhrase).join(' OR ') : null,
    likeTerms,
  };
}

/** 两个字符串的最长公共子串长度（短文本够用）。 */
export function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    const ca = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      if (ca !== undefined && ca === b[j - 1]) {
        const length = (prev[j - 1] ?? 0) + 1;
        cur[j] = length;
        if (length > best) best = length;
      }
    }
    prev = cur;
  }
  return best;
}

/** 关键词重叠打分：每一段按命中程度记 0~1，再取平均；matched 表示至少有一段真正命中。 */
export function scoreText(plan: QueryPlan, text: string): { score: number; matched: boolean } {
  if (plan.segments.length === 0) return { score: 0, matched: false };
  const haystack = text.toLowerCase();
  let total = 0;
  let matched = false;
  for (const segment of plan.segments) {
    if (segment.kind === 'han') {
      const overlap = longestCommonSubstring(segment.text, haystack);
      const contribution = overlap / segment.text.length;
      total += contribution;
      if (overlap >= 3) matched = true;
    } else {
      const hit = haystack.includes(segment.text.toLowerCase());
      total += hit ? 1 : 0;
      if (hit) matched = true;
    }
  }
  return { score: total / plan.segments.length, matched };
}

export interface ExperienceHit {
  experience: ExperienceRow;
  score: number;
}

export interface PrincipleHit {
  principle: PrincipleRow;
  score: number;
}

const POOL_SIZE = 50;

/**
 * 经历字面召回：FTS5 候选 ∪ LIKE 候选 → 关键词重叠打分 → 只留真正命中的，按分数和发生时间排序。
 */
export function searchExperiences(
  store: Store,
  options: { scope: string; query: string; limit?: number },
): ExperienceHit[] {
  const limit = options.limit ?? 8;
  const plan = buildQueryPlan(options.query);
  if (plan.segments.length === 0) return [];

  const candidates = new Map<number, ExperienceRow>();
  if (plan.ftsExpr) {
    try {
      for (const row of store.searchExperiencesByFts(options.scope, plan.ftsExpr, POOL_SIZE)) {
        candidates.set(row.id, row);
      }
    } catch {
      // 查询里出现 FTS5 语法吃不下的字符：退回 LIKE 兜底，绝不因为检索报错卡住主流程
    }
  }
  for (const term of plan.likeTerms) {
    for (const row of store.searchExperiencesByLike(options.scope, term, POOL_SIZE)) {
      candidates.set(row.id, row);
    }
  }

  const hits: ExperienceHit[] = [];
  for (const experience of candidates.values()) {
    const { score, matched } = scoreText(plan, `${experience.summary}\n${experience.evidence ?? ''}`);
    if (matched) hits.push({ experience, score });
  }
  hits.sort((a, b) => b.score - a.score || b.experience.occurredAt.localeCompare(a.experience.occurredAt));
  return hits.slice(0, limit);
}

/**
 * 生效原则的字面召回：只用 LIKE 找候选，再用同一套重叠打分排序。
 * 这是字面匹配，不是语义检索；语义向量与精排属于 M2。
 */
export function searchPrinciples(
  store: Store,
  options: { scope: string; query: string; limit?: number },
): PrincipleHit[] {
  const limit = options.limit ?? 8;
  const plan = buildQueryPlan(options.query);
  if (plan.segments.length === 0) return [];

  const terms = [...plan.segments.flatMap((s) => s.phrases), ...plan.likeTerms];
  const candidates = new Map<number, PrincipleRow>();
  for (const term of terms) {
    for (const row of store.searchActivePrinciplesByLike(options.scope, term, POOL_SIZE)) {
      candidates.set(row.id, row);
    }
  }
  const hits: PrincipleHit[] = [];
  for (const principle of candidates.values()) {
    const { score, matched } = scoreText(plan, `${principle.triggerWhen}\n${principle.rule}`);
    if (matched) hits.push({ principle, score });
  }
  hits.sort((a, b) => b.score - a.score || b.principle.strength - a.principle.strength);
  return hits.slice(0, limit);
}
