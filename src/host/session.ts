/**
 * 会话临时状态：同一会话里静态区只算一次、提醒去重游标、轮数 / 工具计数、后台抽取要用的最近消息。
 * 这不是第二份记忆真源——只是游标和计数；真正的记忆只有 SQLite 四张表。
 * session_end 时清掉对话片段，但保留同一库同一作用域的静态字节 / 去重 / 限频游标：续会话（Pi 的 -c、reload）拿回原字节，7 天过期才清。
 * - MemorySessionStore：同一进程（Pi 这类常驻宿主、测试）。
 * - FileSessionStore：宿主换进程续会话 / 重载时（Pi 的 -c 续会话、reload）仍拿同一份静态区，`<home>/sessions/<会话>.json`（0600）+ 锁文件，
 *   读改写都在锁里；锁的持有者进程死了才清它的锁，等不到就按「等太久」报错，绝不并行写。
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { selectFlushWindow, type FlushWindow } from '../core/capture.js';
import { isProcessAlive } from '../core/process-alive.js';
import { stripInjections } from './static.js';
import type { SessionIdentity, SessionState, SessionStore, TranscriptMessage } from './types.js';

export const SESSION_VERSION = 1;
/** 最近消息留这么多条给后台复盘 / 抢救用（够 20 条窗口再多一点余量） */
export const MAX_TRANSCRIPT = 40;
const USER_CHARS = 4_000;
const ASSISTANT_CHARS = 2_000;
const TOOL_CHARS = 400;
/** 7 天没更新的会话文件下次启动时顺手清掉 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

export function newSessionState(sessionId: string, now: string, identity: SessionIdentity = { scope: '', dbPath: '' }): SessionState {
  return {
    version: SESSION_VERSION,
    sessionId,
    scope: identity.scope,
    dbPath: identity.dbPath,
    startedAt: now,
    updatedAt: now,
    seq: 0,
    staticBlock: null,
    staticKeys: [],
    remindedKeys: [],
    turn: 0,
    toolCalls: 0,
    sinceReviewTurns: 0,
    sinceReviewTools: 0,
    lastCorrectionTurn: null,
    messages: [],
    coveredMessageId: null,
  };
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 往会话里追加一条消息（已去掉 memloom 自己的注入）；只留最近 MAX_TRANSCRIPT 条。 */
export function pushMessage(state: SessionState, role: TranscriptMessage['role'], text: string): TranscriptMessage | null {
  const cleaned = stripInjections(text);
  if (role !== 'tool' && cleaned === '') return null;
  const body = role === 'user' ? clip(cleaned, USER_CHARS) : role === 'assistant' ? clip(cleaned, ASSISTANT_CHARS) : clip(text, TOOL_CHARS);
  if (body === '') return null;
  state.seq += 1;
  const message: TranscriptMessage = { id: `${state.sessionId}:${state.seq}`, role, text: body };
  state.messages.push(message);
  if (state.messages.length > MAX_TRANSCRIPT) state.messages.splice(0, state.messages.length - MAX_TRANSCRIPT);
  return message;
}

/** 上次覆盖以来还没交后台抽取的那一段，最多 max 条（默认 20）。 */
export function uncoveredWindow(state: SessionState, max = 20): FlushWindow<TranscriptMessage> {
  return selectFlushWindow(state.messages, state.coveredMessageId, max);
}

/* ---------- 同一进程 ---------- */

export class MemorySessionStore implements SessionStore {
  private readonly states = new Map<string, SessionState>();

  constructor(private readonly identity: SessionIdentity | null = null) {}

  private owned(state: SessionState): boolean {
    return this.identity === null || (state.scope === this.identity.scope && state.dbPath === this.identity.dbPath);
  }
  private readonly chains = new Map<string, Promise<unknown>>();

  withSession<T>(sessionId: string, fn: (state: SessionState, fresh: boolean) => Promise<T> | T, options: { persist?: boolean } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const found = this.states.get(sessionId) ?? null;
      const existing = found && this.owned(found) ? found : null;
      const fresh = existing === null;
      const current = existing ?? newSessionState(sessionId, new Date().toISOString(), this.identity ?? undefined);
      const result = await fn(current, fresh);
      if (options.persist === false) {
        this.states.delete(sessionId);
      } else {
        current.updatedAt = new Date().toISOString();
        this.states.set(sessionId, current);
      }
      return result;
    };
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.chains.set(sessionId, next.catch(() => undefined));
    return next;
  }

  /** fn 里通过这个办法把改过的状态放回去 */
  save(state: SessionState): void {
    this.states.set(state.sessionId, state);
  }

  load(sessionId: string): SessionState | null {
    return this.states.get(sessionId) ?? null;
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId);
    this.chains.delete(sessionId);
  }
}

