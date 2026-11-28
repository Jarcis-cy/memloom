/**
 * 本地模型的身份与文件位置（纯文件读取，不加载任何运行时）。
 * 客户端和服务进程都用同一个 modelId 判断库里的向量能不能拿来比：
 * 仓库 + revision + 量化文件 + 维度，任何一项不同都不会混比。
 *
 * 「本地模型齐了」看的是文件而不是目录：两个子目录都在、各有 tokenizer.json / config.json 和 onnx/ 下的模型文件才算数。
 * 只看目录会在下载到一半时就把模型当成「已就绪」（旧写法的毛病），这里不再犯。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** 本地向量固定 512 维（Matryoshka 截断后 L2 归一化） */
export const LOCAL_DIMENSIONS = 512;

/** 按这个顺序找第一个存在的模型文件；下载默认拿 embedding 的 int8 和 reranker 的 quantized */
export const EMBEDDING_CANDIDATES = ['model_int8.onnx', 'model_quantized.onnx', 'model_q4f16.onnx', 'model_q4.onnx'];
export const RERANKER_CANDIDATES = ['model_quantized.onnx', 'model_q4.onnx'];

export type ModelKind = 'embedding' | 'reranker';

export interface ManifestFile {
  bytes: number;
  /** LFS 文件的 sha256；普通小文件没有 */
  sha256: string | null;
  /** 普通小文件的 git blob 摘要（新下载的清单才带） */
  gitSha1?: string | null;
}

export interface ModelManifest {
  repo: string;
  revision: string;
  file: string;
  files?: Record<string, ManifestFile>;
  /** 从哪个源下的（官方地址或镜像）；旧清单没有 */
  endpoint?: string;
  fetchedAt?: string;
}

export interface LocalModelFiles {
  modelDir: string;
  embedding: { dir: string; file: string; manifest: ModelManifest | null };
  reranker: { dir: string; file: string; manifest: ModelManifest | null };
}

/** 一个模型子目录此刻的状态：齐不齐、用哪个文件、不齐的原因 */
export interface LocalModelStatus {
  kind: ModelKind;
  dir: string;
  ready: boolean;
  /** 相对子目录的模型文件路径，例如 onnx/model_int8.onnx；不齐时为 null */
  file: string | null;
  manifest: ModelManifest | null;
  reason: string | null;
}

function readManifest(dir: string): ModelManifest | null {
  const path = join(dir, 'memloom-model.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed as Partial<ModelManifest>;
      if (typeof candidate.repo === 'string' && typeof candidate.revision === 'string' && typeof candidate.file === 'string') {
        return { repo: candidate.repo, revision: candidate.revision, file: candidate.file, files: candidate.files, endpoint: candidate.endpoint, fetchedAt: candidate.fetchedAt };
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

/** 只做文件层面的检查（几个 existsSync，微秒级），不加载任何运行时。 */
export function inspectLocalModel(modelDir: string, kind: ModelKind): LocalModelStatus {
  const dir = join(modelDir, kind);
  const candidates = kind === 'embedding' ? EMBEDDING_CANDIDATES : RERANKER_CANDIDATES;
  for (const name of ['tokenizer.json', 'config.json']) {
    if (!existsSync(join(dir, name))) return { kind, dir, ready: false, file: null, manifest: null, reason: `缺 ${name}` };
  }
  const manifest = readManifest(dir);
  try {
    return { kind, dir, ready: true, file: pickFile(dir, manifest, candidates), manifest, reason: null };
  } catch (error) {
    return { kind, dir, ready: false, file: null, manifest, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 模型目录自己的发布门槛（根 manifest.json）：
 * - 没有根清单、或是不带 state 的旧格式（旧脚本最后才写它，存在即完整）、或读不懂 → 不管门槛，只看文件；
 * - state=downloading → 下载器正在往这个目录写文件，不管文件看起来多齐都不算就绪；
 * - state=ready → 下载器已经原子发布过整对模型，此时两个 per-model 清单都必须在、且指向的文件就是实际用的那个。
 * 同一个模型目录被不同状态目录的进程看到时，门槛是同一份，谁都不会早熟。
 */
export type ManagedState = 'none' | 'downloading' | 'ready';

export function managedState(modelDir: string): { state: ManagedState; note: string | null } {
  const path = join(modelDir, 'manifest.json');
  if (!existsSync(path)) return { state: 'none', note: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { state: 'none', note: null };
    const state = (parsed as { state?: unknown }).state;
    if (state === undefined) return { state: 'none', note: null };
    if (state === 'ready') return { state: 'ready', note: null };
    if (state === 'downloading') return { state: 'downloading', note: `模型目录标记为下载中（${path}），文件再齐也不当作就绪` };
    return { state: 'downloading', note: `模型目录的总清单里 state 看不懂（${String(state)}），不当作就绪` };
  } catch {
    return { state: 'none', note: null };
  }
}

/** ready 门槛下：per-model 清单在，而且它指向的文件就是实际会加载的那个。 */
function aligned(status: LocalModelStatus): boolean {
  return status.manifest !== null && status.manifest.file === status.file;
}

/** 两个模型的文件都齐了、且目录没有被标记为下载中，才算本地模型可用（不看目录存在，看文件）。 */
export function localModelsPresent(modelDir: string): boolean {
  const managed = managedState(modelDir);
  if (managed.state === 'downloading') return false;
  const embedding = inspectLocalModel(modelDir, 'embedding');
  const reranker = inspectLocalModel(modelDir, 'reranker');
  if (!embedding.ready || !reranker.ready) return false;
  if (managed.state === 'ready') return aligned(embedding) && aligned(reranker);
  return true;
}

/** 解析模型目录；缺文件、目录还在下载中、清单和文件对不上时抛带中文说明的错误，客户端据此直接退回字面检索。 */
export function resolveLocalModels(modelDir: string): LocalModelFiles {
  const managed = managedState(modelDir);
  if (managed.state === 'downloading') throw new Error(`本地模型目录未就绪：${managed.note ?? '标记为下载中'}`);
  const embedding = inspectLocalModel(modelDir, 'embedding');
  const reranker = inspectLocalModel(modelDir, 'reranker');
  if (!embedding.ready || !reranker.ready) {
    const missing = [embedding, reranker].filter((status) => !status.ready).map((status) => `「${status.dir}」${status.reason ?? '文件不齐'}`);
    throw new Error(`本地模型目录不完整：${missing.join('；')}`);
  }
  if (managed.state === 'ready') {
    const misaligned = [embedding, reranker].filter((status) => !aligned(status));
    if (misaligned.length > 0) {
      throw new Error(
        `本地模型目录的清单和文件对不上：${misaligned.map((status) => `「${status.dir}」的 memloom-model.json 不在或不是指向实际加载的文件`).join('；')}；重新运行 memloom models download 或删掉该清单`,
      );
    }
  }
  return {
    modelDir,
    embedding: { dir: embedding.dir, file: embedding.file as string, manifest: embedding.manifest },
    reranker: { dir: reranker.dir, file: reranker.file as string, manifest: reranker.manifest },
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

/** 只看文件就能算出的 modelId（找不到模型时返回 null，由调用方决定怎么报错）。 */
export function resolveLocalModelId(modelDir: string, dimensions: number = LOCAL_DIMENSIONS): string | null {
  try {
    return localModelId(resolveLocalModels(modelDir), dimensions);
  } catch {
    return null;
  }
}
