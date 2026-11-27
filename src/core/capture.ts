import type { Store } from './store.js';
import { EXTRACTION_INSTRUCTIONS } from '../prompts/m1.js';
import type { ConversationMessage, ExperienceKind, ExperienceRow, ExtractionModel } from './types.js';

/* ====================== 纠错检测（中英文轻量规则） ====================== */

export interface CorrectionSignal {
  lang: 'zh' | 'en';
  /** 命中的强信号原文 */
  signal: string;
  /** 命中所在的那句话，截到 120 字以内 */
  excerpt: string;
}

/** 中文强信号：规格列出的说法，再加用户平时常用的同义说法。扫描时同一位置取最长匹配。 */
const ZH_SIGNALS = [
  '不要自作主张',
  '别自作主张',
  '别自作聪明',
  '自作聪明',
  '我不是这个意思',
  '不是这个意思',
  '不是这样的',
  '不是这样',
  '别这么干',
  '别这么写',
  '别这么改',
  '别这么做',
  '别这样',
  '别乱改',
  '别乱动',
  '别乱删',
  '别乱来',
  '停下来',
  '停一下',
  '先停下',
  '打住',
  '说人话',
  '讲人话',
  '说大白话',
  '谁让你',
  '我没让你',
  '我什么时候说',
  '我什么时候让',
  '理解错了',
  '搞错了',
  '弄错了',
  '写错了',
  '改错了',
  '做错了',
  '你错了',
  '错了',
  '不对',
  '不许',
  '不能这么',
  '不要这么',
  '回滚',
  '撤回',
  '恢复原样',
  '改回去',
  '重来',
  '重新来',
  '重新做',
  '重做',
  '别删',
  '不要删',
  '先别动',
  '别动',
].sort((a, b) => b.length - a.length);

/** 英文强信号，全部小写匹配、整词边界。 */
const EN_SIGNALS = [
  /\bthat'?s (not|n't) (what|right|it)\b/,
  /\bthis is not what i (said|asked|meant|wanted)\b/,
  /\bnot what i (said|asked|meant|wanted)\b/,
  /\bi didn'?t (ask|say|tell|mean|want)\b/,
  /\bi did not (ask|say|tell|mean|want)\b/,
  /\bi never (said|asked|told you)\b/,
  /\byou (misunderstood|misread|got (it|this) wrong)\b/,
  /\bdon'?t (do that|touch|delete|change|modify|remove|add|rewrite|revert|run|install|push|commit)\b/,
  /\bdo not (touch|delete|change|modify|remove|add|rewrite|revert|run|install|push|commit)\b/,
  /\bno,?\s+(stop|don'?t|do not|wait|that'?s not|not this)\b/,
  /\brevert (that|it|this|your|the)\b/,
  /\bundo (that|it|this|your|the)\b/,
  /\bthat'?s wrong\b/,
  /\bthis is wrong\b/,
  /\byou('?re| are) wrong\b/,
  /\bwrong\b/,
  /\bstop\b/,
];

/** 这些前后文里的「信号」不是在纠正助手：疑问、假设、叙述过去、报错原文。 */
const ZH_BEFORE_VETO =
  /(是不是|对不对|有没有|哪里|什么|是否|或许|可能|也许|未必|不一定|不算|并非|并没有|没觉得|原来|此前|当初|报|出)$/;
