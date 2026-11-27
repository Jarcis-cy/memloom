/**
 * 本地模型的身份与文件位置（纯文件读取，不加载任何运行时）。
 * 客户端和服务进程都用同一个 modelId 判断库里的向量能不能拿来比：
 * 仓库 + revision + 量化文件 + 维度，任何一项不同都不会混比。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** 本地向量固定 512 维（Matryoshka 截断后 L2 归一化） */
export const LOCAL_DIMENSIONS = 512;

/** 按这个顺序找第一个存在的模型文件；下载脚本默认拿 embedding 的 int8 和 reranker 的 quantized */
export const EMBEDDING_CANDIDATES = ['model_int8.onnx', 'model_quantized.onnx', 'model_q4f16.onnx', 'model_q4.onnx'];
export const RERANKER_CANDIDATES = ['model_quantized.onnx', 'model_q4.onnx'];

export interface ModelManifest {
  repo: string;
  revision: string;
  file: string;
  files?: Record<string, { bytes: number; sha256: string | null }>;
}

export interface LocalModelFiles {
  modelDir: string;
  embedding: { dir: string; file: string; manifest: ModelManifest | null };
  reranker: { dir: string; file: string; manifest: ModelManifest | null };
}

function readManifest(dir: string): ModelManifest | null {
  const path = join(dir, 'memloom-model.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed as Partial<ModelManifest>;
      if (typeof candidate.repo === 'string' && typeof candidate.revision === 'string' && typeof candidate.file === 'string') {
        return { repo: candidate.repo, revision: candidate.revision, file: candidate.file, files: candidate.files };
      }
    }
  } catch {
    // 坏清单当没有
  }
  return null;
}

function pickFile(dir: string, manifest: ModelManifest | null, candidates: readonly string[]): string {
  if (manifest && existsSync(join(dir, manifest.file))) return manifest.file;
  for (const name of candidates) {
    if (existsSync(join(dir, 'onnx', name))) return `onnx/${name}`;
  }
  throw new Error(`在「${dir}」里找不到 ONNX 模型文件（找过 onnx/${candidates.join('、onnx/')}）`);
}

/** 两个模型子目录都在才算本地模型齐了（只看目录，不加载）。 */
export function localModelsPresent(modelDir: string): boolean {
  return existsSync(join(modelDir, 'embedding')) && existsSync(join(modelDir, 'reranker'));
}

/** 解析模型目录；缺文件时抛带中文说明的错误，客户端据此直接退回字面检索。 */
export function resolveLocalModels(modelDir: string): LocalModelFiles {
  const embeddingDir = join(modelDir, 'embedding');
  const rerankerDir = join(modelDir, 'reranker');
  if (!localModelsPresent(modelDir)) {
    throw new Error(`本地模型目录不完整：需要「${embeddingDir}」和「${rerankerDir}」都在`);
  }
  for (const dir of [embeddingDir, rerankerDir]) {
    for (const name of ['tokenizer.json', 'config.json']) {
      if (!existsSync(join(dir, name))) throw new Error(`模型目录「${dir}」缺 ${name}`);
    }
  }
  const embeddingManifest = readManifest(embeddingDir);
  const rerankerManifest = readManifest(rerankerDir);
  return {
    modelDir,
    embedding: { dir: embeddingDir, file: pickFile(embeddingDir, embeddingManifest, EMBEDDING_CANDIDATES), manifest: embeddingManifest },
    reranker: { dir: rerankerDir, file: pickFile(rerankerDir, rerankerManifest, RERANKER_CANDIDATES), manifest: rerankerManifest },
  };
}

function repoName(repo: string | undefined): string {
  return basename(repo ?? 'Qwen3-Embedding-0.6B-ONNX').replace(/-onnx$/i, '').toLowerCase();
}

function revisionTag(revision: string | undefined): string {
  return revision && /^[0-9a-f]{7,40}$/i.test(revision) ? revision.slice(0, 7).toLowerCase() : 'unknown';
}

function quantTag(file: string): string {
  return basename(file).replace(/^model_/, '').replace(/\.onnx$/, '');
}

/** 向量模型身份，例如 `qwen3-embedding-0.6b@c25a394:int8:512`。 */
export function localModelId(files: LocalModelFiles, dimensions: number): string {
  return `${repoName(files.embedding.manifest?.repo)}@${revisionTag(files.embedding.manifest?.revision)}:${quantTag(files.embedding.file)}:${dimensions}`;
}

/** 只看目录就能算出的 modelId（找不到模型时返回 null，由调用方决定怎么报错）。 */
export function resolveLocalModelId(modelDir: string, dimensions: number = LOCAL_DIMENSIONS): string | null {
  try {
    return localModelId(resolveLocalModels(modelDir), dimensions);
  } catch {
    return null;
  }
}
