/**
 * 单机共享检索服务的进程骨架：独占锁 → Unix socket 监听 → 按需加载模型 → 闲置退出 → 安全停止。
 *
 * 关键约束（架构规格 §3.2）：
 * - 模型只在「独占成功 且 监听成功」之后才加载；并发首启时输掉的进程不加载、直接退出；
 * - 空闲超过 idleMs（默认 10 分钟）且没有在途请求就退出，socket 和锁一起清掉；
 * - 绝不杀任何进程、绝不删还在用的 socket；崩溃后残留的 socket（连不上）才清。
 *
 * 独占锁是 Lamport 面包店算法的文件版（锁目录 retriever.lock/ 里每个竞争者一张 choosing.<pid> 选择牌、
 * 一张 ticket.<pid> 票，票号 = 当前最大票号 + 1，票号最小者独占）。这样选的原因：
 * - 票的文件名带着拥有者身份，别人只会在「拥有者进程已经死了」时清它，这个判断只会从「可清」变成「不可清」，
 *   活着的服务永远不会被误删锁；后来者拿到的票号一定比在役者大，所以在役者不会被后来者顶掉；
 * - 票的内容先写进私有临时文件、写满后再 link 到正式名字，要么完整要么不存在，没有「空记录」窗口；
 * - 多个恢复者同时处理崩溃残留时，只有票号最小的那一个会去清残留、监听、加载，其余的只等待或退出，
 *   不会把过期的观察用到新锁或新 socket 上。
 *
 * 这个文件不 import 任何模型运行时；真实后端在 daemon.ts 里注入，测试替身在 fixtures 里注入。
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isProcessAlive } from '../core/process-alive.js';
import { ensureStateDir, statePaths, type StatePaths } from './paths.js';
import {
  MAX_TEXT_CHARS,
  MAX_TEXTS_PER_REQUEST,
  PROTOCOL_VERSION,
  encodeLine,
  protocolError,
  type Request,
  type Response,
  type ServiceStatus,
} from './protocol.js';
import { clampScore } from './types.js';

/** 默认完全闲置 10 分钟退出 */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** stop / 信号之后最多等在途请求这么久 */
const DRAIN_MS = 5_000;
/** 等更低票号的竞争者（启动、加载、退出）最多这么久 */
const CONTENDER_WAIT_MS = 60_000;
const LOG_MAX_BYTES = 1024 * 1024;
const TICKET_NAME = /^ticket\.(\d+)$/;
const CHOOSING_NAME = /^choosing\.(\d+)$/;

export interface RerankScore {
  index: number;
  score: number;
}

/** 服务进程里真正干活的后端：真实 ONNX 模型或测试替身。 */
export interface ServiceBackend {
  readonly kind: 'onnx' | 'stub';
  readonly modelId: string;
  readonly dimensions: number;
  /** 取证信息：模型文件、revision、线程数等（不含凭据，不进日志正文） */
  readonly models: Record<string, unknown>;
  embed(texts: string[], mode: 'query' | 'document'): Promise<Float32Array[]>;
  rerank(query: string, documents: string[], topK: number): Promise<RerankScore[]>;
}

/** 测试用的调度钩子：让并发竞态可以按剧本发生，而不是靠碰运气 */
export interface ServiceHooks {
  /** 拿到票之后、扫描竞争者之前 */
  beforeScan?: () => Promise<void> | void;
  /** 清掉过期 socket 之前 */
  beforeStaleSocketRemoval?: () => Promise<void> | void;
  /** 监听成功之后、加载模型之前 */
  afterListen?: () => Promise<void> | void;
}

export interface ServiceOptions {
  stateDir: string;
  /** 只用来在 status 里如实报告 */
  modelDir: string;
  idleMs: number;
  /** 加载之前就能告诉客户端的后端类型 */
  backendKind: ServiceBackend['kind'];
  /** 只有独占成功、监听成功之后才会被调用 */
  load: () => Promise<ServiceBackend>;
  log?: (message: string) => void;
  hooks?: ServiceHooks;
}

export type ServiceOutcome = 'stopped' | 'idle' | 'lost' | 'failed';

export interface ServiceExit {
  outcome: ServiceOutcome;
  detail: string;
}

