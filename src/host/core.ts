/**
 * 宿主无关核心的入口（契约见 docs/HOST-CONTRACT.md）：一条 HostEvent 进来，一条 HostResponse 出去。
 * 这一层把四件事接在一起：静态区（session_start 算一次就固定）、当轮提醒（有前台预算、去重）、
 * 纠错即时入库 + 后台任务（有界、不等网络）、分歧轻声通知（同批一次）。适配层只做载荷翻译。
 */
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { OpenAiCompatibleCondenseModel, OpenAiCompatibleExtractionModel } from '../app/llm.js';
import { CorrectionThrottle, captureCorrection } from '../core/capture.js';
import { openStore, type Store } from '../core/store.js';
import type { CondenseModel, ExtractionModel } from '../core/types.js';
import { AutoRetriever, createRetriever, prepareHostRetriever } from '../retriever/index.js';
import type { Retriever } from '../retriever/types.js';
import { DetachedJobRunner, InProcessRunner, runBackgroundJob, type JobDeps } from './background.js';
import { dilemmaNotice } from './dilemma.js';
import { isStrongCorrection, recallHint, shouldHint, toolFailureQuery, warmupInBackground } from './hint.js';
import { FileSessionStore, newSessionState, pushMessage, uncoveredWindow } from './session.js';
import { buildStaticBlock } from './static.js';
import {
  HINT_OPTION_DEFAULTS,
  isSessionId,
  toolFailed,
  type BackgroundEntry,
  type BackgroundJob,
  type BackgroundKind,
  type BackgroundRunner,
  type HintOptions,
  type HostConfig,
  type HostEvent,
  type HostResponse,
  type SessionState,
  type SessionStore,
} from './types.js';

const REVIEW_DEFAULTS = { turnThreshold: 10, toolThreshold: 15 } as const;
const CORRECTION_MIN_TURNS = 3;
const MAX_REMINDED = 200;
const MAX_LOG = 50;

export interface HostCoreOptions {
  /** 测试 / 宿主注入检索器；不给就按配置或环境变量造 */
  retriever?: Retriever;
  /** 脱离任务的入口脚本（默认和本文件并排的 hook-cli.js） */
  jobEntry?: string;
  /** inline = 所有后台任务都在进程内串行跑（测试、没有编译产物的进程）；默认 mixed：会话内任务进程内、抢救任务脱离 */
  jobMode?: 'mixed' | 'inline';
}

export class HostCore {
  readonly scope: string;
  readonly hint: HintOptions;
  private readonly store: Store;
  private readonly sessions: SessionStore;
  private readonly inline: BackgroundRunner;
  private readonly detached: BackgroundRunner;
  private readonly extractionModel: ExtractionModel | null;
  private readonly condenseModel: CondenseModel | null;
  private readonly reviewThresholds: { turnThreshold: number; toolThreshold: number } = { ...REVIEW_DEFAULTS };
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly pendings = new Set<Promise<void>>();
  private readonly logs: string[] = [];
  private retrieverValue: Retriever | null = null;
  private closed = false;

