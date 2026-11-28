/**
 * 混合召回与精排（架构规格 §3.3）：
 *   向量粗排（当前作用域生效原则 + 近 / 高频经历，Top 12）
 *   → 字面补位（M1 的 FTS5 trigram + 参数化短词，Top 8，保住命令名、报错码、路径、工单号这些精确词）
 *   → 按类型 + 编号去重，封顶 15 条
 *   → 精排（真实相关性分，0~1）；检索器任何一步不可用就如实降级，绝不卡主流程。
 *
 * 向量只和「同一个模型身份 + 同一个维度」的存量向量比；不会在召回时给整个经历全集算向量。
 */
import { buildQueryPlan, searchExperiences, searchPrinciples } from '../core/recall.js';
import type { Store } from '../core/store.js';
import type { ExperienceRow, PrincipleRow } from '../core/types.js';
import {
  RetrieverUnavailable,
  bytesToVector,
  clampScore,
  cosine,
  vectorToBytes,
  type RerankHit,
  type Retriever,
  type RetrieverMode,
} from './types.js';
import { prepareRetriever } from './auto.js';

export type RecallType = 'principle' | 'experience';

export interface RecallItem {
  type: RecallType;
  id: number;
  /** 原则用「触发场景 + 换行 + 行动准则」，经历用总结 */
  text: string;
  /** 最终分。有模型精排时是精排分；没有时是字面重叠分或向量余弦，看 reranked 和 mode 就知道是哪种 */
  score: number;
  source: 'vector' | 'lexical' | 'vector+lexical';
  vectorScore: number | null;
  lexicalScore: number | null;
  reranked: boolean;
  principle?: PrincipleRow;
  experience?: ExperienceRow;
}

export interface RecallMode {
  /** 配置的检索器是哪一档 */
  retriever: RetrieverMode;
  /** full = 向量 + 字面 + 精排；lexical-rerank = 向量失败但精排成功；lexical-only / vector-only = 精排也失败 */
  stage: 'full' | 'lexical-rerank' | 'lexical-only' | 'vector-only';
  reranked: boolean;
  vectorReason: string | null;
  rerankReason: string | null;
}

export interface HybridRecallOptions {
  store: Store;
  scope: string;
  query: string;
  retriever: Retriever;
  /** 手动召回返回 8~10 条，默认 10 */
  limit?: number;
  /** 向量粗排取几条，默认 12 */
  vectorLimit?: number;
  /** 字面补位取几条，默认 8 */
  lexicalLimit?: number;
  /** 去重后封顶，默认 15 */
  candidateLimit?: number;
  /** 查询向量这一步最多等多久，默认 20 秒 */
  embedTimeoutMs?: number;
  /** 精排这一步最多等多久，默认 60 秒 */
  rerankTimeoutMs?: number;
  /** 经历候选池：最近几条，默认 150 */
  recentExperiences?: number;
  /** 经历候选池：被召回过的几条，默认 50 */
  frequentExperiences?: number;
}

export interface HybridRecallResult {
  items: RecallItem[];
  mode: RecallMode;
  elapsedMs: { vector: number; lexical: number; rerank: number; total: number };
}

export const RECALL_DEFAULTS = {
  limit: 10,
  vectorLimit: 12,
  lexicalLimit: 8,
  candidateLimit: 15,
  embedTimeoutMs: 20_000,
  rerankTimeoutMs: 60_000,
  recentExperiences: 150,
  frequentExperiences: 50,
} as const;

/** 动态提醒的默认门槛（可调）：精排分 ≥ 0.72 的前 2~3 条，总计 ≤ 400 字 */
export const HINT_DEFAULTS = { threshold: 0.72, max: 3, charBudget: 400 } as const;