/* ---------- 小工具 ---------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

/** 追加写日志的函数；超过 1 MiB 先转成 .1，写不进去也绝不影响服务。 */
export function createFileLogger(logPath: string): (message: string) => void {
  return (message: string) => {
    try {
      try {
        if (statSync(logPath).size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
      } catch {
        // 还没有日志文件
      }
      appendFileSync(logPath, `[${new Date().toISOString()}] pid=${process.pid} ${message}\n`, { mode: 0o600 });
    } catch {
      // 日志目录不可写时静默，服务本身照常
    }
  };
}

/* ---------- 独占锁：文件版面包店算法 ---------- */

export interface LockInfo {
  /** 票号，越小越优先 */
  ticket: number;
  pid: number;
  startedAt: string;
  /** 守护进程入口脚本名，用来辨认票的拥有者是不是检索服务 */
  entry: string;
}

interface Contender {
  pid: number;
  /** 还在选票阶段（选择牌还在） */
  choosing: boolean;
  /** 读得出的票；读不出当 null（按「更优先」处理，宁可等不抢） */
  info: LockInfo | null;
}

function listLockNames(dir: string): { tickets: number[]; choosing: number[] } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { tickets: [], choosing: [] };
  }
  const tickets: number[] = [];
  const choosing: number[] = [];
  for (const name of names) {
    const ticket = TICKET_NAME.exec(name);
    if (ticket) tickets.push(Number(ticket[1]));
    else {
      const mark = CHOOSING_NAME.exec(name);
      if (mark) choosing.push(Number(mark[1]));
    }
  }
  return { tickets, choosing };
}

function readTicket(dir: string, pid: number): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `ticket.${pid}`), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as { pid?: unknown }).pid === 'number') {
      const candidate = parsed as LockInfo;
      if (typeof candidate.ticket !== 'number' || candidate.pid !== pid) return null;
      return candidate;
    }
  } catch {
    // 读不出就当 null
  }
  return null;
}

function ownEntryName(): string {
  return basename(process.argv[1] ?? '');
}

/** 这个 pid 现在是不是一个活着的检索守护进程（拥有者死了，或 pid 被别的程序复用，都算不是） */
function isLiveDaemon(pid: number, entry: string | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  return looksLikeDaemon(pid, entry || ownEntryName());
}

function contenders(dir: string): Contender[] {
  const { tickets, choosing } = listLockNames(dir);
  const out: Contender[] = [];
  for (const pid of new Set([...tickets, ...choosing])) {
    const hasTicket = tickets.includes(pid);
    const info = hasTicket ? readTicket(dir, pid) : null;
    if (!isLiveDaemon(pid, info?.entry)) continue;
    out.push({ pid, choosing: choosing.includes(pid), info });
  }
  return out;
}

/**
 * 入口扫描用：(票号, pid) 字典序更小者更优先；还在选票（选择牌在）或读不出票的当最优先（等它把票发出来再比）。
 * 这是面包店算法要求的：只有等对方选完票，比较才是对的。
 */
function precedes(other: Contender, mine: LockInfo): boolean {
  if (other.choosing || !other.info) return true;
  return publishedPrecedes(other, mine);
}

/**
 * 已经赢过入口扫描之后再核对用：只比已发布的票。后来者的票号是在赢家发布之后才算的，一定更大，
 * 所以它们「正在选票」不构成威胁；若把它们当前辈，赢家会无缘无故让位，造成第二个赢家的假象。
 */
function publishedPrecedes(other: Contender, mine: LockInfo): boolean {
  if (!other.info) return false;
  return other.info.ticket < mine.ticket || (other.info.ticket === mine.ticket && other.pid < mine.pid);
}

/**
 * 只清「拥有者进程已经死了」或「pid 被别的程序复用」的票和选择牌。
 * 文件名带着拥有者身份，这个判断是单调的，绝不会误伤活着的服务。
 */
function gcStale(dir: string, log: (message: string) => void): void {
  const { tickets, choosing } = listLockNames(dir);
  for (const pid of new Set([...tickets, ...choosing])) {
    const info = tickets.includes(pid) ? readTicket(dir, pid) : null;
    if (isLiveDaemon(pid, info?.entry)) continue;
    for (const name of [`ticket.${pid}`, `choosing.${pid}`]) {
      try {
        unlinkSync(join(dir, name));
        log(`清掉已退出进程 pid=${pid} 留下的 ${name}`);
      } catch {
        // 已经被别人清了
      }
    }
  }
}

/**
 * 这个 pid 是不是还活着（和会话文件锁共用 src/core/process-alive.ts 那一套）：
 * Linux 下 kill(0) 对僵尸 / dead 进程也成功，所以再看一眼 /proc/<pid>/stat，已经退出的不算活着。
 */
