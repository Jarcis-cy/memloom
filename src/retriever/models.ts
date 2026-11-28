/**
 * 统一的模型下载模块（返工方案 §3.2）：`memloom models download`、缺模型时的后台自动下载、旧脚本
 * `scripts/fetch-retriever-models.mjs` 都只走这一份逻辑，不留第二套。
 *
 * 安全边界（和旧脚本一致，只收紧不放松）：
 * - 仓库、revision、文件名全部固定在 models-manifest.ts，不接受任意地址、任意文件名；ONNX 没有有效 sha256 就拒绝；
 * - 大小和摘要的唯一真源是编译进代码的固定清单（来自官方源固定 revision 的元数据，并和本机已校验过的文件对过），
 *   镜像（MEMLOOM_HF_ENDPOINT / HF_ENDPOINT / --mirror）只负责传字节，摘要从不取自它的响应；
 * - 只接受 https://（离线测试明确给的 127.0.0.1 / localhost 回环地址可以 http://），跳转也逐跳检查，不许降级；
 * - 不带任何凭据、不传用户文本，只下载模型和分词器文件，不执行远端代码，不碰系统代理和全局设置；
 * - 写盘走 `<目标>.part` + HTTP Range 续传（206 要对得上区间，200 回退从头下），流写时也守 3 GiB 总量上限，
 *   大小和摘要全对才 rename 成正式文件；一个模型的文件全部就绪才最后原子写它的 memloom-model.json；
 * - 下载全程持有 `<模型目录>/.download.lock`（活锁不抢，拥有者已退出的残锁才清），状态写 `<状态目录>/model-download.json`，
 *   失败写中文原因和退避时间（默认 30 分钟；手动跑命令行不受退避限制，但不能绕过活锁）。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../core/process-alive.js';
import { inspectLocalModel, localModelsPresent, managedState, resolveLocalModelId, type ModelKind } from './modelid.js';
import { MODEL_KINDS, PINNED_MODELS, SMALL_FILES, type PinnedFile, type PinnedModel, type PinnedModels } from './models-manifest.js';
import { ensureStateDir, modelDownloadPaths, type ModelDownloadPaths } from './paths.js';
import { createFileLogger } from './service.js';

export const OFFICIAL_ENDPOINT = 'https://huggingface.co';
export const MAX_TOTAL_BYTES = 3 * 1024 ** 3;
/** 自动触发失败后的退避时长；手动 `memloom models download` 不受它限制 */
export const DEFAULT_RETRY_BACKOFF_MS = 30 * 60 * 1000;
const HEADERS_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const STATE_THROTTLE_MS = 1_000;
const USER_AGENT = 'memloom/0.1.0 (+https://github.com/Jarcis-cy/memloom)';

/** 编译后的命令行入口：后台下载就是 `node <这个> models download --state-dir … --out … --mirror …` */
export const DEFAULT_CLI_ENTRY = fileURLToPath(new URL('../cli/main.js', import.meta.url));

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : '';
    return causeMessage && causeMessage !== error.message ? `${error.message}（${causeMessage}）` : error.message;
  }
  return String(error);
}

/* ---------- 镜像源地址 ---------- */

const LOOPBACK_HOST = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i;

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOST.test(hostname);
}

/** 写进日志 / 报错 / 状态里的地址只留「协议 + 主机 + 路径」：跳转后的签名参数、查询串、账号密码一律不落盘。 */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0]?.replace(/\/\/[^/@]*@/, '//[凭据已隐去]@') ?? raw;
  }
}

/** 只接受 https://；明确给的回环地址（127.0.0.1 / localhost / ::1）允许 http://，给离线回环测试用。地址里不许带账号密码。 */
export function assertAllowedUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what}看不懂：「${safeUrl(raw)}」`);
  }
  if (url.username !== '' || url.password !== '') throw new Error(`${what}里不许带账号密码`);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  throw new Error(`${what}只接受 https://（离线测试可以用 http://127.0.0.1 或 http://localhost）：${url.origin}`);
}

/** 镜像源只写到主机名（和端口），不带路径、参数、片段。 */
export function normalizeEndpoint(raw: string): string {
  const url = assertAllowedUrl(raw.trim(), '镜像源地址');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error(`镜像源只写到主机名和端口，不要带路径、参数：${safeUrl(raw)}`);
  return url.origin;
}

/** 镜像优先级：命令行 --mirror > MEMLOOM_HF_ENDPOINT > HF_ENDPOINT > 官方地址。 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, cliMirror?: string): string {
  const raw = (cliMirror ?? '').trim() || (env.MEMLOOM_HF_ENDPOINT ?? '').trim() || (env.HF_ENDPOINT ?? '').trim() || OFFICIAL_ENDPOINT;
  return normalizeEndpoint(raw);
}

/** `MEMLOOM_AUTO_DOWNLOAD=0` 关闭自动下载；代码里的 autoDownload:false 在调用方判断。 */
export function autoDownloadFromEnv(env: NodeJS.ProcessEnv): boolean {
  return (env.MEMLOOM_AUTO_DOWNLOAD ?? '').trim() !== '0';
}

/* ---------- 固定清单（离线测试可以换一份小夹具，但只认回环地址） ---------- */

/**
 * 测试专用：MEMLOOM_TEST_MODEL_MANIFEST 指向一份和固定清单同结构的 JSON（小夹具的摘要）。
 * 只有镜像源是回环地址时才认它；对真实源永远只认编译进代码的固定清单，不给任何环境变量留后门。
 */
export function pinnedModelsFor(env: NodeJS.ProcessEnv, endpoint: string): PinnedModels {
  const raw = (env.MEMLOOM_TEST_MODEL_MANIFEST ?? '').trim();
  if (!raw) return PINNED_MODELS;
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    throw new Error('MEMLOOM_TEST_MODEL_MANIFEST 只能配合回环地址（http://127.0.0.1 / http://localhost）的镜像源做离线测试；对真实源只认编译进代码的固定清单');
  }
  const parsed = JSON.parse(readFileSync(raw, 'utf8')) as PinnedModels;
  for (const kind of MODEL_KINDS) {
    const model = parsed[kind];
    if (!model || typeof model.repo !== 'string' || typeof model.revision !== 'string' || !model.files || !Array.isArray(model.allowedFiles)) {
      throw new Error(`测试清单 ${raw} 里 ${kind} 的格式不对`);
    }
  }
  return parsed;
}

