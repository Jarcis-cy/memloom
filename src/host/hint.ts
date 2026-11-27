/**
 * 动态提醒（规格 §4.2）：只在当轮尾部、只有真正高分的 0~3 条、整块 ≤ 400 字。
 * - 触发条件：用户消息 ≥ 6 字且不是寒暄 / 斜杠命令；或工具真正失败（非零 / isError）。
 * - 前台有明确短等待上限：候选缩到几条，超过预算就把结果丢掉，不排队、不补发；
 *   没模型 / 冷启动 / 坏模型 / 超时一律静默，绝不用字面分冒充语义分（pickHints 只认模型精排分）。
 * - 去重：静态区里的原则、本会话已经提醒过的条目不再出现；只有当轮是强纠错（视为再次明确违背）才允许重复。
 */
import type { Store } from '../core/store.js';
import { detectCorrection } from '../core/capture.js';
import { hybridRecall, pickHints, formatHintBlock, type RecallItem } from '../retriever/hybrid.js';
import type { Retriever } from '../retriever/types.js';
import { stripInjections } from './static.js';
import type { HintOptions, HintState } from './types.js';

export const MIN_HINT_CHARS = 6;
/** 工具失败输出最多拿这么多字去查 */
export const TOOL_ERROR_QUERY_CHARS = 300;

/** 纯寒暄 / 应答：整句只有这些词（可叠加）就不去翻记忆。 */
const GREETING_RE = /^(?:你好|您好|嗨|哈喽|哈啰|hello|hi|hey|thanks|thank you|谢谢|多谢|辛苦了|好的|好|嗯|哦|噢|ok|okay|继续|go on|yes|no|是|不是|收到|明白|知道了|可以|行|没问题|测试|test|[，。！？,.!??~～\s])+$/i;