/** 假设句：「如果结果不对就重试」里的「不对」不是在纠正助手，条件词后面隔几个字也算。 */
const ZH_CONDITIONAL_VETO = /(如果|假如|万一|即使|哪怕|就算|要是)[^，。！？\s]{0,6}$/;
const ZH_AFTER_VETO = /^(吗|呢|吧|么|嘛|没有|还是|的地方|之处|的话|的部分|在哪|在哪里|在哪儿|的概念|的定义)/;
const EN_BEFORE_VETO = /(what'?s|what is|something|anything|went|goes|gone|is it|is that|was it)\s*$/;
const EN_AFTER_VETO = /^\s*(number|with|direction|way to|format|word|button|ping|watch|per|gap)\b/;

/** 去掉代码块、行内代码、Markdown 引用行和各种引号里的内容：引用和技术输出里的词不算用户在纠正。 */
function stripNoise(message: string): string {
  return message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"/g, ' ');
}

function sentenceAround(text: string, start: number, end: number): string {
  const from = Math.max(text.lastIndexOf('\n', start) + 1, 0);
  let to = text.indexOf('\n', end);
  if (to < 0) to = text.length;
  const sentence = text.slice(from, to).trim();
  return sentence.length > 120 ? `${sentence.slice(0, 120)}…` : sentence;
}

export function detectCorrection(message: string): CorrectionSignal | null {
  if (typeof message !== 'string' || message.trim().length === 0) return null;
  const text = stripNoise(message);

  // 中文：逐位置取最长信号，跳过已经匹配的区间
  let index = 0;
  while (index < text.length) {
    let hit: string | null = null;
    for (const signal of ZH_SIGNALS) {
      if (signal.length > 0 && text.startsWith(signal, index)) {
        hit = signal;
        break; // 列表已按长度降序，第一个命中的就是最长的
      }
    }
    if (hit === null) {
      index += 1;
      continue;
    }
    const before = text.slice(Math.max(0, index - 8), index);
    const after = text.slice(index + hit.length, index + hit.length + 6);
    // 「是不是这样」里的「不是这样」其实属于前面的「是不是」：把信号的前一两个字并进上文一起看
    const contextBefore = [before, before + hit.charAt(0), before + hit.slice(0, 2)];
    const vetoed =
      contextBefore.some((ctx) => ZH_BEFORE_VETO.test(ctx) || ZH_CONDITIONAL_VETO.test(ctx)) ||
      ZH_AFTER_VETO.test(after) ||
      (hit === '不对' && before.endsWith('对'));
    if (!vetoed) {
      return { lang: 'zh', signal: hit, excerpt: sentenceAround(text, index, index + hit.length) };
    }
    index += hit.length;
  }

  // 英文
  const lower = text.toLowerCase();
  for (const pattern of EN_SIGNALS) {
    const match = pattern.exec(lower);
    if (!match || match.index === undefined) continue;
    const whole = match[0];
    const before = lower.slice(Math.max(0, match.index - 12), match.index);
    const after = lower.slice(match.index + whole.length, match.index + whole.length + 12);
    if (EN_BEFORE_VETO.test(before) || EN_AFTER_VETO.test(after)) continue;
    return { lang: 'en', signal: whole, excerpt: sentenceAround(text, match.index, match.index + whole.length) };
  }
  return null;
}

/** 限频：同一个会话里最多每 minTurns 轮记录一次纠错。 */
export class CorrectionThrottle {
  private readonly lastTurn = new Map<string, number>();

  constructor(readonly minTurns = 3) {}

  /** 距离上次记录不足 minTurns 轮就拒绝；允许时顺手记下这一轮。 */
  tryAcquire(sessionId: string, turn: number): boolean {
    const last = this.lastTurn.get(sessionId);
    if (last !== undefined && turn - last < this.minTurns) return false;
    this.lastTurn.set(sessionId, turn);
    return true;
  }
}

/* ====================== 复盘扳机 ====================== */

export const REVIEW_DEFAULTS = { turnThreshold: 10, toolThreshold: 15 } as const;

/** 宿主自己有计数时直接用这个纯函数：轮数或工具调用次数任一到阈值就该复盘。 */
export function isReviewDue(
  counts: { turns: number; toolCalls: number },
  thresholds: { turnThreshold: number; toolThreshold: number } = REVIEW_DEFAULTS,
): boolean {
  return counts.turns >= thresholds.turnThreshold || counts.toolCalls >= thresholds.toolThreshold;
}

/** 宿主没有计数时用这个：记账、判断到没到、复盘后归零。 */
export class ReviewTrigger {
  private turns = 0;
  private toolCalls = 0;

  constructor(readonly thresholds: { turnThreshold: number; toolThreshold: number } = REVIEW_DEFAULTS) {}

  recordTurn(count = 1): void {
    this.turns += count;
  }

  recordToolCall(count = 1): void {
    this.toolCalls += count;
  }

  get due(): boolean {
    return isReviewDue({ turns: this.turns, toolCalls: this.toolCalls }, this.thresholds);
  }

  reset(): void {
    this.turns = 0;
    this.toolCalls = 0;
  }
}

/* ====================== 抢救采集的窗口 ====================== */

export const FLUSH_WINDOW_SIZE = 20;

export interface FlushWindow<T> {
  /** 最近最多 max 条还没覆盖过的消息 */
  window: T[];
  /** 处理完后把它记成新的覆盖位置 */
  lastMessageId: string | null;
}

/**
 * 只看最近 20 条未覆盖消息：上次覆盖到的消息之后的才算新；找不到锚点就从整段里取最近 20 条（宁多勿漏，写入时按总结去重）。
 */
export function selectFlushWindow<T extends { id: string }>(
  messages: readonly T[],
  afterMessageId: string | null,
  max = FLUSH_WINDOW_SIZE,
): FlushWindow<T> {
  let start = 0;
  if (afterMessageId !== null) {
    const anchor = messages.findIndex((m) => m.id === afterMessageId);
    start = anchor >= 0 ? anchor + 1 : 0;
  }
  const uncovered = messages.slice(start);
  const window = uncovered.slice(Math.max(0, uncovered.length - max));
  const last = window[window.length - 1];
  return { window, lastMessageId: last ? last.id : afterMessageId };
}

/* ====================== 模型抽取（复盘 / 抢救共用，不凝结） ====================== */

export interface ExtractOptions {
  store: Store;
  scope: string;
  source: 'review' | 'flush';
  sessionId: string | null;
  messages: ReadonlyArray<ConversationMessage>;
  model: ExtractionModel;
  /** 写入时间；测试里可以固定 */
  now?: () => string;
}

export interface ExtractResult {
  inserted: ExperienceRow[];
  rejected: Array<{ index: number; reason: string }>;
}

const HAN = /\p{Script=Han}/u;
const MAX_EXTRACT_ITEMS = 20;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function validateCandidate(raw: unknown, messages: ReadonlyArray<ConversationMessage>): { kind: ExperienceKind; summary: string; evidence: string } {
  const candidate = raw as Record<string, unknown> | null;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('不是对象');
  }
  for (const key of Object.keys(candidate)) {
    if (!['kind', 'summary', 'evidence'].includes(key)) throw new Error(`多了不允许的字段「${key}」`);
  }
  const kind = candidate.kind;
  if (typeof kind !== 'string' || !['correction', 'preference', 'pitfall', 'decision', 'fact'].includes(kind)) {
    throw new Error('kind 只能是 correction / preference / pitfall / decision / fact');
  }
  const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
  if (summary.length < 4 || summary.length > 300) throw new Error('summary 要是 4 到 300 字的中文句子');
  if (!HAN.test(summary)) throw new Error('summary 必须用自然中文写，不能只有英文或符号');
  const evidence = typeof candidate.evidence === 'string' ? normalizeWhitespace(candidate.evidence) : '';
  if (!evidence) throw new Error('evidence 必须是用户原话的逐字摘录');
  const quoted = messages.some((m) => normalizeWhitespace(m.text).includes(evidence));
  if (!quoted) throw new Error('evidence 在这段对话里找不到原话，拒绝凭空编造的经历');
  return { kind: kind as ExperienceKind, summary, evidence };
}

