/**
 * `memloom daemon status|stop` 用的探测与安全停止：只通过共享检索服务的 socket 协议（status / stop）和它的锁说话。
 * - 不启动服务、不加载模型（那是检索时才按需做的事）；
 * - 只凭协议回话里的 pid 和 /proc 里的入口脚本名认身份；认不出的一律不停，也绝不 kill 任何进程；
 * - socket 能连上但不回话、或锁的持有者还活着，如实报告「正在启动或正忙」，不说成没运行。
 */
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { statePaths } from '../retriever/paths.js';
import { encodeLine, parseResponseLine, PROTOCOL_VERSION, type Request, type ServiceStatus } from '../retriever/protocol.js';
import { isProcessAlive, looksLikeDaemon, probeSocket, readLock } from '../retriever/service.js';

export type DaemonStatus =
  | {
      state: 'running';
      pid: number;
      /** 是不是 memloom 自己的检索服务（看 /proc/<pid>/cmdline 里有没有 daemon.js） */
      identity: 'memloom-retriever' | 'unknown';
      protocolVersion: number;
      loading: boolean;
      loadedAt: string | null;
      modelId: string;
      dimensions: number;
      rssMiB: number;
      idleSeconds: number;
      inFlight: number;
      stateDir: string;
      socketPath: string;
      note: string;
    }
  | { state: 'starting-or-busy'; pid: number | null; stateDir: string; socketPath: string; note: string }
  | { state: 'stale'; stateDir: string; socketPath: string; note: string }
  | { state: 'stopped'; stateDir: string; socketPath: string };

export interface DaemonStopResult {
  stopped: boolean;
  status: DaemonStatus;
  message: string;
}

function askService<T>(socketPath: string, request: Request, timeoutMs: number): Promise<T | null> {
  if (!existsSync(socketPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.once('error', () => done(null));
    socket.once('close', () => done(null));
    socket.once('connect', () => socket.write(encodeLine(request)));
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      if (settled || line.trim() === '') return;
      try {
        const response = parseResponseLine(line);
        if (response.id !== 1) return;
        done(response.ok ? (response.result as T) : null);
      } catch {
        done(null);
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function daemonStatus(stateDir: string): Promise<DaemonStatus> {
  const paths = statePaths(stateDir);
  const base = { stateDir: paths.stateDir, socketPath: paths.socketPath };
  const probe = await probeSocket(paths.socketPath, 1_500);
  const status = await askService<ServiceStatus>(paths.socketPath, { id: 1, method: 'status' }, 2_000);
  if (status && typeof status.pid === 'number' && typeof status.modelId === 'string') {
    const mine = isProcessAlive(status.pid) && looksLikeDaemon(status.pid, 'daemon.js');
    return {
      state: 'running',
      pid: status.pid,
      identity: mine ? 'memloom-retriever' : 'unknown',
      protocolVersion: status.protocolVersion,
      loading: status.loading,
      loadedAt: status.loadedAt,
      modelId: status.modelId,
      dimensions: status.dimensions,
      rssMiB: Math.round(status.rssBytes / 1024 / 1024),
      idleSeconds: Math.round(status.idleMs / 1000),
      inFlight: status.inFlight,
      ...base,
      note:
        status.protocolVersion !== PROTOCOL_VERSION
          ? `协议版本 ${status.protocolVersion} 和这边认的 ${PROTOCOL_VERSION} 不一致，客户端会拒用；建议 memloom daemon stop 后让它按新版本重启`
          : status.loading
            ? '正在加载模型'
            : status.loadedAt
              ? '模型已就绪'
              : '进程在，但没有加载成模型',
    };
  }
  if (probe === 'live') {
    const holder = readLock(paths.lockPath);
    return {
      state: 'starting-or-busy',
      pid: holder && holder.pid > 0 ? holder.pid : null,
      ...base,
      note: 'socket 能连上但 2 秒内没有回应：多半是正在加载模型（那几秒事件循环被占住），或者正忙；它是在运行的',
    };
  }
  const holder = readLock(paths.lockPath);
  if (holder && holder.pid > 0 && isProcessAlive(holder.pid)) {
    return { state: 'starting-or-busy', pid: holder.pid, ...base, note: '锁的持有者进程还活着，但 socket 还没监听：正在启动' };
  }
  if (probe !== 'none') {
    return { state: 'stale', ...base, note: '有 socket 文件但连不上、也没有活着的持有者：是崩溃残留，下一次检索会自动清掉，不用手动删' };
  }
  return { state: 'stopped', ...base };
}

/** 请求服务自己安全退出（在途请求做完就停）。认不出身份、正忙不回话、没在运行，都如实说，绝不 kill。 */
export async function daemonStop(stateDir: string, reason = 'memloom daemon stop'): Promise<DaemonStopResult> {
  const status = await daemonStatus(stateDir);
  if (status.state !== 'running') {
    const message =
      status.state === 'starting-or-busy' ? '服务正在启动或正忙，现在确认不了它的身份，不停；等它就绪后再试' : '共享检索服务没有在运行，不需要停';
    return { stopped: false, status, message };
  }
  if (status.identity !== 'memloom-retriever') {
    return { stopped: false, status, message: `pid=${status.pid} 不像 memloom 的检索服务（命令行里没有 daemon.js），拒绝停止，也不杀未知进程` };
  }
  await askService(status.socketPath, { id: 1, method: 'stop', reason }, 8_000);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isProcessAlive(status.pid)) await sleep(100);
  const stopped = !isProcessAlive(status.pid);
  return { stopped, status, message: stopped ? `服务 pid=${status.pid} 已经退出，socket 和锁自己清掉了` : `已经发出停止请求，但 pid=${status.pid} 8 秒内还没退出（可能还有在途请求）` };
}