/* ---------- 独占锁：<模型目录>/.download.lock/（文件版面包店算法，和共享检索服务的 retriever.lock/ 同一思路） ----------
 *
 * 不在同一个路径上「建文件 / 删文件」：那样 open 和 write 之间会留下 0 字节草稿，别人读不出内容当残锁 unlink 掉，
 * 第一个进程仍持着已经被删掉的 inode，两边都以为拿到了；多个竞争者同时清同一个死锁时，后到的还能擦掉前者刚建好的活锁。
 * 这里每个竞争者只有以自己 pid 命名的 choosing.<pid> 和 ticket.<pid>：
 * - 内容先写进私有临时文件、写满 fsync 后再 link 到正式名字，别人要么看不到、要么看到完整内容；
 * - 先发布选择牌再取「当前最大票 + 1」，后来的竞争者不可能拿到比已发布在役者更小的票；
 * - 只有票号最小（同票比 pid）的活着的竞争者下载，其余的不下载直接退出；别人还在选票时短等有上限；
 * - 只删两种东西：自己的标记，和拥有者进程已经退出（僵尸感知判活 + 入口脚本名核对）的唯一命名文件，
 *   活着的、没写完的都不是残锁，永远不会被别人删掉。
 * 旧实现留下的 .download.lock 普通文件只可能是没发布完的草稿或已退出进程的残留：持有者还活着就当它持有（不抢），
 * 否则 unlink 掉再建目录——unlink 对目录必然失败，所以不可能误删别人刚建好的锁目录；符号链接一律不动、直接拒绝。
 */

const LOCK_DIR = '.download.lock';
const TICKET_NAME = /^ticket\.(\d+)$/;
const CHOOSING_NAME = /^choosing\.(\d+)$/;
/** 等别人把票选完的上限：超过它就当这次抢不到，不下载 */
const CONTENDER_WAIT_MS = 5_000;
/**
 * 本进程对同一个模型目录的入场记录，键是模型目录的规范文件系统路径（先 mkdir 保证存在，再 realpath）：
 * campaigning = 这一次抢锁正在竞选（可能正在 await 钩子），held = 已持有。同目录后来的请求只拿 busy / held，
 * 不动第一次的选择牌和票。令牌保证只有拥有者能清自己的记录：重复调用旧 release 清不掉后来的新主人。
 */
interface ProcessEntry {
  token: string;
  state: 'campaigning' | 'held';
  lock?: DownloadLock;
}
const ENTERED_BY_THIS_PROCESS = new Map<string, ProcessEntry>();

export interface DownloadLock {
  /** 票号，越小越优先 */
  ticket: number;
  pid: number;
  startedAt: string;
  /** 本进程持有锁时记在内存里的随机令牌：同一个进程再抢时凭它认出「是我自己持着」，不当成别人的死票清掉 */
  token?: string;
  /** 写锁的进程入口脚本名（例如 main.js），用来辨认拥有者是不是 memloom 的下载进程 */
  entry: string;
  modelDir: string;
}

export type DownloadAcquire =
  | { kind: 'acquired'; mine: DownloadLock; release: () => void }
  | { kind: 'held'; holder: DownloadLock }
  | { kind: 'busy'; note: string };

/** 仅测试用：在竞选的两个窗口里暂停，让双进程竞态按剧本发生 */
export interface DownloadLockHooks {
  /** 选择牌发布之后、取票之前 */
  afterMarker?: () => Promise<void> | void;
  /** 票发布之后、扫描竞争者之前 */
  afterTicket?: () => Promise<void> | void;
}


function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 这个 pid 是不是写锁的那个下载进程：看 /proc/<pid>/cmdline 里有没有它记下的入口脚本名；没有 /proc 或读不到时宁可当它是（绝不动它）。 */
function looksLikeDownloader(pid: number, entry: string | undefined): boolean {
  const needle = basename(entry ?? '');
  if (needle === '') return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle);
  } catch {
    return true;
  }
}

function isLiveOwner(pid: number, entry: string | undefined): boolean {
  return isProcessAlive(pid) && looksLikeDownloader(pid, entry);
}

function lockDir(modelDir: string): string {
  return join(modelDir, LOCK_DIR);
}

function listLockPids(dir: string): { tickets: number[]; choosing: number[] } {
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

function readLockFile(path: string): DownloadLock | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && typeof (parsed as { pid?: unknown }).pid === 'number' ? (parsed as DownloadLock) : null;
  } catch {
    return null;
  }
}

interface Contender {
  pid: number;
  /** 还在选票（选择牌还在） */
  choosing: boolean;
  /** 读得出的票；读不出当 null（按「更优先」处理，宁可等不抢） */
  info: DownloadLock | null;
}

/** 此刻活着的竞争者（拥有者已经退出的不算，留给 gcStale 清）。 */
function contenders(dir: string): Contender[] {
  const { tickets, choosing } = listLockPids(dir);
  const out: Contender[] = [];
  for (const pid of new Set([...tickets, ...choosing])) {
    const hasTicket = tickets.includes(pid);
    const info = hasTicket ? readLockFile(join(dir, `ticket.${pid}`)) : readLockFile(join(dir, `choosing.${pid}`));
    // 票 / 选择牌是 link 发布的，要么没有要么完整；读不出内容就当它还在选，按活着处理（绝不删）
    if (info ? !isLiveOwner(pid, info.entry) : false) continue;
    out.push({ pid, choosing: choosing.includes(pid) || !hasTicket, info: hasTicket ? info : null });
  }
  return out;
}

/**
 * 只清「拥有者进程已经死了」或「pid 被别的程序复用」的票和选择牌。
 * 文件名带着拥有者身份，这个判断只会从「可清」变成「不可清」，活着的下载进程永远不会被误删。
 */
function gcStale(dir: string): void {
  const { tickets, choosing } = listLockPids(dir);
  for (const pid of new Set([...tickets, ...choosing])) {
    const info = tickets.includes(pid) ? readLockFile(join(dir, `ticket.${pid}`)) : readLockFile(join(dir, `choosing.${pid}`));
    if (!info || isLiveOwner(pid, info.entry)) continue;
    for (const name of [`ticket.${pid}`, `choosing.${pid}`]) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // 已经被别人清了
      }
    }
  }
}

function removeOwnEntries(dir: string): void {
  for (const name of [`ticket.${process.pid}`, `choosing.${process.pid}`]) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // 本来就没有
    }
  }
}

