import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 共享检索服务的状态目录与文件位置。
 * 默认是 `~/.memloom`（可用环境变量 MEMLOOM_HOME 改），目录只允许当前用户访问；
 * 测试和示例一律显式传临时目录，绝不碰用户真实的 ~/.memloom。
 */
export interface StatePaths {
  stateDir: string;
  socketPath: string;
  lockPath: string;
  logPath: string;
  lastErrorPath: string;
}

export function statePaths(stateDir: string): StatePaths {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    throw new Error('必须显式给出检索服务的状态目录，不提供默认路径');
  }
  const absolute = resolve(stateDir);
  const socketPath = join(absolute, 'retriever.sock');
  // Linux 的 Unix socket 路径上限是 108 字节，太长会直接 listen 失败，提前说清楚
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`状态目录路径太长，Unix socket 放不下：${socketPath}`);
  }
  return {
    stateDir: absolute,
    socketPath,
    lockPath: join(absolute, 'retriever.lock'),
    logPath: join(absolute, 'retriever.log'),
    lastErrorPath: join(absolute, 'retriever.last-error'),
  };
}

/** 只有显式调用这个函数才会用到 ~/.memloom；库代码和测试都不许默认调用它。 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMLOOM_HOME && env.MEMLOOM_HOME.trim() !== '') return env.MEMLOOM_HOME;
  return join(homedir(), '.memloom');
}

/** 建目录（0700）并确认它属于当前用户；别人能写这个目录就能冒充检索服务。返回是否收紧过权限。 */
export function ensureStateDir(stateDir: string): boolean {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stats = statSync(stateDir);
  if (!stats.isDirectory()) throw new Error(`状态目录不是目录：${stateDir}`);
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error(`状态目录「${stateDir}」属于别的用户，拒绝使用`);
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    // 目录是我们自己的，但被 umask 或手工建成了对其他用户开放：收紧到 0700，保证只有当前用户能连 socket
    chmodSync(stateDir, 0o700);
    return true;
  }
  return false;
}

/** 本地模型目录的默认位置：<状态目录>/models，里面放 embedding/ 与 reranker/。 */
export function defaultModelDir(stateDir: string): string {
  return join(stateDir, 'models');
}

/** 两个模型子目录都在才算本地模型可用（只看目录，不加载）。 */
export function localModelDirsExist(modelDir: string, exists: (path: string) => boolean): boolean {
  return modelDir !== '' && exists(join(modelDir, 'embedding')) && exists(join(modelDir, 'reranker'));
}
