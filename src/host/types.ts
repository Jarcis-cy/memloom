/**
 * 宿主无关核心的类型（契约见 docs/HOST-CONTRACT.md）：
 * 宿主适配层把各家 hook 的原始载荷翻成 HostEvent，核心回 HostResponse；这里只有类型和纯函数，不碰数据库。
 */
import type { CondenseModel, ExtractionModel } from '../core/types.js';
import type { LlmConfig } from '../app/llm.js';
import type { Retriever, RetrieverConfig } from '../retriever/index.js';

/* ---------- 事件（输入） ---------- */

export type HostEventType = 'session_start' | 'user_message' | 'assistant_message' | 'tool_result' | 'compact' | 'session_end';

export type HostEvent =
  | { type: 'session_start'; sessionId: string; resume?: boolean; cwd?: string | null }
  | { type: 'user_message'; sessionId: string; text: string }
  | { type: 'assistant_message'; sessionId: string; text: string }
  | { type: 'tool_result'; sessionId: string; toolName: string; isError?: boolean; exitCode?: number | null; output?: string | null; /** 这一下失败的提醒由适配层用别的结果负责（例如同一批工具里只提醒第一个失败）；核心照常计数、记录和调度，只是不再等检索 */ skipHint?: boolean }
  | { type: 'compact'; sessionId: string }
  | { type: 'session_end'; sessionId: string };

/** 工具这一下算不算失败：宿主明说 isError，或退出码是真正的非零数字。 */
export function toolFailed(event: Extract<HostEvent, { type: 'tool_result' }>): boolean {
  if (event.isError === true) return true;
  return typeof event.exitCode === 'number' && Number.isFinite(event.exitCode) && event.exitCode !== 0;
}

/* ---------- 回执（输出） ---------- */

export type HintState = 'off' | 'skipped' | 'silent' | 'timeout' | 'unavailable' | 'empty' | 'hinted';

export type BackgroundKind = 'review' | 'flush' | 'correction';

export interface BackgroundEntry {
  kind: BackgroundKind;
  state: 'queued' | 'spawned' | 'skipped' | 'coalesced';
  reason?: string;
}

export interface HostResponse {
  event: HostEventType;
  sessionId: string;
  scope: string;
  /** 只在 session_start 出现；空串 = 当前作用域没有可注入内容 */
  staticBlock?: string;
  /** 当轮尾部提醒；没有高分命中就是空串 */
  hint: string;
  hintState: HintState;
  hintReason?: string;
  /** 只在 session_start 可能非空 */
  dilemmaNotice: string;
  correction: { captured: boolean; experienceId: number | null; reason: string | null };
  background: BackgroundEntry[];
  elapsedMs: { total: number; hint: number | null };
}

/* ---------- 提醒的参数 ---------- */

export interface HintOptions {
  threshold: number;
  max: number;
  charBudget: number;
  /** 前台最多等多久；超时就丢，不排队不补发 */
  budgetMs: number;
  vectorLimit: number;
  lexicalLimit: number;
  candidateLimit: number;
}

export const HINT_OPTION_DEFAULTS: HintOptions = {
  threshold: 0.72,
  max: 3,
  charBudget: 400,
  budgetMs: 2_000,
  vectorLimit: 6,
  lexicalLimit: 4,
  candidateLimit: 6,
};

/* ---------- 后台任务 ---------- */

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface BackgroundJob {
  kind: BackgroundKind;
  sessionId: string;
  /** correction 任务：只凝结这一条 */
  experienceId?: number;
  /** review / flush 任务：要抽取的那一段对话（已去掉 memloom 自己的注入） */
  messages?: TranscriptMessage[];
}

/** 提交后台任务的两个实现：进程内串行队列（Pi 这类常驻进程）、脱离的短命子进程（关会话 / 压缩前的抢救）。 */
export interface BackgroundRunner {
  submit(job: BackgroundJob): Promise<BackgroundEntry['state']>;
  close(): void;
}

/* ---------- 会话临时状态（不是记忆真源，只是同一会话共享的游标和计数） ---------- */

/** 会话状态归属：同库同作用域才共用一份快照；另一个库或作用域的同名会话各存各的，互不借用。 */
export interface SessionIdentity {
  scope: string;
  dbPath: string;
}
export interface SessionState {
  version: 1;
  scope: string;
  dbPath: string;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  seq: number;
  /** session_start 算一次就固定；同一会话之后原字节返回 */
  staticBlock: string | null;
  staticKeys: string[];
  remindedKeys: string[];
  turn: number;
  toolCalls: number;
  sinceReviewTurns: number;
  sinceReviewTools: number;
  lastCorrectionTurn: number | null;
  messages: TranscriptMessage[];
  coveredMessageId: string | null;
  /** 正在跑 / 排队的后台任务（脱离子进程模式靠它保证同一会话最多 1 跑 1 等） */
}

export interface SessionStore {
  /** 在锁里跑 fn（状态不存在时给一份新的，fresh=true）；fn 结束（含异步）后把状态存回去，persist=false 就删掉不存 */
  withSession<T>(sessionId: string, fn: (state: SessionState, fresh: boolean) => Promise<T> | T, options?: { persist?: boolean }): Promise<T>;
  load(sessionId: string): SessionState | null;
  delete(sessionId: string): void;
}

/* ---------- 配置 ---------- */

export interface HostFlags {
  home?: string;
  db?: string;
  project?: string;
  role?: string;
  stateDir?: string;
}

export interface HostConfig {
  home: string;
  dbPath: string;
  scope: string;
  projectDir: string | null;
  projectId: string | null;
  roleName: string | null;
  stateDir: string;
  retriever?: Retriever;
  retrieverConfig?: RetrieverConfig;
  /** null = 明确没有后台模型；不给 = 从环境变量读 */
  llm?: LlmConfig | null;
  extractionModel?: ExtractionModel;
  condenseModel?: CondenseModel;
  hint?: Partial<HintOptions>;
  review?: { turnThreshold?: number; toolThreshold?: number };
  warmupOnStart?: boolean;
  background?: BackgroundRunner;
  sessionStore?: SessionStore;
  /** 可信的 agent-crew CLI 绝对路径；没有就只提示手动刷新 BRIEF */
  crewCliPath?: string | null;
  now?: () => string;
}

/** 脱离子进程任务说明里可序列化的那部分配置（没有模型实例、没有检索器实例） */
/** 脱离任务说明里允许落盘的后台模型配置：只有端点和模型名，**永远没有凭据**（凭据只走子进程环境）。 */
export type JobLlmConfig = Pick<LlmConfig, 'baseUrl' | 'model' | 'timeoutMs'>;
export interface JobConfig {
  home: string;
  dbPath: string;
  scope: string;
  projectDir: string | null;
  projectId: string | null;
  roleName: string | null;
  stateDir: string;
  llm?: JobLlmConfig | null;
  crewCliPath?: string | null;
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200 && !/[\r\n\0]/.test(value);
}
