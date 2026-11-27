#!/usr/bin/env node
/**
 * 本地共享检索服务的进程入口：`node daemon.js <状态目录>`。
 *
 * 客户端（local.ts）在第一次需要时用 `process.execPath` 把它拉起来，脱离父进程、不继承 stdio。
 * 这个文件在顶层只 import 进程骨架（service.js）；ONNX 运行时和模型要等 runService 抢到独占锁之后、
 * 通过 load 回调里的动态 import 才会加载，所以并发首启时输掉锁的进程从头到尾不碰模型。
 *
 * 环境变量（由客户端设置，也可以手工调试时自己给）：
 *   MEMLOOM_RETRIEVER_MODEL_DIR   模型目录（embedding/ 与 reranker/）
 *   MEMLOOM_RETRIEVER_IDLE_MS     完全闲置多少毫秒后退出，默认 10 分钟
 *   MEMLOOM_RETRIEVER_THREADS     ONNX CPU 线程数，默认 min(8, 核数)
 */
import { availableParallelism } from 'node:os';
import { DEFAULT_IDLE_MS, runService } from './service.js';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<number> {
  const stateDir = process.argv[2];
  const modelDir = process.env.MEMLOOM_RETRIEVER_MODEL_DIR;
  if (!stateDir || !modelDir) {
    process.stderr.write('用法：MEMLOOM_RETRIEVER_MODEL_DIR=<模型目录> node daemon.js <状态目录>\n');
    return 2;
  }
  const threads = intEnv('MEMLOOM_RETRIEVER_THREADS', Math.min(8, Math.max(1, availableParallelism())));
  const exit = await runService({
    stateDir,
    modelDir,
    idleMs: intEnv('MEMLOOM_RETRIEVER_IDLE_MS', DEFAULT_IDLE_MS),
    backendKind: 'onnx',
    load: async () => {
      // 只有走到这里（已经拿到独占锁）才会真正加载原生运行时和模型
      const { loadOnnxBackend } = await import('./onnx.js');
      return loadOnnxBackend(modelDir, { threads });
    },
  });
  return exit.outcome === 'failed' ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`检索服务异常退出：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