/**
 * 让注入的抽取模型看一段对话，把它给出的候选逐条校验后写入经历账本。
 * 只采集不凝结；坏候选只丢它自己，不影响其他候选。
 */
export async function extractExperiences(options: ExtractOptions): Promise<ExtractResult> {
  const { store, model } = options;
  const now = options.now ?? (() => new Date().toISOString());
  if (options.messages.length === 0) return { inserted: [], rejected: [] };
  const raw = await model.extract({
    instructions: EXTRACTION_INSTRUCTIONS,
    scope: options.scope,
    sessionId: options.sessionId,
    messages: options.messages,
  });
  const list = Array.isArray(raw) ? raw : (raw as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(list)) throw new Error(`抽取模型「${model.id}」返回的不是数组`);

  const known = new Set(store.listExperiences(options.scope, { limit: 200 }).map((e) => e.summary));
  const seen = new Set<string>();
  const inserted: ExperienceRow[] = [];
  const rejected: ExtractResult['rejected'] = [];
  list.forEach((item, index) => {
    if (index >= MAX_EXTRACT_ITEMS) {
      rejected.push({ index, reason: `超出单批 ${MAX_EXTRACT_ITEMS} 条上限` });
      return;
    }
    try {
      const candidate = validateCandidate(item, options.messages);
      if (known.has(candidate.summary) || seen.has(candidate.summary)) {
        rejected.push({ index, reason: '同样的经历已经记过了' });
        return;
      }
      seen.add(candidate.summary);
      inserted.push(
        store.addExperience({
          scope: options.scope,
          kind: candidate.kind,
          summary: candidate.summary,
          evidence: candidate.evidence,
          source: options.source,
          sourceSession: options.sessionId,
          createdAt: now(),
        }),
      );
    } catch (error) {
      rejected.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return { inserted, rejected };
}

/* ====================== 纠错即时采集 ====================== */

export type CorrectionCapture =
  | { experience: ExperienceRow; condense: { reason: 'correction'; experienceIds: number[] } }
  | { skipped: 'no_signal' | 'throttled' };

/** 进程内共享的默认限频器：宿主没有自己持有的时候用它，保证同一会话真的会被限频。 */
const defaultThrottle = new CorrectionThrottle();
/**
 * 用户发完消息后调用：命中强信号、且这个会话没在限频期内，就立刻记一条 correction 经历，
 * 并给出「马上凝结」的入口（reason = correction，只带这一条经历）。
 */
export function captureCorrection(
  store: Store,
  options: {
    scope: string;
    sessionId: string;
    turn: number;
    message: string;
    throttle?: CorrectionThrottle;
    now?: string;
  },
): CorrectionCapture {
  const signal = detectCorrection(options.message);
  if (!signal) return { skipped: 'no_signal' };
  const throttle = options.throttle ?? defaultThrottle;
  if (!throttle.tryAcquire(options.sessionId, options.turn)) return { skipped: 'throttled' };
  const message = options.message.trim();
  const experience = store.addExperience({
    scope: options.scope,
    kind: 'correction',
    summary: `用户纠正了助手：「${signal.excerpt}」`,
    evidence: message.length > 500 ? `${message.slice(0, 500)}…` : message,
    source: 'correction',
    sourceSession: options.sessionId,
    createdAt: options.now,
  });
  return { experience, condense: { reason: 'correction', experienceIds: [experience.id] } };
}