/** 票 / 选择牌的正文先写进私有临时文件、写满 fsync，再 link 到正式名字：要么完整要么不存在，没有「0 字节草稿」窗口。 */
function publishLockFile(dir: string, name: string, content: DownloadLock): void {
  const path = join(dir, name);
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(content));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temp, path);
    } catch (error) {
      // 只有同一个 pid 的旧标记（pid 复用）才会撞名，上面已经清过；真撞上就当已发布
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

/** 当前最大票号 + 1（活着的和已死但还没清的票都算，票号只增不减）。 */
function nextTicketNumber(dir: string): number {
  let max = 0;
  for (const pid of listLockPids(dir).tickets) {
    const info = readLockFile(join(dir, `ticket.${pid}`));
    if (info) max = Math.max(max, info.ticket);
  }
  return max + 1;
}

/** 已发布的票之间：票号小者优先，同票 pid 小者优先。 */
function publishedPrecedes(other: Contender, mine: DownloadLock): boolean {
  if (!other.info) return false;
  return other.info.ticket < mine.ticket || (other.info.ticket === mine.ticket && other.pid < mine.pid);
}

/**
 * 保证 .download.lock 是我们自己的私有目录。撞上旧实现留下的普通文件：持有者还活着就把它当持有者返回（不抢）；
 * 否则 unlink 再建目录。符号链接直接拒绝、不动。
 */
function ensureLockDir(modelDir: string): DownloadLock | null {
  const dir = lockDir(modelDir);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      return null;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    let stats;
    try {
      stats = lstatSync(dir);
    } catch {
      continue; // 刚被别人删了，再建一次
    }
    if (stats.isDirectory()) return null;
    if (stats.isSymbolicLink()) throw new Error(`下载锁路径 ${dir} 是符号链接，拒绝使用；请确认它不是别的程序在用后手动删除`);
    const legacy = readLockFile(dir);
    if (legacy && isLiveOwner(legacy.pid, legacy.entry)) return { ...legacy, ticket: 0 };
    try {
      unlinkSync(dir); // 对目录会 EISDIR 失败：不可能误删别人刚建好的锁目录
    } catch (unlinkError) {
      if (!isErrno(unlinkError, 'ENOENT')) {
        // 不是「已经没了」：多半是别人刚把它换成了目录，下一轮 lstat 会认出来
        if (!isErrno(unlinkError, 'EISDIR') && !isErrno(unlinkError, 'EPERM') && !isErrno(unlinkError, 'EACCES')) throw unlinkError;
      }
    }
  }
  throw new Error(`下载锁目录 ${dir} 反复被占用，这次不下载`);
}

/**
 * 抢锁：清死票 → 发布选择牌 → 取最大票 + 1 → 发布票 → 撤选择牌 → 等所有还在选票的竞争者选完，
 * 有票号更小的活着的竞争者就退出不下载；等超过上限当这次抢不到。拿到锁返回 release，调用方必须在 finally 里释放。
 */
export async function acquireDownloadLock(modelDir: string, hooks: DownloadLockHooks = {}): Promise<DownloadAcquire> {
  mkdirSync(modelDir, { recursive: true, mode: 0o700 });
  // 同进程互斥：在第一次可让出（await 钩子）之前就按规范路径占住入场。不然同一个进程里两个并发请求会互相把对方
  // （同 pid）的选择牌 / 票当成自己的旧文件清掉，两边都在「排除自己 pid」的扫描里看不到对方，双双进临界区
  const canonical = canonicalDir(modelDir);
  const entered = ENTERED_BY_THIS_PROCESS.get(canonical);
  if (entered) {
    if (entered.state === 'held' && entered.lock) return { kind: 'held', holder: entered.lock };
    return { kind: 'busy', note: `本进程对模型目录「${canonical}」的另一次抢锁还在竞选，这次不重复抢` };
  }
  const entry: ProcessEntry = { token: randomUUID(), state: 'campaigning' };
  ENTERED_BY_THIS_PROCESS.set(canonical, entry);
  try {
    return await campaign(canonical, entry, hooks);
  } finally {
    // 只有还没拿到锁（竞选失败 / 让给别人 / 抛错）才在这里退场；拿到的由 release 按令牌退场
    if (entry.state === 'campaigning' && ENTERED_BY_THIS_PROCESS.get(canonical) === entry) ENTERED_BY_THIS_PROCESS.delete(canonical);
  }
}

/** 规范路径：符号链接、./、尾斜杠都归一；realpath 失败就退回 resolve */
function canonicalDir(modelDir: string): string {
  try {
    return realpathSync(modelDir);
  } catch {
    return resolve(modelDir);
  }
}

async function campaign(canonical: string, entry: ProcessEntry, hooks: DownloadLockHooks): Promise<DownloadAcquire> {
  const legacy = ensureLockDir(canonical);
  if (legacy) return { kind: 'held', holder: legacy };
  const dir = lockDir(canonical);
  gcStale(dir);
  removeOwnEntries(dir);
  const me = process.pid;
  const mine: DownloadLock = { ticket: 0, pid: me, startedAt: new Date().toISOString(), entry: process.argv[1] ?? '', modelDir: canonical, token: entry.token };
  publishLockFile(dir, `choosing.${me}`, mine);
  await hooks.afterMarker?.();
  mine.ticket = nextTicketNumber(dir);
  publishLockFile(dir, `ticket.${me}`, mine);
  try {
    unlinkSync(join(dir, `choosing.${me}`));
  } catch {
    // 选择牌已经不在
  }
  await hooks.afterTicket?.();
  const deadline = Date.now() + CONTENDER_WAIT_MS;
  for (;;) {
    const rivals = contenders(dir).filter((other) => other.pid !== me);
    const stillChoosing = rivals.filter((other) => other.choosing || !other.info);
    if (stillChoosing.length === 0) {
      const better = rivals.filter((other) => publishedPrecedes(other, mine)).sort((a, b) => (a.info as DownloadLock).ticket - (b.info as DownloadLock).ticket || a.pid - b.pid)[0];
      if (!better) {
        entry.state = 'held';
        entry.lock = mine;
        return {
          kind: 'acquired',
          mine,
          release: () => {
            // 只有记录还是自己的才清：旧 release 重复调用不会清掉后来的新主人
            if (ENTERED_BY_THIS_PROCESS.get(canonical) !== entry) return;
            ENTERED_BY_THIS_PROCESS.delete(canonical);
            removeOwnEntries(dir);
          },
        };
      }
      removeOwnEntries(dir);
      return { kind: 'held', holder: (better as Contender).info as DownloadLock };
    }
    if (Date.now() > deadline) {
      removeOwnEntries(dir);
      return { kind: 'busy', note: `锁目录里有进程还在竞选（pid=${stillChoosing.map((other) => other.pid).join('、')}）超过 ${CONTENDER_WAIT_MS} 毫秒没出结果，这次不下载` };
    }
    await sleep(40);
  }
}

/** 此刻有没有活着的下载进程持有这个模型目录的锁（票号最小的那个）；没有、持有者已退出、或旧普通文件的拥有者已退出，都算没有。只读，不清理。 */
export function readDownloadLock(modelDir: string): DownloadLock | null {
  const dir = lockDir(modelDir);
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) {
    const legacy = readLockFile(dir);
    return legacy && isLiveOwner(legacy.pid, legacy.entry) ? { ...legacy, ticket: 0 } : null;
  }
  const live = contenders(dir).filter((other) => other.info && !other.choosing);
  if (live.length === 0) return null;
  live.sort((a, b) => (a.info as DownloadLock).ticket - (b.info as DownloadLock).ticket || a.pid - b.pid);
  return (live[0] as Contender).info;
}