  constructor(
    readonly config: HostConfig,
    options: HostCoreOptions = {},
  ) {
    this.scope = config.scope;
    this.hint = { ...HINT_OPTION_DEFAULTS, ...(config.hint ?? {}) };
    this.reviewThresholds = { ...REVIEW_DEFAULTS, ...(config.review ?? {}) };
    try {
      if (lstatSync(config.dbPath).isSymbolicLink()) throw new Error(`库文件「${config.dbPath}」是符号链接，拒绝打开`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
    this.store = openStore(config.dbPath);
    this.sessions = config.sessionStore ?? new FileSessionStore(config.home, { scope: config.scope, dbPath: config.dbPath });
    if (this.sessions instanceof FileSessionStore) this.pushLog(`清理了 ${this.sessions.sweep()} 个过期会话文件`);
    this.extractionModel = config.extractionModel ?? (config.llm ? new OpenAiCompatibleExtractionModel(config.llm) : null);
    this.condenseModel = config.condenseModel ?? (config.llm ? new OpenAiCompatibleCondenseModel(config.llm) : null);
    const jobConfig = {
      home: config.home,
      dbPath: config.dbPath,
      scope: config.scope,
      projectDir: config.projectDir,
      projectId: config.projectId,
      roleName: config.roleName,
      stateDir: config.stateDir,
      // 只放端点和模型名：凭据不进任务说明，走子进程环境
      llm: config.llm ? { baseUrl: config.llm.baseUrl, model: config.llm.model, timeoutMs: config.llm.timeoutMs } : null,
      crewCliPath: config.crewCliPath ?? null,
    };
    this.inline = new InProcessRunner((job) => runBackgroundJob(job, this.deps()), (line) => this.pushLog(line));
    this.detached = options.jobMode === 'inline' ? this.inline : new DetachedJobRunner(jobConfig, options.jobEntry, config.llm?.apiKey);
    if (options.retriever) this.retrieverValue = options.retriever;
  }

  /** 共享检索服务的客户端；从不在这个进程里加载模型。 */
  get retriever(): Retriever {
    if (!this.retrieverValue) {
      this.retrieverValue = createRetriever(this.config.retrieverConfig ?? { mode: 'fts-only', reason: '宿主没有给检索配置，提醒保持安静' });
      // auto 模式的切换 / 拉起下载 / 失败原因记进宿主日志，排错时能看见
      if (this.retrieverValue instanceof AutoRetriever) this.retrieverValue.setLog((line) => this.pushLog(line));
    }
    return this.retrieverValue;
  }

  /** 最近的日志（后台任务结果、预热结果），给回执和排错用；不含用户原话。 */
  recentLog(): readonly string[] {
    return [...this.logs];
  }

  /** 等所有还在跑的后台任务和超时残留的召回收尾（测试和收尾用；用户会话不要等它）。 */
  async settle(): Promise<void> {
    await (this.inline as InProcessRunner).idle();
    await Promise.allSettled([...this.pendings]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inline.close();
    this.detached.close();
    this.store.close();
  }

  private now(): string {
    return (this.config.now ?? (() => new Date().toISOString()))();
  }

  private pushLog(line: string): void {
    this.logs.push(`${this.now()} ${line}`);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
  }

  private deps(): JobDeps {
    return {
      store: this.store,
      scope: this.scope,
      projectDir: this.config.projectDir,
      extractionModel: this.extractionModel,
      condenseModel: this.condenseModel,
      sessionStore: this.sessions,
      crewCliPath: this.config.crewCliPath ?? null,
      now: () => this.now(),
      log: (line) => this.pushLog(line),
    };
  }

  /** 进会话的事件按会话串行；同一会话两条事件绝不交错改状态。 */
  handle(event: HostEvent): Promise<HostResponse> {
    if (!isSessionId(event.sessionId)) {
      return Promise.reject(new Error('宿主事件缺少合法的 sessionId（非空、不超过 200 字、不含换行）'));
    }
    const run = () => this.dispatch(event);
    const previous = this.chains.get(event.sessionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.chains.set(event.sessionId, next.catch(() => undefined));
    return next;
  }

  private base(event: HostEvent): HostResponse {
    return {
      event: event.type,
      sessionId: event.sessionId,
      scope: this.scope,
      hint: '',
      hintState: 'off',
      dilemmaNotice: '',
      correction: { captured: false, experienceId: null, reason: null },
      background: [],
      elapsedMs: { total: 0, hint: null },
    };
  }

  private async dispatch(event: HostEvent): Promise<HostResponse> {
    if (this.closed) throw new Error('HostCore 已经关闭');
    const started = Date.now();
    let response: HostResponse;
    switch (event.type) {
      case 'session_start':
        response = await this.onSessionStart(event);
        break;
      case 'user_message':
        response = await this.onUserMessage(event);
        break;
      case 'assistant_message':
        response = await this.sessions.withSession(event.sessionId, async (state, fresh) => {
          await this.ensureStatic(state, fresh);
          pushMessage(state, 'assistant', event.text);
          return this.base(event);
        });
        break;
      case 'tool_result':
        response = await this.onToolResult(event);
        break;
      case 'compact':
      case 'session_end':
        response = await this.onFlush(event);
        break;
    }
    response.elapsedMs.total = Date.now() - started;
    return response;
  }

  /* ---------- 静态区：算一次就固定 ---------- */

  private async ensureStatic(state: SessionState, fresh: boolean): Promise<void> {
    if (!fresh && state.staticBlock !== null) return;
    const built = buildStaticBlock({
      ironRules: this.store.listIronRules(this.scope),
      corePrinciples: this.store.listPrinciples(this.scope).filter((p) => p.isCore),
    });
    state.staticBlock = built.block;
    state.staticKeys = built.keys;
  }

  private async onSessionStart(event: Extract<HostEvent, { type: 'session_start' }>): Promise<HostResponse> {
    return this.sessions.withSession(event.sessionId, async (state, fresh) => {
      const response = this.base(event);
      await this.ensureStatic(state, fresh);
      response.staticBlock = state.staticBlock ?? '';
      if (fresh) {
        response.dilemmaNotice = dilemmaNotice({ store: this.store, scope: this.scope }).text;
      }
      // 唯一一处显式预检：auto 模式缺本地模型时在这里就拉起后台下载（不等网络），本轮和接下来的提醒先用字面检索；
      // 模型已经下齐时这里会切到本地检索，下面的预热照常进行。关了自动下载、配了 API 或 fts-only 时什么都不做
      const prepared = prepareHostRetriever(this.retriever);
      if (prepared.download) response.background.push({ kind: 'model-download', state: prepared.download.state, reason: prepared.download.reason });
      if (this.config.warmupOnStart !== false && this.retriever.dimensions > 0) {
        this.track(warmupInBackground(this.retriever, (line) => this.pushLog(line)));
      }
      return response;
    });
  }

  /* ---------- 用户消息：计数、纠错即时入库、当轮提醒、复盘扳机 ---------- */

  private async onUserMessage(event: Extract<HostEvent, { type: 'user_message' }>): Promise<HostResponse> {
    const gate = shouldHint(event.text);
    const strong = isStrongCorrection(event.text);
    return this.sessions.withSession(event.sessionId, async (state, fresh) => {
      const response = this.base(event);
      await this.ensureStatic(state, fresh);
      state.turn += 1;
      state.sinceReviewTurns += 1;
      pushMessage(state, 'user', event.text);
      response.correction = this.captureIfCorrection(event, state, strong);
      if (response.correction.captured && response.correction.experienceId !== null) {
        response.background.push(await this.submit({ kind: 'correction', sessionId: event.sessionId, experienceId: response.correction.experienceId }));
      }
      if (!gate.ok) {
        response.hintState = 'skipped';
        response.hintReason = gate.reason;
      } else {
        const keys = await this.hintFor(response, event.text, new Set([...state.staticKeys, ...state.remindedKeys]), strong);
        for (const key of keys) {
          if (!state.remindedKeys.includes(key)) state.remindedKeys.push(key);
        }
        if (state.remindedKeys.length > MAX_REMINDED) state.remindedKeys.splice(0, state.remindedKeys.length - MAX_REMINDED);
      }
      await this.maybeReview(state, response, event.sessionId);
      return response;
    });
  }

  /** 同一会话每 3 轮最多记一次纠错；命中就立刻写库（不等后台）。 */
  private captureIfCorrection(event: Extract<HostEvent, { type: 'user_message' }>, state: SessionState, strong: boolean): HostResponse['correction'] {
    if (!strong) return { captured: false, experienceId: null, reason: null };
    if (state.lastCorrectionTurn !== null && state.turn - state.lastCorrectionTurn < CORRECTION_MIN_TURNS) {
      return { captured: false, experienceId: null, reason: `这个会话第 ${state.lastCorrectionTurn} 轮刚记过一次纠错，${CORRECTION_MIN_TURNS} 轮内不重复记` };
    }
    const captured = captureCorrection(this.store, {
      scope: this.scope,
      sessionId: event.sessionId,
      turn: state.turn,
      message: event.text,
      throttle: new CorrectionThrottle(0),
      now: this.now(),
    });
    if ('skipped' in captured) return { captured: false, experienceId: null, reason: captured.skipped === 'no_signal' ? '没有检测到纠错信号' : '限频期内' };
    state.lastCorrectionTurn = state.turn;
    return { captured: true, experienceId: captured.experience.id, reason: null };
  }

  /* ---------- 工具结果：计数、失败才提醒 ---------- */

  private async onToolResult(event: Extract<HostEvent, { type: 'tool_result' }>): Promise<HostResponse> {
    const failed = toolFailed(event);
    return this.sessions.withSession(event.sessionId, async (state, fresh) => {
      const response = this.base(event);
      await this.ensureStatic(state, fresh);
      state.toolCalls += 1;
      state.sinceReviewTools += 1;
      pushMessage(state, 'tool', `[${event.toolName}]${failed ? ' 失败' : ''}：${event.output ?? ''}`.trim());
      if (event.skipHint === true) {
        response.hintState = 'skipped';
        response.hintReason = '适配层标了 skipHint：这一下失败的提醒由别的结果负责，核心不再等检索';
      } else if (failed) {
        const keys = await this.hintFor(response, toolFailureQuery(event.toolName, event.output), new Set([...state.staticKeys, ...state.remindedKeys]), false);
        for (const key of keys) {
          if (!state.remindedKeys.includes(key)) state.remindedKeys.push(key);
        }
      }
      await this.maybeReview(state, response, event.sessionId);
      return response;
    });
  }

  /** 做一次有预算的提醒；返回这次提醒出去的键（宿主记进会话游标） */
  private async hintFor(response: HostResponse, query: string, exclude: ReadonlySet<string>, allowRepeat: boolean): Promise<string[]> {
    const outcome = await recallHint({ store: this.store, scope: this.scope, query, retriever: this.retriever, options: this.hint, exclude, allowRepeat });
    response.hint = outcome.hint;
    response.hintState = outcome.state;
    if (outcome.reason) response.hintReason = outcome.reason;
    response.elapsedMs.hint = outcome.elapsedMs;
    if (outcome.pending) this.track(outcome.pending);
    return outcome.keys;
  }

  private track(promise: Promise<void>): void {
    this.pendings.add(promise);
    void promise.then(
      () => this.pendings.delete(promise),
      () => this.pendings.delete(promise),
    );
  }

  /* ---------- 后台任务 ---------- */

  private async submit(job: BackgroundJob): Promise<BackgroundEntry> {
    const needs = job.kind === 'correction' ? this.condenseModel : this.extractionModel;
    if (!needs) return { kind: job.kind, state: 'skipped', reason: '没有配置后台模型（MEMLOOM_LLM_BASE_URL / MEMLOOM_LLM_MODEL），什么都没发' };
    // 会话还在时任务在进程内串行跑；关会话 / 压缩前的抢救用脱离的短命子进程，宿主进程退出也做得完
    const runner: BackgroundRunner = job.kind === 'flush' ? this.detached : this.inline;
    try {
      return { kind: job.kind, state: await runner.submit(job) };
    } catch (error) {
      return { kind: job.kind, state: 'skipped', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async maybeReview(state: SessionState, response: HostResponse, sessionId: string): Promise<void> {
    const due = state.sinceReviewTurns >= this.reviewThresholds.turnThreshold || state.sinceReviewTools >= this.reviewThresholds.toolThreshold;
    if (!due) return;
    state.sinceReviewTurns = 0;
    state.sinceReviewTools = 0;
    const window = uncoveredWindow(state);
    if (window.window.length === 0) return;
    response.background.push(await this.submit({ kind: 'review', sessionId, messages: window.window }));
  }

  private async onFlush(event: Extract<HostEvent, { type: 'compact' } | { type: 'session_end' }>): Promise<HostResponse> {
    const ending = event.type === 'session_end';
    return this.sessions.withSession(
      event.sessionId,
      async (state) => {
        const response = this.base(event);
        const window = uncoveredWindow(state);
        if (window.window.length > 0) {
          response.background.push(await this.submit({ kind: 'flush', sessionId: event.sessionId, messages: window.window }));
        }
        if (ending) {
          // 关会话：对话片段清掉（抢救任务已经带走这一段），静态字节 / 去重 / 限频游标留给同一库同一作用域的续接
          state.messages = [];
          state.coveredMessageId = null;
          state.sinceReviewTurns = 0;
          state.sinceReviewTools = 0;
        } else if (window.lastMessageId) {
          state.coveredMessageId = window.lastMessageId;
        }
        return response;
      },
      // 关会话也保留会话状态：静态字节 / 去重 / 限频游标留给同一库同一作用域的续接；只清对话片段（7 天过期才整个删掉）
      {
        persist: true,
      },
    );
  }
}

export { newSessionState };
export type { BackgroundKind };
