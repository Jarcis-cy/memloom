#!/usr/bin/env node
/**
 * 旧的一次性模型取证脚本，现在只是 `memloom models download` 的薄壳：
 * 下载、续传、大小和 sha256 校验、锁、状态文件的逻辑全部在 src/retriever/models.ts（编译产物 dist/src/retriever/models.js），
 * 这里不留第二套。需要先 npm run build。
 *
 * 用法（和以前一样，多了 --mirror）：
 *   node scripts/fetch-retriever-models.mjs --out <模型目录> [--embedding model_int8.onnx] [--reranker model_quantized.onnx] [--mirror <https://镜像源>]
 *
 * 状态目录默认 MEMLOOM_STATE_DIR / MEMLOOM_HOME（没有就 ~/.memloom）；进度同时写 <状态目录>/model-download.log。
 * 平时不必跑它：缺模型时召回会自动在后台下载（MEMLOOM_AUTO_DOWNLOAD=0 可关），或者直接 `memloom models download`。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = { out: null, embedding: null, reranker: null, mirror: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i];
    else if (arg === '--embedding') out.embedding = argv[++i];
    else if (arg === '--reranker') out.reranker = argv[++i];
    else if (arg === '--mirror') out.mirror = argv[++i];
    else throw new Error(`不认识的参数：${arg}`);
  }
  if (!out.out) throw new Error('必须用 --out 指定模型目录');
  return out;
}

const entry = new URL('../dist/src/retriever/models.js', import.meta.url);
if (!existsSync(entry)) {
  console.error('请先 npm run build：这个脚本只是 memloom models download 的薄壳，逻辑在编译产物里');
  process.exit(1);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const { resolveEndpoint, runModelDownload } = await import(entry.href);
  const stateDir = process.env.MEMLOOM_STATE_DIR ?? process.env.MEMLOOM_HOME ?? join(homedir(), '.memloom');
  const result = await runModelDownload({
    stateDir,
    modelDir: resolve(options.out),
    endpoint: resolveEndpoint(process.env, options.mirror),
    embedding: options.embedding,
    reranker: options.reranker,
    onLine: (line) => console.log(`  ${line}`),
  });
  console.log(`完成：${result.modelDir}（当前 modelId ${result.modelId ?? '算不出'}；清单 ${join(result.modelDir, 'manifest.json')}）`);
} catch (error) {
  console.error(`下载模型失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