/* ---------- 状态文件：<状态目录>/model-download.json ---------- */

export interface DownloadStateRecord {
  state: 'downloading' | 'ready' | 'failed';
  pid: number;
  endpoint: string;
  currentFile: string | null;
  downloadedBytes: number;
  totalBytes: number;
  updatedAt: string;
  error: string | null;
  retryAfter: string | null;
  /** 这份记录属于哪个模型目录；换了目录的旧状态不冒认 */
  modelDir: string;
  stateDir: string;
}

export function readDownloadState(stateDir: string): DownloadStateRecord | null {
  const path = join(stateDir, 'model-download.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DownloadStateRecord>;
    if (!parsed || (parsed.state !== 'downloading' && parsed.state !== 'ready' && parsed.state !== 'failed')) return null;
    return parsed as DownloadStateRecord;
  } catch {
    return null;
  }
}

/** 状态写入是节流的（默认 1 秒一次）；文件变化、成功、失败这些转折点强制写。 */
class StateWriter {
  private lastWriteAt = 0;

  constructor(
    private readonly paths: ModelDownloadPaths,
    readonly record: DownloadStateRecord,
  ) {}

  update(patch: Partial<DownloadStateRecord>, force = false): void {
    Object.assign(this.record, patch);
    const now = Date.now();
    if (!force && now - this.lastWriteAt < STATE_THROTTLE_MS) return;
    this.lastWriteAt = now;
    this.record.updatedAt = new Date(now).toISOString();
    const tmp = `${this.paths.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.paths.statePath);
  }
}

/* ---------- 计划 ---------- */

export interface PlannedFile {
  model: ModelKind;
  /** 相对模型子目录的路径，例如 onnx/model_int8.onnx */
  path: string;
  target: string;
  part: string;
  bytes: number;
  sha256: string | null;
  gitSha1: string | null;
}

export interface PlannedModel {
  kind: ModelKind;
  repo: string;
  revision: string;
  file: string;
  dir: string;
  files: PlannedFile[];
}

export interface DownloadPlan {
  endpoint: string;
  models: Record<ModelKind, PlannedModel>;
  files: PlannedFile[];
  totalBytes: number;
}

/** 按固定清单排出要落的文件：量化文件名只认允许列表，清单里没有的或没有有效 sha256 的 ONNX 直接拒绝。 */
export function planModelDownload(args: { modelDir: string; endpoint: string; embedding?: string; reranker?: string; pinned?: PinnedModels | null }): DownloadPlan {
  const pinned = args.pinned ?? PINNED_MODELS;
  const models = {} as Record<ModelKind, PlannedModel>;
  for (const kind of MODEL_KINDS) {
    const source: PinnedModel = pinned[kind];
    const requested = (kind === 'embedding' ? args.embedding : args.reranker) ?? source.defaultFile;
    if (!source.allowedFiles.includes(requested)) {
      throw new Error(`${kind} 只支持这些文件：${source.allowedFiles.join('、')}，收到的是「${requested}」`);
    }
    const file = `onnx/${requested}`;
    const dir = join(args.modelDir, kind);
    const files = [...SMALL_FILES, file].map((path) => {
      const meta: PinnedFile | undefined = source.files[path];
      if (!meta) throw new Error(`固定清单里没有 ${source.repo}@${source.revision.slice(0, 7)} 的 ${path}，拒绝下载`);
      if (path.startsWith('onnx/') && !/^[0-9a-f]{64}$/.test(meta.sha256 ?? '')) throw new Error(`${path} 没有有效的 sha256，拒绝下载不认识的 ONNX 文件`);
      const target = join(dir, path);
      return { model: kind, path, target, part: `${target}.part`, bytes: meta.bytes, sha256: meta.sha256 ?? null, gitSha1: meta.gitSha1 ?? null };
    });
    models[kind] = { kind, repo: source.repo, revision: source.revision, file, dir, files };
  }
  const files = [...models.embedding.files, ...models.reranker.files];
  return { endpoint: args.endpoint, models, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/* ---------- 校验 ---------- */

/** 大小对得上，且固定清单给的摘要（sha256 或 git blob sha1）也对得上，才算过。 */
async function verifyFile(path: string, file: PlannedFile): Promise<boolean> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size !== file.bytes) return false;
  if (!file.sha256 && !file.gitSha1) return true;
  const sha256 = file.sha256 ? createHash('sha256') : null;
  const gitSha1 = file.gitSha1 ? createHash('sha1').update(`blob ${size}\0`) : null;
  for await (const chunk of createReadStream(path)) {
    sha256?.update(chunk);
    gitSha1?.update(chunk);
  }
  if (sha256 && sha256.digest('hex') !== file.sha256) return false;
  if (gitSha1 && gitSha1.digest('hex') !== file.gitSha1) return false;
  return true;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) offset += writeSync(fd, chunk, offset, chunk.byteLength - offset);
}

/* ---------- 下载 ---------- */

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i;

interface FetchContext {
  fetchImpl: typeof fetch;
  headersTimeoutMs: number;
  stallMs: number;
}

/** 手动跟跳转：每一跳都过同一个地址检查，https 不许降到 http（回环地址除外），最多 5 跳。 */
async function fetchFollowingRedirects(url: string, headers: Record<string, string>, context: FetchContext): Promise<{ response: Response; finalUrl: string; controller: AbortController }> {
  let current = assertAllowedUrl(url, '下载地址').toString();
  for (let hop = 0; ; hop += 1) {
    // 回应头有上限；拿到头之后这个控制器交给正文阶段继续用（空闲上限）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`等 ${safeUrl(current)} 回应头超过 ${context.headersTimeoutMs} 毫秒`)), context.headersTimeoutMs);
    let response: Response;
    try {
      response = await context.fetchImpl(current, { headers, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      throw new Error(`连不上下载源 ${safeUrl(current)}：${messageOf(error)}`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`下载地址 ${safeUrl(current)} 跳转但没有给新地址`);
      if (hop >= MAX_REDIRECTS) throw new Error(`下载地址跳转超过 ${MAX_REDIRECTS} 次，停止：${safeUrl(current)}`);
      current = assertAllowedUrl(new URL(location, current).toString(), '跳转后的下载地址').toString();
      continue;
    }
    return { response, finalUrl: current, controller };
  }
}

interface DownloadContext extends FetchContext {
  plan: DownloadPlan;
  state: StateWriter;
  /** 已经落定的字节（本来就在且校验通过的 + 这次下完的），进度 = 它 + 当前文件已写的 */
  settledBytes: number;
  /**
   * 这次从网上实际收到的全部字节，只增不减：成功的、中途断掉的、坏摘要重下的、服务端不认 Range 重发的都算。
   * 3 GiB 硬上限看的就是它，不再只数成功的那些。
   */
  received: number;
  maxTotalBytes: number;
  log: (line: string) => void;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  model: ModelKind;
  path: string;
  /** 这个文件已经落盘的字节（含续传前已有的） */
  fileBytes: number;
  fileTotal: number;
  downloadedBytes: number;
  totalBytes: number;
  /** present = 本来就在且校验通过；downloaded = 这次从头下的；resumed = 从 .part 续传完成的 */
  done: 'present' | 'downloaded' | 'resumed' | null;
}

/** 不该重试的失败：超过硬上限、服务端给的字节比固定清单多、续传范围对不上。重下只会再收一遍同样的字节。 */
class DownloadFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadFatalError';
  }
}

/** 下载中途断了：已收的字节留在 .part 里，标成 partial 让 ensureFile 紧接着带 Range 续传 */
function interrupted(file: PlannedFile, reason: string, written: number, expected: number): Error {
  return new Error(`下载 ${file.model}/${file.path} 中断：${reason}；已收 ${written} / ${expected} 字节`, { cause: written > 0 ? 'partial' : undefined });
}

/** 下一个文件（或续传它的 .part）；返回这次实际是续传还是从头下、实际收了多少字节。校验不在这里做。 */
async function downloadOnce(file: PlannedFile, context: DownloadContext, url: string): Promise<{ status: 'downloaded' | 'resumed'; received: number }> {
  const partSize = existsSync(file.part) ? statSync(file.part).size : -1;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  if (partSize > 0) headers.range = `bytes=${partSize}-`;
  const { response, controller } = await fetchFollowingRedirects(url, headers, context);
  let append = false;
  let resumed = false;
  if (response.status === 206) {
    const match = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '');
    const start = match ? Number(match[1]) : NaN;
    const end = match ? Number(match[2]) : NaN;
    const total = match ? Number(match[3]) : NaN;
    // 合法的续传：起点 = 本地已有的字节数，结束位置和总长都等于固定清单里的文件大小（总长是 * 时不认）
    if (partSize <= 0 || !match || start !== partSize || end + 1 !== file.bytes || !(match[3] === '*' || total === file.bytes)) {
      await response.body?.cancel();
      throw new DownloadFatalError(`${file.model}/${file.path} 的续传范围对不上（本地已有 ${partSize} 字节，服务端回 ${response.headers.get('content-range')}，固定清单 ${file.bytes} 字节），拒绝拼接`);
    }
    append = true;
    resumed = true;
  } else if (response.status === 200) {
    if (partSize > 0) context.log(`${file.model}/${file.path}：服务端不支持续传（回了 200 全量），从头重下；已有的 ${partSize} 字节会再收一遍，计入总量`);
  } else {
    await response.body?.cancel();
    throw new Error(`下载失败：HTTP ${response.status} ${safeUrl(url)}`);
  }
  const expected = file.bytes - (append ? partSize : 0);
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.has('content-length') && Number.isFinite(declared) && declared !== expected) {
    await response.body?.cancel();
    throw new DownloadFatalError(`${file.model}/${file.path} 长度不对：服务端声明 ${declared} 字节，固定清单要求 ${expected} 字节`);
  }
  if (!response.body) throw new Error(`下载 ${safeUrl(url)} 的回应没有正文`);

  mkdirSync(dirname(file.part), { recursive: true, mode: 0o700 });
  const fd = openSync(file.part, append ? 'a' : 'w', 0o600);
  const base = context.settledBytes + (append ? partSize : 0);
  let written = 0;
  // 正文阶段：超过空闲上限没有新字节就中止（回应头的上限在 fetch 里已经解除）
  let stall: NodeJS.Timeout | undefined;
  const resetStall = (): void => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => controller.abort(new Error(`超过 ${context.stallMs} 毫秒没有收到新字节`)), context.stallMs);
  };
  try {
    resetStall();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      // 先计数、再判上限、最后才落盘：到上限的那一块不写，所以写进 .part 的字节不会超过上限
      context.received += chunk.byteLength;
      written += chunk.byteLength;
      if (written > expected) throw new DownloadFatalError(`${file.model}/${file.path} 服务端给的字节比固定清单多（已收 ${written}，只该有 ${expected}），拒绝`);
      if (context.received > context.maxTotalBytes) {
        throw new DownloadFatalError(
          `总下载量超过上限（已收 ${context.received} 字节 > ${context.maxTotalBytes}），停止，不再重试；已落盘的字节不超过上限，网络缓冲里在途的几个字节只计数不落盘`,
        );
      }
      writeAll(fd, chunk);
      resetStall();
      context.state.update({ currentFile: `${file.model}/${file.path}`, downloadedBytes: base + written });
      context.onProgress?.({ model: file.model, path: file.path, fileBytes: partSize + written, fileTotal: file.bytes, downloadedBytes: base + written, totalBytes: context.plan.totalBytes, done: null });
    }
  } catch (error) {
    // 已经写进 .part 的字节都是文件开头的一段，留着用 Range 续传；只有校验不过才会删它（在 ensureFile 里）。
    // 致命错误（超上限、字节过多）原样抛出，不标成 partial，不再重试；收过的字节不回滚
    if (error instanceof DownloadFatalError) throw error;
    const reason = controller.signal.aborted ? String(controller.signal.reason?.message ?? messageOf(controller.signal.reason)) : messageOf(error);
    throw interrupted(file, reason, written, expected);
  } finally {
    if (stall) clearTimeout(stall);
    closeSync(fd);
  }
  if (written !== expected) throw interrupted(file, `连接提前断开`, written, expected);
  return { status: resumed ? 'resumed' : 'downloaded', received: written };
}

/** 一个文件：已有且校验通过就跳过；否则续传 / 重下，大小和摘要全对才 rename 成正式文件；校验不过删掉重下一次。 */
async function ensureFile(file: PlannedFile, context: DownloadContext): Promise<{ status: 'present' | 'downloaded' | 'resumed'; received: number }> {
  const model = context.plan.models[file.model];
  const url = `${context.plan.endpoint}/${model.repo}/resolve/${model.revision}/${file.path}`;
  mkdirSync(dirname(file.target), { recursive: true, mode: 0o700 });
  if (existsSync(file.target)) {
    if (await verifyFile(file.target, file)) {
      context.log(`已有且校验通过：${file.model}/${file.path}`);
      context.onProgress?.({ model: file.model, path: file.path, fileBytes: file.bytes, fileTotal: file.bytes, downloadedBytes: context.settledBytes, totalBytes: context.plan.totalBytes, done: 'present' });
      return { status: 'present', received: 0 };
    }
    context.log(`已有文件大小或摘要对不上，重新下载：${file.model}/${file.path}`);
    rmSync(file.target, { force: true });
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (existsSync(file.part)) {
      const size = statSync(file.part).size;
      if (size > file.bytes || (size === file.bytes && !(await verifyFile(file.part, file)))) rmSync(file.part, { force: true });
      else if (size === file.bytes) {
        renameSync(file.part, file.target);
        context.onProgress?.({ model: file.model, path: file.path, fileBytes: file.bytes, fileTotal: file.bytes, downloadedBytes: context.settledBytes + file.bytes, totalBytes: context.plan.totalBytes, done: 'resumed' });
        context.log(`上次下完但没来得及校验的 .part 校验通过：${file.model}/${file.path}`);
        return { status: 'resumed', received: 0 };
      }
    }
    try {
      const { status, received } = await downloadOnce(file, context, url);
      if (!(await verifyFile(file.part, file))) {
        rmSync(file.part, { force: true });
        if (attempt < 2) {
          context.log(`大小或摘要对不上，删掉重下一次：${file.model}/${file.path}`);
          continue;
        }
        throw new DownloadFatalError(`${file.model}/${file.path} 重下后大小或摘要仍对不上：镜像给的文件可能损坏或被篡改，换官方源或别的镜像再试`);
      }
      renameSync(file.part, file.target);
      context.onProgress?.({ model: file.model, path: file.path, fileBytes: file.bytes, fileTotal: file.bytes, downloadedBytes: context.settledBytes + file.bytes, totalBytes: context.plan.totalBytes, done: status });
      context.log(`校验通过：${file.model}/${file.path}（${(file.bytes / 1024 ** 2).toFixed(1)} MiB${status === 'resumed' ? '，续传完成' : ''}）`);
      return { status, received };
    } catch (error) {
      // 已经落了一部分字节的中断：紧接着带着 Range 再试一次（最多三次）；超过上限这类致命错误直接抛，不重试
      if ((error as { cause?: unknown }).cause === 'partial' && attempt < 2 && existsSync(file.part)) continue;
      throw error;
    }
  }
  throw new Error(`${file.model}/${file.path} 没能下载成功`);
}

interface ModelManifestLike {
  repo: string;
  revision: string;
  file: string;
  endpoint: string;
  fetchedAt: string;
  files: Record<string, { bytes: number; sha256: string | null; gitSha1: string | null }>;
}

function writeModelManifest(model: PlannedModel, endpoint: string, now: () => string): ModelManifestLike {
  const manifest: ModelManifestLike = {
    repo: model.repo,
    revision: model.revision,
    file: model.file,
    endpoint,
    fetchedAt: now(),
    files: Object.fromEntries(model.files.map((file) => [file.path, { bytes: file.bytes, sha256: file.sha256, gitSha1: file.gitSha1 }])),
  };
  // 这个模型的每个文件都已落盘并校验过，才写它；算 modelId 靠的是它
  atomicWrite(join(model.dir, 'memloom-model.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * 模型目录自身的发布门槛（根 manifest.json）：
 * - 写任何目标文件之前先原子写 state=downloading——这一刻起，不管文件看起来多齐，modelid.ts 都不把它当「就绪」，不会切过去；
 * - 两个模型的文件全部校验通过后才各写自己的 memloom-model.json（modelId 从它算）；
 * - 最后原子发布 state=ready；此时两个 per-model 清单都在，算出来的 modelId 一定带 revision，不会把 @unknown 缓存进检索客户端。
 * 目录本来就完整（手工摆好的）时不写这道门，只补清单。
 */
function writeRootManifest(modelDir: string, content: Record<string, unknown>): void {
  atomicWrite(join(modelDir, 'manifest.json'), `${JSON.stringify(content, null, 2)}\n`);
}

/** 仅测试用：在下载的关键窗口里暂停，让竞态按剧本发生 */
export interface DownloadHooks {
  lock?: DownloadLockHooks;
  /** 某个模型的文件全部就绪之后、写它的 memloom-model.json 之前 */
  beforeModelManifest?: (kind: ModelKind) => Promise<void> | void;
  /** 两个模型都就绪之后、原子发布整对 ready 之前 */
  beforePublish?: () => Promise<void> | void;
}

export interface DownloadRunOptions {
  stateDir: string;
  modelDir: string;
  /** 已经按优先级选好的镜像源（官方地址也是一个「镜像」） */
  endpoint: string;
  embedding?: string;
  reranker?: string;
  env?: NodeJS.ProcessEnv;
  /** 仅测试：进程内直接换一份小夹具清单 */
  pinned?: PinnedModels | null;
  fetchImpl?: typeof fetch;
  retryBackoffMs?: number;
  headersTimeoutMs?: number;
  stallMs?: number;
  /** 仅测试：把 3 GiB 硬上限换成很小的数，证明累计计数真的会停 */
  maxTotalBytes?: number;
  hooks?: DownloadHooks;
  onProgress?: (progress: DownloadProgress) => void;
  /** 每个文件完成、失败原因等一行一句的中文说明（命令行前台拿它打印，后台只进日志文件） */
  onLine?: (line: string) => void;
}

export interface DownloadResult {
  ok: true;
  modelDir: string;
  stateDir: string;
  endpoint: string;
  /** 本来就在且校验通过的字节数 */
  alreadyPresent: number;
  /** 这次实际从网上收的字节（含中途断掉的、坏摘要重下的、服务端不认 Range 重发的） */
  downloadedBytes: number;
  files: Array<{ model: ModelKind; path: string; bytes: number; status: 'present' | 'downloaded' | 'resumed' }>;
  modelId: string | null;
}

/**
 * 跑一次完整下载：抢锁 → 写 downloading 状态 → （目录不完整时）原子标记托管未就绪 → 逐个文件续传 / 校验 / 原子落盘
 * → 每个模型最后写 memloom-model.json → 原子发布整对 ready。
 * 任何一步失败都写 failed + 中文原因 + 退避时间再抛出；锁在 finally 里一定释放。
 */
export async function runModelDownload(options: DownloadRunOptions): Promise<DownloadResult> {
  const env = options.env ?? process.env;
  const endpoint = normalizeEndpoint(options.endpoint);
  const pinned = options.pinned === undefined ? pinnedModelsFor(env, endpoint) : options.pinned ?? PINNED_MODELS;
  const plan = planModelDownload({ modelDir: options.modelDir, endpoint, embedding: options.embedding, reranker: options.reranker, pinned });
  const paths = modelDownloadPaths(options.modelDir, options.stateDir);
  ensureStateDir(paths.stateDir);
  mkdirSync(paths.modelDir, { recursive: true, mode: 0o700 });
  const fileLog = createFileLogger(paths.logPath);
  const log = (line: string): void => {
    fileLog(line);
    options.onLine?.(line);
  };
  const now = (): string => new Date().toISOString();

  const acquired = await acquireDownloadLock(paths.modelDir, options.hooks?.lock);
  if (acquired.kind !== 'acquired') {
    throw new Error(
      acquired.kind === 'held'
        ? `另一个下载进程（pid=${acquired.holder.pid}）正在往同一个模型目录下载，不抢；进度看 memloom models status`
        : acquired.note,
    );
  }
  const { release } = acquired;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  let state: StateWriter | undefined;
  try {
    let present = 0;
    for (const file of plan.files) {
      if (existsSync(file.target) && (await verifyFile(file.target, file))) present += file.bytes;
    }
    const need = plan.totalBytes - present;
    if (need > maxTotalBytes) throw new DownloadFatalError(`这次要下载 ${(need / 1024 ** 3).toFixed(2)} GiB，超过 ${(maxTotalBytes / 1024 ** 3).toFixed(2)} GiB 上限，停止`);
    state = new StateWriter(paths, {
      state: 'downloading',
      pid: process.pid,
      endpoint,
      currentFile: plan.files[0] ? `${plan.files[0].model}/${plan.files[0].path}` : null,
      downloadedBytes: present,
      totalBytes: plan.totalBytes,
      updatedAt: now(),
      error: null,
      retryAfter: null,
      modelDir: paths.modelDir,
      stateDir: paths.stateDir,
    });
    state.update({}, true);
    log(`开始下载：${endpoint}；固定清单共 ${(plan.totalBytes / 1024 ** 2).toFixed(0)} MiB，已有 ${(present / 1024 ** 2).toFixed(0)} MiB，这次要下 ${(need / 1024 ** 2).toFixed(0)} MiB`);
    // 目录本来就不完整：写任何目标文件之前先关上发布门槛（同一个模型目录被别的状态目录看到时也不会早熟）
    if (!localModelsPresent(paths.modelDir)) writeRootManifest(paths.modelDir, { state: 'downloading', startedAt: now(), pid: process.pid, endpoint });

    const context: DownloadContext = {
      fetchImpl: options.fetchImpl ?? fetch,
      headersTimeoutMs: options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      stallMs: options.stallMs ?? STALL_TIMEOUT_MS,
      plan,
      state,
      settledBytes: present,
      received: 0,
      maxTotalBytes,
      log,
      onProgress: options.onProgress,
    };
    const result: DownloadResult = { ok: true, modelDir: paths.modelDir, stateDir: paths.stateDir, endpoint, alreadyPresent: present, downloadedBytes: 0, files: [], modelId: null };
    const manifests = {} as Record<ModelKind, ModelManifestLike>;
    for (const kind of MODEL_KINDS) {
      const model = plan.models[kind];
      for (const file of model.files) {
        const { status } = await ensureFile(file, context);
        result.files.push({ model: kind, path: file.path, bytes: file.bytes, status });
        // 本来就在的字节开头已经算进 settledBytes 了，只给这次下完的加，进度不重复计
        if (status !== 'present') context.settledBytes += file.bytes;
        context.state.update({ currentFile: `${kind}/${file.path}`, downloadedBytes: context.settledBytes }, true);
      }
      await options.hooks?.beforeModelManifest?.(kind);
      manifests[kind] = writeModelManifest(model, endpoint, now);
      log(`${kind} 的文件全部就绪并校验通过（${model.repo}@${model.revision.slice(0, 7)}，${model.file}）`);
    }
    await options.hooks?.beforePublish?.();
    writeRootManifest(paths.modelDir, { state: 'ready', fetched_at: now(), endpoint, models: manifests });
    result.downloadedBytes = context.received;
    result.modelId = resolveLocalModelId(paths.modelDir);
    state.update({ state: 'ready', currentFile: null, downloadedBytes: plan.totalBytes, error: null, retryAfter: null }, true);
    log(`两个模型都已就绪：${paths.modelDir}（当前 modelId ${result.modelId ?? '算不出'}；这次实际收到 ${(context.received / 1024 ** 2).toFixed(1)} MiB）`);
    return result;
  } catch (error) {
    const message = messageOf(error);
    const retryAfter = new Date(Date.now() + backoffMs).toISOString();
    state?.update({ state: 'failed', error: message, retryAfter }, true);
    log(`下载失败：${message}；${retryAfter} 之前不再自动重试，手动 memloom models download 不受这个限制`);
    throw error instanceof Error ? error : new Error(message);
  } finally {
    release();
  }
}

/* ---------- 后台拉起 ---------- */

/** 脱离父进程拉起 `memloom models download`：detach + unref，error / exit 事件都被消费；前台调用方不等网络。 */
export function spawnBackgroundDownload(input: {
  stateDir: string;
  modelDir: string;
  endpoint: string;
  embedding?: string;
  reranker?: string;
  cliEntry?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (message: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}): { pid: number } | { pid: null; reason: string } {
  const cliEntry = input.cliEntry ?? DEFAULT_CLI_ENTRY;
  if (!existsSync(cliEntry)) return { pid: null, reason: `找不到命令行入口 ${cliEntry}，请先 npm run build` };
  // 后台进程自己就是「下载」本身，不再带 --background，所以它不会再拉起别的进程
  const argv = [
    cliEntry,
    'models',
    'download',
    '--state-dir',
    input.stateDir,
    '--out',
    input.modelDir,
    '--mirror',
    input.endpoint,
    ...(input.embedding ? ['--embedding', input.embedding] : []),
    ...(input.reranker ? ['--reranker', input.reranker] : []),
  ];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore', shell: false, env: input.env ?? process.env });
  } catch (error) {
    return { pid: null, reason: `拉不起后台下载进程：${messageOf(error)}` };
  }
  child.once('error', (error) => input.onError?.(error.message));
  child.once('exit', (code, signal) => input.onExit?.({ code, signal }));
  if (child.pid === undefined) return { pid: null, reason: '没有拿到后台下载进程的进程号' };
  child.unref();
  return { pid: child.pid };
}

/* ---------- 如实报告 ---------- */

export interface ModelKindStatus {
  dir: string;
  ready: boolean;
  file: string | null;
  reason: string | null;
}

export interface DownloadStatusView {
  state: 'none' | 'downloading' | 'interrupted' | 'failed' | 'ready';
  pid: number | null;
  /** 下载进程此刻真的在跑（锁活着或 pid 活着） */
  running: boolean;
  current_file: string | null;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number | null;
  updated_at: string | null;
  error: string | null;
  retry_after: string | null;
  /** 此刻在退避期内（失败后 30 分钟内，或上次下载中途停了 30 分钟内） */
  in_backoff: boolean;
  note: string | null;
}

export interface ModelDownloadStatus {
  model_dir: string;
  state_dir: string;
  auto_download: boolean;
  auto_download_note: string;
  endpoint: string | null;
  endpoint_error: string | null;
  ready: boolean;
  model_id: string | null;
  models: Record<ModelKind, ModelKindStatus>;
  download: DownloadStatusView;
}

/** 自动触发此刻不该再拉起下载的原因；null = 可以拉起。锁活着不抢（lock），失败 / 中断在退避期内不反复拉（backoff）。 */
export type DownloadBlock = { kind: 'lock' | 'backoff'; reason: string };

export function autoDownloadBlockReason(input: { modelDir: string; stateDir: string; now?: number; backoffMs?: number }): DownloadBlock | null {
  const holder = readDownloadLock(input.modelDir);
  if (holder) return { kind: 'lock', reason: `另一个下载进程（pid=${holder.pid}）正在往同一个模型目录下载，不重复拉起` };
  const record = readDownloadState(input.stateDir);
  if (!record || record.modelDir !== input.modelDir) return null;
  const now = input.now ?? Date.now();
  const until = record.state === 'failed' ? Date.parse(record.retryAfter ?? '') : record.state === 'downloading' ? Date.parse(record.updatedAt) + (input.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS) : NaN;
  if (!Number.isFinite(until) || until <= now) return null;
  const when = new Date(until).toISOString();
  return {
    kind: 'backoff',
    reason:
      record.state === 'failed'
        ? `上次下载失败：${record.error ?? '原因没写明'}；${when} 之前不再自动重试（手动运行 memloom models download 不受这个限制）`
        : `上次下载中途停了（进程已经不在，最后在 ${record.currentFile ?? '未知文件'}）；${when} 之前不再自动重试`,
  };
}

function kindStatus(modelDir: string, kind: ModelKind): ModelKindStatus {
  const status = inspectLocalModel(modelDir, kind);
  return { dir: status.dir, ready: status.ready, file: status.file, reason: status.reason };
}

/** `memloom models status` / `doctor` 用：目录、两个模型齐不齐、当前 modelId、后台下载的真实进度或上次失败原因。只读文件，不联网、不拉起任何进程。 */
export function modelDownloadStatus(input: { modelDir: string; stateDir: string; env?: NodeJS.ProcessEnv; mirror?: string; autoDownload: boolean; autoDownloadNote?: string; now?: number }): ModelDownloadStatus {
  const env = input.env ?? process.env;
  const models = { embedding: kindStatus(input.modelDir, 'embedding'), reranker: kindStatus(input.modelDir, 'reranker') };
  const ready = models.embedding.ready && models.reranker.ready;
  let endpoint: string | null = null;
  let endpointError: string | null = null;
  try {
    endpoint = resolveEndpoint(env, input.mirror);
  } catch (error) {
    endpointError = messageOf(error);
  }
  const now = input.now ?? Date.now();
  const record = readDownloadState(input.stateDir);
  const view: DownloadStatusView = { state: 'none', pid: null, running: false, current_file: null, downloaded_bytes: 0, total_bytes: 0, percent: null, updated_at: null, error: null, retry_after: null, in_backoff: false, note: null };
  if (record) {
    view.current_file = record.currentFile;
    view.downloaded_bytes = record.downloadedBytes;
    view.total_bytes = record.totalBytes;
    view.percent = record.totalBytes > 0 ? Math.round((record.downloadedBytes / record.totalBytes) * 1000) / 10 : null;
    view.updated_at = record.updatedAt;
    view.error = record.error;
    view.retry_after = record.retryAfter;
    if (record.modelDir !== input.modelDir) {
      // 别的目录的状态：不冒报运行，也不把它那边的过程数字当成这边的
      view.state = 'none';
      view.pid = null;
      view.running = false;
      view.current_file = null;
      view.downloaded_bytes = 0;
      view.percent = null;
      view.note = `这份记录属于另一个模型目录「${record.modelDir}」（那边是 ${record.state}），不拿来当这个目录的状态`;
    } else if (record.state === 'downloading') {
      // 只有此刻真活着的锁才算在跑；记录里的旧 pid 孤零零活着（多半是 pid 复用）不算
      const holder = readDownloadLock(input.modelDir);
      view.pid = holder?.pid ?? record.pid;
      view.running = holder !== null;
      view.state = view.running ? 'downloading' : 'interrupted';
      const until = Date.parse(record.updatedAt) + DEFAULT_RETRY_BACKOFF_MS;
      view.in_backoff = !view.running && until > now;
      view.note = view.running ? '后台下载正在进行' : `上次下载中途停了（进程已经不在）；${view.in_backoff ? `${new Date(until).toISOString()} 之前不再自动重试` : '下一次召回会重新拉起'}`;
    } else if (record.state === 'failed') {
      view.state = 'failed';
      view.pid = record.pid;
      view.in_backoff = Date.parse(record.retryAfter ?? '') > now;
      view.note = view.in_backoff ? `${record.retryAfter} 之前不再自动重试；手动运行 memloom models download 不受这个限制` : '已过退避时间，下一次召回会再试；也可以手动运行 memloom models download';
    } else {
      view.state = 'ready';
      view.note = ready ? '两个模型都已就绪' : '记录说已就绪，但模型目录现在缺文件（可能被删或移动过）；下一次召回会重新下载';
    }
  } else {
    view.note = ready ? '模型已经在目录里，不需要下载' : '还没有下载过';
  }
  // 目录自己标着「下载中」时把原因带出来，哪怕还没有状态记录
  const managed = managedState(input.modelDir);
  if (!ready && managed.state === 'downloading') view.note = `${view.note ?? ''}；${managed.note ?? '模型目录标记为下载中'}`.replace(/^；/, '');
  return {
    model_dir: input.modelDir,
    state_dir: input.stateDir,
    auto_download: input.autoDownload,
    auto_download_note: input.autoDownloadNote ?? (input.autoDownload ? '缺模型时在后台自动下载' : '不自动下载（MEMLOOM_AUTO_DOWNLOAD=0 或代码里 autoDownload:false）；需要时手动运行 memloom models download'),
    endpoint,
    endpoint_error: endpointError,
    ready,
    model_id: ready ? resolveLocalModelId(input.modelDir) : null,
    models,
    download: view,
  };
}

/** 百分比和进度的中文一句话，命令行和 doctor 共用 */
export function describeDownloadProgress(view: DownloadStatusView): string {
  const mib = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  switch (view.state) {
    case 'downloading':
      return `正在进行（pid=${String(view.pid)}，${view.current_file ?? '未知文件'}，${mib(view.downloaded_bytes)} / ${mib(view.total_bytes)}${view.percent === null ? '' : `，${view.percent}%`}）`;
    case 'interrupted':
      return `没有在跑；${view.note ?? ''}`;
    case 'failed':
      return `没有在跑；上次失败：${view.error ?? '原因没写明'}。${view.note ?? ''}`;
    case 'ready':
      return view.note ?? '两个模型都已就绪';
    default:
      return view.note ?? '没有在跑';
  }
}
