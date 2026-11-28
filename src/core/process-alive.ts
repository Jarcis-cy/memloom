/**
 * 进程判活（检索守护进程的锁、会话文件锁共用这一套）。
 *
 * `process.kill(pid, 0)` 成功只说明「这个 pid 还占着」。在没有僵尸回收的 Linux 容器或沙箱里
 * （1 号进程不是 tini / systemd 这类会收孤儿的），已经退出的子进程会一直以僵尸状态留着，这时 kill(0) 照样成功，
 * `daemon stop` 就会白等到超时还误报「没停下来」。所以 Linux 下 kill(0) 成功之后再读一眼 `/proc/<pid>/stat`：
 * 状态是 Z（僵尸）或 X / x（dead）就当它已经退出。
 *
 * 其它平台和 EPERM 的处理和以前一样：不是 Linux 就只看 kill(0)；kill(0) 报 EPERM 说明进程在但不归我们管，也算活着。
 */
import { readFileSync } from 'node:fs';

/** 已经退出、只差父进程回收的状态字母：Z = 僵尸；X / x = dead（老内核用 x，2.6.33 ~ 3.13）。 */
const DEAD_STATES = new Set(['Z', 'X', 'x']);

/**
 * 从 `/proc/<pid>/stat` 的一行里取状态字母。
 * 括号里的进程名可以带空格、括号甚至换行，所以不数空格，只认最后一个 `)` 之后的那一个字母；看不懂返回 null。
 */
export function parseProcState(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const state = stat.slice(close + 1).trimStart()[0];
  return state !== undefined && /[A-Za-z]/.test(state) ? state : null;
}

/** alive = 还在跑；dead = 僵尸 / dead；gone = `/proc/<pid>` 已经没了；unknown = 读不到或看不懂（调用方按活着处理） */
export type ProcVerdict = 'alive' | 'dead' | 'gone' | 'unknown';

export type StatReader = (pid: number) => string;

function readProcStat(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, 'utf8');
}

/** Linux：读 `/proc/<pid>/stat` 下结论。`readStat` 可以注入（测试夹具）；ENOENT 算没了，其它读错算不知道。 */
export function inspectLinuxProcess(pid: number, readStat: StatReader = readProcStat): ProcVerdict {
  let stat: string;
  try {
    stat = readStat(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown';
  }
  const state = parseProcState(stat);
  if (state === null) return 'unknown';
  return DEAD_STATES.has(state) ? 'dead' : 'alive';
}

export interface ProcessAliveDeps {
  /** 测试注入；默认 `process.platform` */
  platform?: NodeJS.Platform;
  /** 测试注入；默认读真的 `/proc/<pid>/stat` */
  readStat?: StatReader;
  /** 测试注入；默认 `process.kill(pid, 0)` */
  kill?: (pid: number, signal: number) => void;
}

/**
 * 这个 pid 是不是还活着。
 * - 不是正整数：false；kill(0) 报错：只有 EPERM 算活着（进程在，只是不归我们管），其余 false；
 * - 非 Linux：kill(0) 成功就是活着（原行为）；
 * - Linux：kill(0) 成功后再看 `/proc/<pid>/stat`，僵尸 / dead 或文件已经没了（ENOENT）都算退出，其它读错照旧当活着。
 */
export function isProcessAlive(pid: number, deps: ProcessAliveDeps = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    (deps.kill ?? process.kill)(pid, 0);
  } catch (error) {
    // EPERM 说明进程在但不归我们管，也算活着
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if ((deps.platform ?? process.platform) !== 'linux') return true;
  const verdict = inspectLinuxProcess(pid, deps.readStat ?? readProcStat);
  return verdict === 'alive' || verdict === 'unknown';
}