export function shouldHint(text: string): { ok: true } | { ok: false; reason: string } {
  const stripped = stripInjections(text);
  if (stripped === '') return { ok: false, reason: '这句话只有 memloom 自己的注入或没有正文' };
  if (/^\s*\//.test(stripped)) return { ok: false, reason: '斜杠命令不翻记忆' };
  if (stripped.length < MIN_HINT_CHARS) return { ok: false, reason: `不足 ${MIN_HINT_CHARS} 个字` };
  if (GREETING_RE.test(stripped)) return { ok: false, reason: '寒暄或应答，不翻记忆' };
  return { ok: true };
}

/** 工具失败时的查询：工具名 + 报错原文（截到 300 字），保住报错码、路径这些精确词给字面补位。 */
export function toolFailureQuery(toolName: string, output: string | null | undefined): string {
  const body = (output ?? '').replace(/\s+/g, ' ').trim().slice(0, TOOL_ERROR_QUERY_CHARS);
  return body === '' ? toolName : `${toolName} ${body}`;
}

export interface HintRequest {
  store: Store;
  scope: string;
  query: string;
  retriever: Retriever;
  options: HintOptions;
  /** 静态区里的原则 + 本会话已提醒过的键，例如 P12 / E3 */
  exclude: ReadonlySet<string>;
  /** 当轮是强纠错：允许再提醒一遍 */
  allowRepeat: boolean;
}

export interface HintOutcome {
  hint: string;
  state: HintState;
  reason?: string;
  /** 这次提醒出去的键，宿主记进会话游标 */
  keys: string[];
  elapsedMs: number;
  /** 超时后仍在跑的那次召回（调用方可以不等它；它自己会结束） */
  pending: Promise<void> | null;
}

export function itemKey(item: RecallItem): string {
  return `${item.type === 'principle' ? 'P' : 'E'}${item.id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给慢召回套一个硬上限：到点就回 timeout，原 promise 继续跑完自己收尾（错误吞掉，不让它变成未处理异常）。 */
async function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), budgetMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 当前用户原话是不是强纠错（视为「再次明确违背」，允许重复提醒已经提醒过的条目）。 */
export function isStrongCorrection(text: string): boolean {
  return detectCorrection(stripInjections(text)) !== null;
}

/**
 * 做一次有预算的提醒检索。检索器不可用、没过精排、没有过线项都是静默；原因写在大白话里供回执如实报告。
 */
export async function recallHint(request: HintRequest): Promise<HintOutcome> {
  const started = Date.now();
  const { store, retriever, options } = request;
  const query = request.query.trim();
  if (query === '') return { hint: '', state: 'skipped', reason: '查询是空的', keys: [], elapsedMs: 0, pending: null };
  if (retriever.dimensions <= 0) {
    return { hint: '', state: 'silent', reason: '当前没有带语义能力的检索器（fts-only），提醒保持安静', keys: [], elapsedMs: 0, pending: null };
  }
  const work = hybridRecall({
    store,
    scope: request.scope,
    query,
    retriever,
    limit: options.candidateLimit,
    vectorLimit: options.vectorLimit,
    lexicalLimit: options.lexicalLimit,
    candidateLimit: options.candidateLimit,
    embedTimeoutMs: options.budgetMs * 2,
    rerankTimeoutMs: options.budgetMs * 2,
  });
  let pending: Promise<void> | null = null;
  let outcome: Awaited<typeof work>;
  const raced = await withBudget(work, options.budgetMs);
  if (!raced.ok) {
    // 召回还在跑：挂在后面收尾，不让它变成未处理异常，也不再等它
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return { hint: '', state: 'timeout', reason: `等召回超过 ${options.budgetMs} 毫秒，这一轮不提醒`, keys: [], elapsedMs: Date.now() - started, pending };
  }
  outcome = raced.value;
  const elapsedMs = Date.now() - started;
  if (!outcome.mode.reranked) {
    const reason =
      outcome.items.length === 0 ? '字面和向量都没找到候选，没什么可提醒的' : (outcome.mode.rerankReason ?? outcome.mode.vectorReason ?? '检索器没有给出模型精排分');
    return { hint: '', state: 'silent', reason: `没经过模型精排，提醒保持安静：${reason}`, keys: [], elapsedMs, pending: null };
  }
  const filtered = request.allowRepeat ? outcome.items : outcome.items.filter((item) => !request.exclude.has(itemKey(item)));
  const picked = pickHints(filtered, { threshold: options.threshold, max: options.max, charBudget: options.charBudget });
  if (picked.length === 0) {
    const aboveThreshold = outcome.items.filter((item) => item.score >= options.threshold).length;
    return {
      hint: '',
      state: aboveThreshold > 0 ? 'empty' : 'silent',
      reason:
        aboveThreshold > 0
          ? `过线的 ${aboveThreshold} 条都已经静态注入或本会话提醒过了`
          : `最高精排分 ${outcome.items.length > 0 ? outcome.items[0]?.score.toFixed(3) : '无'}，没到 ${options.threshold}`,
      keys: [],
      elapsedMs,
      pending: null,
    };
  }
  return { hint: formatHintBlock(picked), state: 'hinted', keys: picked.map(itemKey), elapsedMs, pending: null };
}

/** 会话开始时在后台把共享检索服务拉起来（冷启动那几秒不占用户的第一条消息）；任何失败都只记一句，不打扰。 */
export async function warmupInBackground(retriever: Retriever, log: (line: string) => void): Promise<void> {
  try {
    const health = await retriever.health();
    if (health.ok) return;
    const candidate = retriever as unknown as { warmup?: () => Promise<{ modelId: string }> };
    if (typeof candidate.warmup !== 'function') return;
    const ready = await candidate.warmup();
    log(`共享检索服务已就绪（${ready.modelId}）`);
  } catch (error) {
    log(`预热共享检索服务没成：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 只给测试用：等后台那次超时残留的召回结束，避免它跨到下一个用例。 */
export async function settle(pending: Promise<void> | null, maxMs = 5_000): Promise<void> {
  if (!pending) return;
  await withBudget(pending, maxMs);
  await sleep(0);
}
