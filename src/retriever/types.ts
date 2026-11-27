/**
 * 检索底座的统一接口（架构规格 §3.1）与三档运行模式。
 * 这里只有类型和两个小工具函数，不碰数据库、不碰任何模型运行时。
 */

export type RetrieverMode = 'local-onnx' | 'api' | 'fts-only';

/** 向量与精排的统一接口；fts-only 是没有语义能力时的保底实现（embed 会直接抛错，rerank 退化成字面重叠分）。 */
export interface Retriever {
  /** 模型身份与维度，例如 `qwen3-embedding-0.6b@c25a394:int8:512`；存在库里的向量靠它判断能不能比 */
  readonly modelId: string;
  /** 向量维度，默认 512 */
  readonly dimensions: number;
  /** query 模式带检索指令，document 模式是原文 */
  embed(texts: string[], mode: 'query' | 'document'): Promise<Float32Array[]>;
  /** 真实相关性精排：返回 [0, 1] 分数，按分数从高到低，最多 topK 条；index 对应 documents 的下标 */
  rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]>;
  /** 如实报告当前实际可用的模式；detail 用中文说明，绝不带凭据 */
  health(): Promise<RetrieverHealth>;
}

export interface RerankHit {
  index: number;
  score: number;
}

export interface RetrieverHealth {
  /** 语义能力（向量 + 精排）此刻是否真的可用 */
  ok: boolean;
  mode: RetrieverMode;
  detail?: string;
}

/** 检索器不可用（服务起不来、模型缺失、超时、响应坏掉）：混合召回据此退回字面检索，绝不卡主流程。 */
export class RetrieverUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetrieverUnavailable';
    this.code = code;
  }
}

/** 把分数夹到 [0, 1]；NaN 一律当 0。 */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** L2 归一化（原地修改并返回）；零向量原样返回。 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) / norm;
  return vector;
}

/** 余弦相似度；长度不一致直接当 0（调用方本该先按模型身份和维度过滤）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32Array → 小端字节（存进 SQLite 的 embedding BLOB）。 */
export function vectorToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** SQLite 里读出来的字节 → Float32Array；长度不是 4 的倍数或对不上维度时返回 null。 */
export function bytesToVector(bytes: Uint8Array | null, dimensions: number): Float32Array | null {
  if (!bytes || bytes.byteLength !== dimensions * 4) return null;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const vector = new Float32Array(buffer);
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i] as number)) return null;
  }
  return vector;
}
