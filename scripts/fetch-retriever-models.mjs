#!/usr/bin/env node
/**
 * 一次性、人工主动运行的模型取证脚本：把公开的 Qwen3 ONNX 量化模型下载到指定目录。
 *
 * 为什么需要它：本地检索服务只读本地模型目录，绝不在用户查询时自动联网下载。
 * 用户想启用本地模式，必须自己显式跑一次这个脚本（或在 M3 里用等价的 CLI 命令）。
 *
 * 做法与边界：
 * - 仓库、revision、文件名全部固定写在下面的清单里，不接受任意地址；
 * - 每个文件按 Hugging Face 公开元数据里的 LFS sha256 校验，下载不完整或对不上就删掉重来；
 * - 支持断点续传（Range），总下载量超过 3 GiB 直接停；
 * - 只下载模型和分词器文件，不执行任何远端代码；模型目录不要提交进 Git。
 *
 * 用法：
 *   node scripts/fetch-retriever-models.mjs --out <模型目录> [--embedding model_int8.onnx] [--reranker model_quantized.onnx]
 *
 * 目录结构（本地检索服务的 modelDir）：
 *   <out>/embedding/   Qwen3-Embedding-0.6B ONNX
 *   <out>/reranker/    Qwen3-Reranker-0.6B ONNX
 *   <out>/manifest.json  仓库、revision、文件、sha256
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_TOTAL_BYTES = 3 * 1024 ** 3;

const SOURCES = {
  embedding: {
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    defaultFile: 'model_int8.onnx',
    allowedFiles: ['model_int8.onnx', 'model_quantized.onnx', 'model_q4.onnx', 'model_q4f16.onnx'],
  },
  reranker: {
    repo: 'onnx-community/Qwen3-Reranker-0.6B-ONNX',
    revision: '9995c50e2310679108a55f5ccd16ba8be9f17c20',
    defaultFile: 'model_quantized.onnx',
    allowedFiles: ['model_quantized.onnx', 'model_q4.onnx'],
  },
};

const SMALL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json'];

function parseArgs(argv) {
  const out = { out: null, embedding: null, reranker: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i];
    else if (arg === '--embedding') out.embedding = argv[++i];
    else if (arg === '--reranker') out.reranker = argv[++i];
    else throw new Error(`不认识的参数：${arg}`);
  }
  if (!out.out) throw new Error('必须用 --out 指定模型目录');
  return out;
}

async function listTree(repo, revision) {
  const url = `https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=true`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`读不到 ${repo}@${revision.slice(0, 7)} 的文件清单：HTTP ${response.status}`);
  const tree = await response.json();
  const map = new Map();
  for (const entry of tree) {
    if (entry.type !== 'file') continue;
    map.set(entry.path, {
      path: entry.path,
      bytes: entry.lfs?.size ?? entry.size ?? 0,
      sha256: entry.lfs?.oid ?? null,
    });
  }
  return map;
}

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** 断点续传下载一个文件；校验大小，LFS 文件再校 sha256。 */
async function fetchFile(url, target, expected) {
  if (existsSync(target)) {
    const size = statSync(target).size;
    if (size === expected.bytes && (!expected.sha256 || (await sha256OfFile(target)) === expected.sha256)) {
      console.log(`  已存在且校验通过：${target}`);
      return 0;
    }
    if (size > expected.bytes) rmSync(target);
  }
  const partial = existsSync(target);
  const headers = {};
  if (partial) headers.Range = `bytes=${statSync(target).size}-`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  const append = partial && response.status === 206;
  if (partial && !append) rmSync(target);
  if (!response.ok && response.status !== 206) throw new Error(`下载失败：HTTP ${response.status} ${url}`);
  const before = append ? statSync(target).size : 0;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: append ? 'a' : 'w' }));
  const after = statSync(target).size;
  if (after !== expected.bytes) throw new Error(`大小不对：${target} 实际 ${after}，元数据 ${expected.bytes}`);
  if (expected.sha256 && (await sha256OfFile(target)) !== expected.sha256) {
    rmSync(target);
    throw new Error(`sha256 对不上：${target}`);
  }
  return after - before;
}

async function downloadModel(kind, options, outDir, budget) {
  const source = SOURCES[kind];
  const file = options[kind] ?? source.defaultFile;
  if (!source.allowedFiles.includes(file)) throw new Error(`${kind} 只支持这些文件：${source.allowedFiles.join('、')}`);
  const tree = await listTree(source.repo, source.revision);
  const dir = join(outDir, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wanted = [...SMALL_FILES, `onnx/${file}`].map((path) => {
    const entry = tree.get(path);
    if (!entry) throw new Error(`${source.repo} 里没有 ${path}`);
    return entry;
  });
  const total = wanted.reduce((sum, entry) => sum + entry.bytes, 0);
  budget.used += total;
  if (budget.used > MAX_TOTAL_BYTES) throw new Error(`总下载量超过 3 GiB 上限，停止`);
  console.log(`${source.repo}@${source.revision.slice(0, 7)} → ${dir}（${(total / 1024 ** 2).toFixed(0)} MiB）`);
  const manifest = { repo: source.repo, revision: source.revision, file: `onnx/${file}`, files: {} };
  for (const entry of wanted) {
    const target = join(dir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    process.stdout.write(`  ${entry.path} … `);
    const got = await fetchFile(`https://huggingface.co/${source.repo}/resolve/${source.revision}/${entry.path}`, target, entry);
    console.log(`${(entry.bytes / 1024 ** 2).toFixed(1)} MiB${got === 0 ? '（跳过）' : `（新下载 ${(got / 1024 ** 2).toFixed(1)} MiB）`}`);
    manifest.files[entry.path] = { bytes: entry.bytes, sha256: entry.sha256 };
  }
  const manifestPath = join(dir, 'memloom-model.json');
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, manifestPath);
  return manifest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = join(options.out);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const budget = { used: 0 };
  const models = {};
  for (const kind of ['embedding', 'reranker']) {
    models[kind] = await downloadModel(kind, options, outDir, budget);
  }
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({ fetched_at: new Date().toISOString(), models }, null, 2)}\n`);
  console.log(`完成：${outDir}（清单 ${manifestPath}）`);
}

main().catch((error) => {
  console.error(`下载模型失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