export { isProcessAlive };

/**
 * 这个 pid 是不是 memloom 的检索守护进程：看 /proc/<pid>/cmdline 里有没有入口脚本名。
 * 没有 /proc 或读不到时宁可当它是（绝不动它）。
 */
export function looksLikeDaemon(pid: number, entry: string): boolean {
  const needle = basename(entry);
  if (needle === '') return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle);
  } catch {
    return true;
  }
}

/** 票的正文先写进私有临时文件、写满，再 link 到正式名字：要么完整要么不存在。 */
function publishTicket(path: string, info: LockInfo): void {
  const temp = `${path}.${info.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(info));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temp, path);
    } catch (error) {
      // 只有同一个 pid 的旧票（pid 复用）才会撞名，上面已经清过；真撞上就当已发布
      if (!isErrno(error, 'EEXIST')) throw error;
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // 临时文件已经不在
    }
  }
}

function nextTicketNumber(dir: string): number {
  let max = 0;
  for (const pid of listLockNames(dir).tickets) {
    const info = readTicket(dir, pid);
    if (info) max = Math.max(max, info.ticket);
  }
  return max + 1;
}

function removeOwnEntries(dir: string, pid: number, log: (message: string) => void): void {
  for (const name of [`ticket.${pid}`, `choosing.${pid}`]) {
    try {
      unlinkSync(join(dir, name));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) log(`删自己的 ${name} 失败：${messageOf(error)}`);
    }
  }
  // 空的锁目录留着不删：别人可能刚建好目录还没写选择牌，删目录会让它写失败
}

/**
 * 客户端用：看锁目录里此刻有没有活着的守护进程（在起或在跑），返回票号最小的那个；没有返回 null。
 * 锁路径被一个普通文件占着（不是我们的锁目录）时返回 pid = -1 的占位，调用方按「没有活着的守护进程」处理，
 * 真正的服务进程会拒绝启动并写明原因。
 */
export function readLock(lockPath: string): LockInfo | null {
  if (!existsSync(lockPath)) return null;
  let stats;
  try {
    stats = statSync(lockPath);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) return { ticket: -1, pid: -1, startedAt: '', entry: '' };
  const live = contenders(lockPath).filter((contender) => contender.info);
  if (live.length === 0) return null;
  live.sort((a, b) => (a.info as LockInfo).ticket - (b.info as LockInfo).ticket || a.pid - b.pid);
  return (live[0] as Contender).info;
}

/**
 * 抢独占：发选择牌 → 取票（当前最大票号 + 1）→ 撤选择牌 → 等所有更优先的活着的竞争者退出。
 * 独占成功返回 release 函数；等超时返回 null（绝不去动别人的票）。
 */
async function acquireLock(paths: StatePaths, log: (message: string) => void, hooks: ServiceHooks): Promise<{ mine: LockInfo; release: () => void } | null> {
  const dir = paths.lockPath;
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    throw new Error(`锁路径 ${dir} 被一个普通文件占着而不是锁目录，拒绝启动；请确认它不是别的程序在用后手动删除`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  gcStale(dir, log);
  const me = process.pid;
  // 上一个同 pid 的进程（pid 复用）留下的自己的票：文件名就是我们自己的身份，先清掉
  removeOwnEntries(dir, me, log);
  const choosingPath = join(dir, `choosing.${me}`);
  writeFileSync(choosingPath, '', { mode: 0o600, flag: 'wx' });
  let mine: LockInfo;
  try {
    mine = { ticket: nextTicketNumber(dir), pid: me, startedAt: new Date().toISOString(), entry: process.argv[1] ?? '' };
    publishTicket(join(dir, `ticket.${me}`), mine);
  } finally {
    try {
      unlinkSync(choosingPath);
    } catch {
      // 选择牌已经不在
    }
  }
  log(`本进程 pid=${me} 拿到 ${mine.ticket} 号票，等更低票号的活着的竞争者`);
  await hooks.beforeScan?.();
  const stillWinner = (): boolean => !contenders(dir).some((other) => other.pid !== me && precedes(other, mine));
  const deadline = Date.now() + CONTENDER_WAIT_MS;
  for (;;) {
    if (stillWinner()) {
      log(`本进程 pid=${me} 票号最小，独占成功；现在才会去监听，监听成功后才加载模型`);
      return { mine, release: () => removeOwnEntries(dir, me, log) };
    }
    if (Date.now() > deadline) {
      log(`等更低票号的竞争者超过 ${CONTENDER_WAIT_MS} 毫秒，放弃且不加载模型`);
      removeOwnEntries(dir, me, log);
      return null;
    }
    // 排在前面的竞争者已经在服务：本进程多余，不加载模型直接退出（它还在起、或已崩溃残留时才继续等自己的 turn）
    if ((await probeSocket(paths.socketPath, 300)) === 'live') {
      log('排在前面的竞争者已经在服务，本进程不加载模型，直接退出');
      removeOwnEntries(dir, me, log);
      return null;
    }
    await sleep(60);
  }
}

/* ---------- socket 探测与身份 ---------- */

export type SocketProbe = 'none' | 'live' | 'dead' | 'unknown';

/** 探一下 socket：none 没有文件；live 有服务在听；dead 有文件但连不上（崩溃残留）；unknown 说不清，一律不动。 */
export function probeSocket(socketPath: string, timeoutMs = 500): Promise<SocketProbe> {
  if (!existsSync(socketPath)) return Promise.resolve('none');
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (value: SocketProbe): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done('live'));
    socket.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      done(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'dead' : 'unknown');
    });
    socket.setTimeout(timeoutMs, () => done('unknown'));
  });
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function identityOf(path: string): FileIdentity | null {
  try {
    const stats = lstatSync(path);
    return stats.isSocket() ? { dev: stats.dev, ino: stats.ino } : null;
  } catch {
    return null;
  }
}

/** 只删「本进程监听成功时绑定的那一个」socket：路径上的 inode 和记录的一致才删。 */
function removeOwnSocket(paths: StatePaths, identity: FileIdentity | null, log: (message: string) => void): void {
  if (!identity) return;
  try {
    const current = identityOf(paths.socketPath);
    if (!current) return;
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      log('socket 路径上已经不是本进程绑定的那个文件，不动它');
      return;
    }
    unlinkSync(paths.socketPath);
    log('已删除本进程绑定的 socket 文件');
  } catch (error) {
    log(`删 socket 文件失败：${messageOf(error)}`);
  }
}

function writeLastError(paths: StatePaths, detail: string): void {
  try {
    writeFileSync(paths.lastErrorPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), detail }), { mode: 0o600 });
  } catch {
    // 写不了就算了，客户端会按超时处理
  }
}

/* ---------- 请求校验 ---------- */

function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { id?: unknown; method?: unknown };
  return (
    typeof candidate.id === 'number' &&
    (candidate.method === 'status' ||
      candidate.method === 'stop' ||
      candidate.method === 'embed' ||
      candidate.method === 'rerank')
  );
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_CHARS;
}

function validTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_TEXTS_PER_REQUEST && value.every(validText);
}

/* ---------- 主流程 ---------- */

/**
 * 跑一个服务进程，直到它退出才 resolve。返回值告诉调用方为什么退出，由入口决定退出码。
 */
export async function runService(options: ServiceOptions): Promise<ServiceExit> {
  const paths = statePaths(options.stateDir);
  ensureStateDir(paths.stateDir);
  const log = options.log ?? createFileLogger(paths.logPath);
  const idleMs = Math.max(250, Math.floor(options.idleMs));
  const hooks = options.hooks ?? {};

  let lock: { mine: LockInfo; release: () => void } | null;
  try {
    lock = await acquireLock(paths, log, hooks);
  } catch (error) {
    const detail = `抢独占锁失败：${messageOf(error)}`;
    log(detail);
    writeLastError(paths, detail);
    return { outcome: 'failed', detail };
  }
  if (!lock) return { outcome: 'lost', detail: '已有检索服务在运行或正在启动，本进程没有加载模型就退出了' };
  const { mine, release } = lock;
  try {
    const probe = await probeSocket(paths.socketPath);
    if (probe === 'live' || probe === 'unknown') {
      return { outcome: 'lost', detail: `socket ${paths.socketPath} 上已经有活着的服务，不碰它` };
    }
    if (probe === 'dead') {
      // 只有票号最小的活着的竞争者才会走到这里：残留 socket 的拥有者一定已经死了，删它不会伤到任何活着的服务
      await hooks.beforeStaleSocketRemoval?.();
      const stale = identityOf(paths.socketPath);
      const rival = contenders(paths.lockPath).some((other) => other.pid !== mine.pid && publishedPrecedes(other, mine));
      if (rival) return { outcome: 'lost', detail: '清理残留前发现票号更小的竞争者，本进程退出' };
      if (stale && identityOf(paths.socketPath)?.ino === stale.ino) {
        unlinkSync(paths.socketPath);
        log('清掉上次崩溃留下的 socket 文件');
      }
    }
    return await serve(paths, options, idleMs, log, mine, hooks);
  } finally {
    release();
  }
}

function serve(
  paths: StatePaths,
  options: ServiceOptions,
  idleMs: number,
  log: (message: string) => void,
  mine: LockInfo,
  hooks: ServiceHooks,
): Promise<ServiceExit> {
  return new Promise<ServiceExit>((resolve) => {
    const startedAt = new Date().toISOString();
    const state = {
      loadedAt: null as string | null,
      loading: true,
      loadError: null as string | null,
      inFlight: 0,
      requestsServed: 0,
      lastActivityAt: startedAt,
      stopping: false,
    };
    let backend: ServiceBackend | null = null;
    let server: Server | null = null;
    let socketIdentity: FileIdentity | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let loadStarted = false;
    let startLoad: () => void = () => {};
    const loaded = new Promise<void>((resolveLoaded) => {
      // 监听成功之前不放行；监听成功后由 startLoad 真正开始加载
      startLoad = () => {
        if (loadStarted) return;
        loadStarted = true;
        options.load().then(
          (loadedBackend) => {
            backend = loadedBackend;
            state.loadedAt = new Date().toISOString();
            state.loading = false;
            // 闲置时间从「可以服务了」算起，而不是从进程启动算起，否则加载慢于闲置阈值的服务刚就绪就会被判闲置
            state.lastActivityAt = state.loadedAt;
            log(`模型加载完成：${loadedBackend.modelId}（${loadedBackend.dimensions} 维，后端 ${loadedBackend.kind}）`);
            resolveLoaded();
          },
          (error: unknown) => {
            state.loading = false;
            state.loadError = messageOf(error);
            resolveLoaded();
            shutdown('failed', `模型加载失败：${state.loadError}`);
          },
        );
      };
    });

    const finish = (result: ServiceExit): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearInterval(idleTimer);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      if (result.outcome === 'failed') writeLastError(paths, result.detail);
      resolve(result);
    };

    const shutdown = (outcome: ServiceOutcome, detail: string): void => {
      if (state.stopping) return;
      state.stopping = true;
      log(`${detail}，开始退出（在途请求 ${state.inFlight} 个）`);
      if (idleTimer) clearInterval(idleTimer);
      const drainDeadline = Date.now() + DRAIN_MS;
      const drain = (): void => {
        if (state.inFlight > 0 && Date.now() < drainDeadline) {
          setTimeout(drain, 50);
          return;
        }
        if (server) {
          server.close(() => {});
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        }
        removeOwnSocket(paths, socketIdentity, log);
        log(`进程 pid=${process.pid} 退出：${outcome}`);
        finish({ outcome, detail });
      };
      drain();
    };
    const onSignal = (): void => shutdown('stopped', '收到停止信号');

    const buildStatus = (): ServiceStatus => ({
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      backend: options.backendKind,
      modelId: backend?.modelId ?? '',
      dimensions: backend?.dimensions ?? 0,
      stateDir: paths.stateDir,
      modelDir: options.modelDir,
      startedAt,
      loadedAt: state.loadedAt,
      loading: state.loading,
      inFlight: state.inFlight,
      requestsServed: state.requestsServed,
      lastActivityAt: state.lastActivityAt,
      idleMs,
      rssBytes: process.memoryUsage().rss,
      nodeVersion: process.version,
      models: backend?.models ?? {},
    });

    const execute = async (request: Request): Promise<Response> => {
      const id = request.id;
      if (request.method === 'status') return { id, ok: true, result: buildStatus() };
      if (request.method === 'stop') {
        const reason = request.reason ? `：${request.reason}` : '';
        // 先把回应写出去再退出
        setTimeout(() => shutdown('stopped', `收到 stop 请求${reason}`), 20);
        return { id, ok: true, result: { stopping: true } };
      }
      if (!backend) {
        await loaded;
        if (!backend) return { id, ok: false, code: 'model_load_failed', error: state.loadError ?? '模型还没加载完' };
      }
      const active = backend as ServiceBackend;
      if (request.method === 'embed') {
        const { texts, mode } = request.params;
        if (!validTexts(texts) || (mode !== 'query' && mode !== 'document')) {
          return { id, ok: false, code: 'bad_params', error: `embed 每次传 1~${MAX_TEXTS_PER_REQUEST} 条非空文本（每条 ≤ ${MAX_TEXT_CHARS} 字），mode 只能是 query 或 document` };
        }
        const vectors = await active.embed(texts, mode);
        return {
          id,
          ok: true,
          result: { vectors: vectors.map((vector) => Array.from(vector)), modelId: active.modelId, dimensions: active.dimensions },
        };
      }
      const { query, documents, topK } = request.params;
      if (
        !validText(query) ||
        !validTexts(documents) ||
        !Number.isInteger(topK) ||
        topK < 1 ||
        topK > MAX_TEXTS_PER_REQUEST
      ) {
        return { id, ok: false, code: 'bad_params', error: `rerank 需要 query、1~${MAX_TEXTS_PER_REQUEST} 条 documents 和 1~${MAX_TEXTS_PER_REQUEST} 的 topK` };
      }
      const hits = await active.rerank(query, documents, topK);
      return {
        id,
        ok: true,
        result: { hits: hits.slice(0, topK).map((hit) => ({ index: hit.index, score: clampScore(hit.score) })) },
      };
    };

    const dispatch = async (socket: Socket, request: Request): Promise<void> => {
      state.inFlight += 1;
      try {
        let response: Response;
        try {
          response = await execute(request);
        } catch (error) {
          response = { id: request.id, ok: false, code: 'backend_error', error: messageOf(error) };
        }
        safeWrite(socket, response);
      } finally {
        state.inFlight -= 1;
        state.requestsServed += 1;
        state.lastActivityAt = new Date().toISOString();
      }
    };

    server = createServer((socket) => {
      socket.setNoDelay(true);
      // 对端提前走了、写回失败都不许让进程挂掉：服务是全机共享的
      socket.on('error', () => {});
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.on('error', () => socket.destroy());
      lines.on('line', (line) => {
        if (line.trim() === '') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          safeWrite(socket, protocolError('bad_request', '请求不是 JSON'));
          return;
        }
        if (!isRequest(parsed)) {
          safeWrite(socket, protocolError('bad_request', '请求格式不对，只认 embed / rerank / status / stop'));
          return;
        }
        void dispatch(socket, parsed);
      });
    });
    server.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // 理论上到不了这里（残留已清、竞争者只有一个）；真发生了就以内核为准：有活着的服务就退出，绝不删 socket
        void probeSocket(paths.socketPath).then((probe) =>
          shutdown(probe === 'live' ? 'lost' : 'failed', `监听 ${paths.socketPath} 失败：路径已被占用（${probe}）`),
        );
        return;
      }
      shutdown('failed', `监听 socket 失败：${messageOf(error)}`);
    });
    server.listen(paths.socketPath, () => {
      socketIdentity = identityOf(paths.socketPath);
      try {
        chmodSync(paths.socketPath, 0o600);
      } catch {
        // 个别文件系统不支持改 socket 权限，目录本身已经是 0700
      }
      try {
        unlinkSync(paths.lastErrorPath);
      } catch {
        // 上次没有失败记录
      }
      log(`开始监听 ${paths.socketPath}（pid=${process.pid}，票号 ${mine.ticket}；完全闲置 ${Math.round(idleMs / 1000)} 秒后退出）`);
      void (async () => {
        await hooks.afterListen?.();
        // 监听成功后再确认一次没有票号更小的已发布竞争者，才开始加载模型（正在选票的后来者不算，它们的票号只会更大）
        const rival = contenders(paths.lockPath).some((other) => other.pid !== mine.pid && publishedPrecedes(other, mine));
        if (rival || state.stopping) {
          shutdown('lost', '监听后发现票号更小的竞争者，本进程不加载模型');
          return;
        }
        startLoad();
      })();
    });

    idleTimer = setInterval(() => {
      if (state.stopping || state.loading || state.inFlight > 0) return;
      const idleFor = Date.now() - Date.parse(state.lastActivityAt);
      if (idleFor >= idleMs) shutdown('idle', `完全闲置 ${Math.round(idleFor / 1000)} 秒且没有在途请求`);
    }, Math.min(1000, Math.max(100, Math.floor(idleMs / 4))));
    idleTimer.unref();
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
}

function safeWrite(socket: Socket, response: Response): void {
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(encodeLine(response), () => {});
    socket.resume();
  } catch {
    // 对端已经走了
  }
}