/** 这些错误码说明本地服务已经确定不可用，重试精排只会再等一轮：直接按字面结果返回 */
const DEFINITIVE_OUTAGE_CODES = new Set([
  'start_failed',
  'model_missing',
  'daemon_missing',
  'model_mismatch',
  'protocol_mismatch',
  'unsupported_platform',
  'spawn_failed',
  'not_running',
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RetrieverUnavailable('timeout', `${what}超过 ${ms} 毫秒，不再等`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface VectorDoc {
  type: RecallType;
  id: number;
  text: string;
  vector: Float32Array;
  principle?: PrincipleRow;
  experience?: ExperienceRow;
}

function experiencePool(store: Store, scope: string, recent: number, frequent: number): ExperienceRow[] {
  const pool = new Map<number, ExperienceRow>();
  for (const row of store.listExperiences(scope, { limit: recent })) pool.set(row.id, row);
  if (frequent > 0) for (const row of store.listFrequentExperiences(scope, frequent)) pool.set(row.id, row);
  return [...pool.values()];
}

/** 向量粗排：只拿模型身份和字节长度都对得上的存量向量来比。 */
async function vectorStage(
  store: Store,
  scope: string,
  retriever: Retriever,
  query: string,
  options: Required<Pick<HybridRecallOptions, 'vectorLimit' | 'embedTimeoutMs' | 'recentExperiences' | 'frequentExperiences'>>,
): Promise<{ hits: Array<VectorDoc & { cosine: number }>; reason: string | null; reasonCode: string | null; elapsedMs: number }> {
  const started = Date.now();
  if (retriever.dimensions <= 0) return { hits: [], reason: '检索器没有固定维度，存量向量不能比', reasonCode: 'no_dimensions', elapsedMs: 0 };
  let queryVector: Float32Array;
  try {
    const [vector] = await withTimeout(retriever.embed([query], 'query'), options.embedTimeoutMs, '等查询向量');
    if (!vector || vector.length !== retriever.dimensions) throw new RetrieverUnavailable('bad_response', '查询向量维度不对');
    queryVector = vector;
  } catch (error) {
    return { hits: [], reason: messageOf(error), reasonCode: (error as { code?: unknown }).code as string | null ?? null, elapsedMs: Date.now() - started };
  }
  const dims = retriever.dimensions;
  const docs: VectorDoc[] = [];
  for (const principle of store.listPrinciples(scope, { status: 'active', limit: 500 })) {
    const vector = principle.embeddingModel === retriever.modelId ? bytesToVector(principle.embedding, dims) : null;
    if (vector) docs.push({ type: 'principle', id: principle.id, text: `${principle.triggerWhen}\n${principle.rule}`, vector, principle });
  }
  for (const experience of experiencePool(store, scope, options.recentExperiences, options.frequentExperiences)) {
    const vector = experience.embeddingModel === retriever.modelId ? bytesToVector(experience.embedding, dims) : null;
    if (vector) docs.push({ type: 'experience', id: experience.id, text: experience.summary, vector, experience });
  }
  const hits = docs
    .map((doc) => ({ ...doc, cosine: cosine(queryVector, doc.vector) }))
    .sort((a, b) => b.cosine - a.cosine || a.id - b.id)
    .slice(0, options.vectorLimit);
  return { hits, reason: null, reasonCode: null, elapsedMs: Date.now() - started };
}

export async function hybridRecall(options: HybridRecallOptions): Promise<HybridRecallResult> {
  const started = Date.now();
  const limit = options.limit ?? RECALL_DEFAULTS.limit;
  const lexicalLimit = options.lexicalLimit ?? RECALL_DEFAULTS.lexicalLimit;
  const candidateLimit = options.candidateLimit ?? RECALL_DEFAULTS.candidateLimit;
  const rerankTimeoutMs = options.rerankTimeoutMs ?? RECALL_DEFAULTS.rerankTimeoutMs;
  const query = options.query.trim();
  // 真正要召回之前的一次显式预检：auto 模式下缺模型就拉起后台下载并退回字面检索（不等网络）；整次调用固定用这一个检索器
  const retriever = prepareRetriever(options.retriever);

  const vector = await vectorStage(options.store, options.scope, retriever, query, {
    vectorLimit: options.vectorLimit ?? RECALL_DEFAULTS.vectorLimit,
    embedTimeoutMs: options.embedTimeoutMs ?? RECALL_DEFAULTS.embedTimeoutMs,
    recentExperiences: options.recentExperiences ?? RECALL_DEFAULTS.recentExperiences,
    frequentExperiences: options.frequentExperiences ?? RECALL_DEFAULTS.frequentExperiences,
  });

  const lexicalStarted = Date.now();
  // 字面补位总共只留 lexicalLimit 条（原则和经历合计，不是各留一份）：
  // 先保住含查询里真实精确技术词（命令名、报错码、路径、工单号）的条目，再按字面分填满，避免被一堆泛泛的中文原则挤掉
  const techTerms = buildQueryPlan(query)
    .segments.filter((segment) => segment.kind === 'tech')
    .map((segment) => segment.text.toLowerCase());
  const lexicalPool = new Map<string, { type: RecallType; id: number; text: string; score: number; tech: boolean; principle?: PrincipleRow; experience?: ExperienceRow }>();
  for (const hit of searchPrinciples(options.store, { scope: options.scope, query, limit: lexicalLimit })) {
    const text = `${hit.principle.triggerWhen}\n${hit.principle.rule}`;
    lexicalPool.set(`principle:${hit.principle.id}`, { type: 'principle', id: hit.principle.id, text, score: hit.score, tech: techTerms.some((term) => text.toLowerCase().includes(term)), principle: hit.principle });
  }
  for (const hit of searchExperiences(options.store, { scope: options.scope, query, limit: lexicalLimit })) {
    const text = `${hit.experience.summary}\n${hit.experience.evidence ?? ''}`;
    lexicalPool.set(`experience:${hit.experience.id}`, { type: 'experience', id: hit.experience.id, text: hit.experience.summary, score: hit.score, tech: techTerms.some((term) => text.toLowerCase().includes(term)), experience: hit.experience });
  }
  const lexicalRanked = [...lexicalPool.values()].sort(
    (a, b) => Number(b.tech) - Number(a.tech) || b.score - a.score || (b.experience?.occurredAt ?? '').localeCompare(a.experience?.occurredAt ?? ''),
  );
  const lexical = new Map(lexicalRanked.slice(0, lexicalLimit).map((lex) => [`${lex.type}:${lex.id}`, lex]));
  const lexicalMs = Date.now() - lexicalStarted;

  // 合并去重，封顶 candidateLimit。优先级：向量字面都命中 → 含精确技术词的字面补位 → 向量（余弦降序）→ 其余字面（分数降序），
  // 这样 12 条向量候选加上排在前面的泛中文原则，也挤不掉那条含唯一报错码的经历
  const vectorByKey = new Map(vector.hits.map((hit) => [`${hit.type}:${hit.id}`, hit]));
  const ordered: RecallItem[] = [];
  for (const lex of lexical.values()) {
    const hit = vectorByKey.get(`${lex.type}:${lex.id}`);
    ordered.push({
      type: lex.type,
      id: lex.id,
      text: lex.text,
      score: hit ? hit.cosine : lex.score,
      source: hit ? 'vector+lexical' : 'lexical',
      vectorScore: hit ? hit.cosine : null,
      lexicalScore: lex.score,
      reranked: false,
      principle: lex.principle,
      experience: lex.experience,
    });
  }
  for (const hit of vector.hits) {
    if (lexical.has(`${hit.type}:${hit.id}`)) continue;
    ordered.push({
      type: hit.type,
      id: hit.id,
      text: hit.text,
      score: hit.cosine,
      source: 'vector',
      vectorScore: hit.cosine,
      lexicalScore: null,
      reranked: false,
      principle: hit.principle,
      experience: hit.experience,
    });
  }
  const merged = new Map<string, RecallItem>();
  for (const item of ordered) {
    if (merged.size >= candidateLimit) break;
    merged.set(`${item.type}:${item.id}`, item);
  }
  const candidates = [...merged.values()];

  // 精排：真实相关性分。向量阶段已经确定本地服务不可用（起不来、缺模型、模型身份不对）时，不再花第二份长预算去等精排；
  // 只是 embed 这一个接口坏掉（超时、坏响应、API 的 5xx）时仍然试一次精排，回环 / API 那条「embed 坏而 rerank 能用」的路照旧走得通
  const rerankStarted = Date.now();
  let reranked = false;
  let rerankReason: string | null = null;
  const definitiveOutage = vector.reasonCode !== null && DEFINITIVE_OUTAGE_CODES.has(vector.reasonCode);
  if (candidates.length > 0 && definitiveOutage) {
    rerankReason = `本地检索服务已确定不可用（${vector.reason}），不再等精排`;
  } else if (candidates.length > 0) {
    try {
      const hits = await withTimeout<RerankHit[]>(
        retriever.rerank(query, candidates.map((item) => item.text), candidates.length),
        rerankTimeoutMs,
        '等精排结果',
      );
      const byIndex = new Map<number, number>();
      for (const hit of hits) if (hit.index >= 0 && hit.index < candidates.length) byIndex.set(hit.index, clampScore(hit.score));
      candidates.forEach((item, index) => {
        item.reranked = byIndex.has(index);
        item.score = byIndex.get(index) ?? 0;
      });
      reranked = true;
    } catch (error) {
      rerankReason = messageOf(error);
    }
  }
  const rerankMs = Date.now() - rerankStarted;

  const fallbackScore = (item: RecallItem): number => item.lexicalScore ?? item.vectorScore ?? 0;
  const strength = (item: RecallItem): number => item.principle?.strength ?? 0;
  const byFallback = (a: RecallItem, b: RecallItem): number =>
    fallbackScore(b) - fallbackScore(a) || strength(b) - strength(a) || a.id - b.id;
  candidates.sort(reranked ? (a, b) => b.score - a.score || byFallback(a, b) : byFallback);

  const retrieverMode = (await retriever.health().catch(() => null))?.mode ?? 'fts-only';
  const mode: RecallMode = {
    retriever: retrieverMode,
    stage: reranked ? (vector.reason ? 'lexical-rerank' : 'full') : vector.reason ? 'lexical-only' : 'vector-only',
    reranked,
    vectorReason: vector.reason,
    rerankReason,
  };
  return {
    items: candidates.slice(0, limit),
    mode,
    elapsedMs: { vector: vector.elapsedMs, lexical: lexicalMs, rerank: rerankMs, total: Date.now() - started },
  };
}

/* ---------- 动态提醒的筛选（本段只导出结果，不做注入） ---------- */

/** 一条提醒的样子，例如 `[P12] 先 ls -la 看一眼……`；最多 120 字。 */
export function hintLine(item: RecallItem): string {
  const body = item.type === 'principle' ? (item.principle?.rule ?? item.text) : (item.experience?.summary ?? item.text);
  const oneLine = body.replace(/\s+/g, ' ');
  return `[${item.type === 'principle' ? 'P' : 'E'}${item.id}] ${oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine}`;
}

export interface HintOptions {
  threshold?: number;
  max?: number;
  charBudget?: number;
}

/**
 * 只保留模型精排分 ≥ 阈值（默认 0.72）的前 2~3 条。
 * 400 字的上限按 formatHintBlock 排出来的整块文字算（含 <memory-hint> 包装和那句说明），
 * 所以调用方拿到的完整文字一定 ≤ 400 字。字面兜底的结果（没经过模型精排）一律不提醒，宁可不提醒也不拿字面分冒充语义分。
 */
export function pickHints(items: RecallItem[], options: HintOptions = {}): RecallItem[] {
  const threshold = options.threshold ?? HINT_DEFAULTS.threshold;
  const max = options.max ?? HINT_DEFAULTS.max;
  const charBudget = options.charBudget ?? HINT_DEFAULTS.charBudget;
  const picked: RecallItem[] = [];
  for (const item of items) {
    if (!item.reranked || item.score < threshold) break;
    if (picked.length >= max) break;
    if (formatHintBlock([...picked, item]).length > charBudget) break;
    picked.push(item);
  }
  return picked;
}

/** 把筛出来的提醒排成规格 §4.2 的文本块；没有可提醒的就返回空字符串。 */
export function formatHintBlock(items: RecallItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map(hintLine);
  return ['<memory-hint>', '与当前情况高度相关的历史提醒（仅作参考，以用户本轮指令和现场事实为准）：', ...lines.map((line) => `- ${line}`), '</memory-hint>'].join('\n');
}

/* ---------- 向量索引：有界补建 / 重建（M3 导入后复用） ---------- */

export interface IndexOptions {
  store: Store;
  retriever: Retriever;
  scope: string;
  types?: RecallType[];
  /** 本次最多补多少条，默认 50，上限 200：绝不在一次调用里把经历全集发给模型 */
  limit?: number;
  batchSize?: number;
  /** true = 不管已有向量全部重算 */
  force?: boolean;
  /** 从哪个编号之后开始（rebuildVectors 分页用；原则和经历各有各的编号） */
  afterId?: Partial<Record<RecallType, number>>;
}

export interface IndexResult {
  scope: string;
  modelId: string;
  scanned: number;
  embedded: number;
  /** 这次没来得及补的（limit 用完之后剩下的），不是失败 */
  remaining: number;
  failed: number;
  reason: string | null;
  /** 这一趟每种类型处理到的最大编号（分页用） */
  lastIds: Partial<Record<RecallType, number>>;
}

export const INDEX_DEFAULTS = { limit: 50, maxLimit: 200, batchSize: 16, maxBatch: 64 } as const;

/** 补建当前作用域的向量：只补「没有向量 / 模型身份不同 / 字节长度不对」的记录，分批算、分批写。 */
export async function indexVectors(options: IndexOptions): Promise<IndexResult> {
  const limit = Math.min(Math.max(1, options.limit ?? INDEX_DEFAULTS.limit), INDEX_DEFAULTS.maxLimit);
  const batchSize = Math.min(Math.max(1, options.batchSize ?? INDEX_DEFAULTS.batchSize), INDEX_DEFAULTS.maxBatch);
  const types = options.types ?? ['principle', 'experience'];
  // 和混合召回同一个预检：auto 模式下模型没齐就先拉起后台下载，这一轮如实报「没有向量模型」
  const retriever = prepareRetriever(options.retriever);
  const result: IndexResult = {
    scope: options.scope,
    modelId: retriever.modelId,
    scanned: 0,
    embedded: 0,
    remaining: 0,
    failed: 0,
    reason: null,
    lastIds: { ...options.afterId },
  };
  if (retriever.dimensions <= 0) {
    result.reason = '检索器没有固定维度，存不了可比的向量';
    return result;
  }
  const byteLength = retriever.dimensions * 4;
  const modelId = options.force ? '' : retriever.modelId;
  let budget = limit;
  for (const type of types) {
    if (budget <= 0) break;
    const afterId = options.afterId?.[type] ?? 0;
    const rows =
      type === 'principle'
        ? options.store.listPrinciplesNeedingEmbedding(options.scope, modelId, byteLength, limit, afterId)
        : options.store.listExperiencesNeedingEmbedding(options.scope, modelId, byteLength, limit, afterId);
    result.scanned += rows.length;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize).slice(0, budget);
      if (batch.length === 0) break;
      let vectors: Float32Array[];
      try {
        vectors = await retriever.embed(batch.map((row) => row.text), 'document');
      } catch (error) {
        result.failed += batch.length;
        result.reason = messageOf(error);
        break;
      }
      batch.forEach((row, index) => {
        const vector = vectors[index];
        if (!vector || vector.length !== retriever.dimensions) {
          result.failed += 1;
          return;
        }
        const bytes = vectorToBytes(vector);
        if (type === 'principle') options.store.setPrincipleEmbedding(row.id, bytes, retriever.modelId);
        else options.store.setExperienceEmbedding(row.id, bytes, retriever.modelId);
        result.embedded += 1;
      });
      budget -= batch.length;
      result.lastIds[type] = batch[batch.length - 1]?.id ?? afterId;
    }
  }
  result.remaining = Math.max(0, result.scanned - result.embedded - result.failed);
  return result;
}

/** 反复补建直到当前作用域补齐（或达到 maxRows），给 M3 导入后的「秒级重建」复用。 */
export async function rebuildVectors(options: IndexOptions & { maxRows?: number }): Promise<IndexResult> {
  const maxRows = options.maxRows ?? 2_000;
  const total: IndexResult = { scope: options.scope, modelId: options.retriever.modelId, scanned: 0, embedded: 0, remaining: 0, failed: 0, reason: null, lastIds: {} };
  for (let round = 0; round < Math.ceil(maxRows / INDEX_DEFAULTS.maxLimit) + 1; round += 1) {
    const one = await indexVectors({ ...options, limit: INDEX_DEFAULTS.maxLimit, afterId: options.force ? total.lastIds : undefined });
    total.scanned += one.scanned;
    total.embedded += one.embedded;
    total.failed += one.failed;
    total.reason = one.reason ?? total.reason;
    // force 模式下每一条都「需要重建」，靠 lastIds 往后翻页；非 force 模式补完就没了
    total.lastIds = one.lastIds;
    if (one.reason || one.failed > 0) break;
    if (one.scanned === 0 || total.scanned >= maxRows) break;
  }
  return total;
}