/* ---------- 跨进程（hook） ---------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FileSessionStore implements SessionStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    readonly home: string,
    private readonly identity: SessionIdentity | null = null,
  ) {
    mkdirSync(join(home, 'sessions'), { recursive: true, mode: 0o700 });
  }

  private file(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    // 库路径 + 作用域 + 会话号一起散列：同名的另一个库 / 作用域的会话各存各的，互不借用
    const namespace = this.identity ? `${this.identity.dbPath}\0${this.identity.scope}\0` : '';
    const digest = createHash('sha256').update(`${namespace}${sessionId}`).digest('hex').slice(0, 12);
    return join(this.home, 'sessions', `${safe}.${digest}.json`);
  }

  load(sessionId: string): SessionState | null {
    const path = this.file(sessionId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SessionState;
      if (parsed.version !== SESSION_VERSION || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) return null;
      if (this.identity && (parsed.scope !== this.identity.scope || parsed.dbPath !== this.identity.dbPath)) return null;
      return parsed;
    } catch {
      // 坏文件当没有：会话状态只是游标，丢了就重算，不值得拦住宿主
      return null;
    }
  }

  delete(sessionId: string): void {
    rmSync(this.file(sessionId), { force: true });
  }

  private async acquire(lockPath: string): Promise<() => void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // 已经被别人当死锁清了
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // 锁被人拿着：持有者还活着且锁没过期就等；死了或太久没动就清掉重来
      let holder = 0;
      try {
        holder = Number(readFileSync(lockPath, 'utf8').trim());
      } catch {
        holder = 0;
      }
      const age = Date.now() - (existsSync(lockPath) ? statSync(lockPath).mtimeMs : 0);
      if ((holder > 0 && !isProcessAlive(holder)) || age > LOCK_STALE_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          // 别人刚好释放了
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`等会话锁超过 ${LOCK_WAIT_MS} 毫秒（${lockPath}），这次放弃写会话状态`);
      await sleep(20);
    }
  }

  async withSession<T>(sessionId: string, fn: (state: SessionState, fresh: boolean) => Promise<T> | T, options: { persist?: boolean } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const path = this.file(sessionId);
      const lockPath = `${path}.lock`;
      const release = await this.acquire(lockPath);
      try {
        const existing = this.load(sessionId);
        const fresh = existing === null;
        const current = existing ?? newSessionState(sessionId, new Date().toISOString(), this.identity ?? undefined);
        const result = await fn(current, fresh);
        if (options.persist === false) {
          rmSync(path, { force: true });
        } else {
          current.updatedAt = new Date().toISOString();
          const tmp = `${path}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify(current), { mode: 0o600 });
          renameSync(tmp, path);
        }
        return result;
      } finally {
        release();
      }
    };
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.chains.set(sessionId, next.catch(() => undefined));
    return next;
  }

  /** 顺手清掉 7 天没更新的会话文件和残锁；任何失败都不影响主流程。 */
  sweep(now = Date.now()): number {
    const dir = join(this.home, 'sessions');
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs + SESSION_TTL_MS < now) {
          rmSync(path, { force: true });
          removed += 1;
        }
      } catch {
        // 刚被别的进程清了
      }
    }
    return removed;
  }
}

/** 后台任务说明放这里（0600，跑完即删）；目录只给当前用户。 */
export function jobDir(home: string): string {
  const dir = join(home, 'jobs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeJobSpec(home: string, spec: unknown): string {
  const dir = jobDir(home);
  // 先建一个 0700 的私有目录再在里面放文件，避免别的用户在同一目录抢同名
  const unique = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const path = join(dir, `${unique}.json`);
  writeFileSync(path, JSON.stringify(spec), { mode: 0o600 });
  return path;
}

export function removeJobSpec(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 已经没了
  }
}

/** 测试用：建一个临时 home */
export function tempHome(prefix = 'memloom-host-'): string {
  return mkdtempSync(join(process.env.TMPDIR ?? '/tmp', prefix));
}
