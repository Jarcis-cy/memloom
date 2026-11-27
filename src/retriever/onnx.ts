/**
 * 真实本地后端：Qwen3-Embedding-0.6B（last-token 池化 → 截断到 512 维 → L2 归一化）
 * + Qwen3-Reranker-0.6B（因果语言模型，读最后位置的 yes / no logits 做 softmax，得到 [0, 1] 相关性分）。
 *
 * 只有服务进程在拿到独占锁之后才会 import 这个文件；
 * onnxruntime-node 和 @huggingface/tokenizers 是可选依赖，用动态 import 加载，
 * 所以没装它们的机器照样能编译、能跑 fts-only / api 模式。
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIMENSIONS, localModelId, resolveLocalModels, type LocalModelFiles } from './modelid.js';
import type { RerankScore, ServiceBackend } from './service.js';
import { l2Normalize } from './types.js';

export const ORT_SPECIFIER = 'onnxruntime-node';
export const TOKENIZERS_SPECIFIER = '@huggingface/tokenizers';

/** 查询侧指令按 Qwen3-Embedding 的约定用英文写；文档侧不加指令。 */
export const QUERY_INSTRUCTION =
  'Given a user message in a work session, retrieve the working principles and experience notes that help handle it';
export const RERANK_INSTRUCTION =
  'Given a user message in a work session, retrieve the working principles and experience notes relevant to it';
const RERANK_SYSTEM =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';

const MAX_EMBED_TOKENS = 512;
const MAX_QUERY_CHARS = 400;
const MAX_DOCUMENT_CHARS = 600;
const MAX_TEXT_CHARS = 2_000;
const EOS_TOKEN = '<|endoftext|>';

export interface OnnxOptions {
  threads?: number;
  dimensions?: number;
}

/* ---------- 可选依赖的最小类型（不从不一定装了的包里引类型） ---------- */

interface OrtTensor {
  data: unknown;
  dims: readonly number[];
}

interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

interface OrtLike {
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: ArrayBufferView | unknown[], dims: number[]) => OrtTensor;
}

interface EncodingLike {
  ids: number[];
}

interface TokenizerLike {
  encode(text: string, options: { add_special_tokens?: boolean }): EncodingLike;
  token_to_id(token: string): number | undefined;
}

async function importOptional<T>(specifier: string, what: string): Promise<T> {
  try {
    // 说明：specifier 用变量，避免 TypeScript 在编译期去解析这两个可选包；没装它们的机器也要能编译
    return (await import(specifier)) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`本地模式需要可选依赖 ${specifier}（${what}），当前没有装或装坏了：${reason}`);
  }
}

/* ---------- 一次性推理需要的形状信息 ---------- */

interface CacheShape {
  layers: number;
  kvHeads: number;
  headDim: number;
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
}

function cacheShape(session: OrtSession, config: Record<string, unknown>): CacheShape | null {
  const kvInputs = session.inputNames.filter((name) => /^past_key_values\.\d+\.key$/.test(name));
  if (kvInputs.length === 0) return null;
  return {
    layers: kvInputs.length,
    kvHeads: Number(config.num_key_value_heads ?? 8),
    headDim: Number(config.head_dim ?? 128),
  };
}

function feedsFor(ort: OrtLike, shape: CacheShape | null, ids: number[]): Record<string, OrtTensor> {
  const big = (values: number[]): OrtTensor => new ort.Tensor('int64', BigInt64Array.from(values.map((value) => BigInt(value))), [1, values.length]);
  const feeds: Record<string, OrtTensor> = {
    input_ids: big(ids),
    attention_mask: big(ids.map(() => 1)),
    position_ids: big(ids.map((_, index) => index)),
  };
  if (shape) {
    const empty = (): OrtTensor => new ort.Tensor('float32', new Float32Array(0), [1, shape.kvHeads, 0, shape.headDim]);
    for (let layer = 0; layer < shape.layers; layer += 1) {
      feeds[`past_key_values.${layer}.key`] = empty();
      feeds[`past_key_values.${layer}.value`] = empty();
    }
  }
  return feeds;
}

function rowAt(tensor: OrtTensor, row: number, width: number): Float32Array {
  const data = tensor.data as ArrayLike<number> | Float32Array;
  const start = row * width;
  return Float32Array.from({ length: width }, (_, index) => Number(data[start + index]));
}

/* ---------- 加载 ---------- */

/** 串行跑推理：五个客户端同时来也不会同时开五个 60 MB 的 logits 张量。 */
function serialize(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };
}

export async function loadOnnxBackend(modelDir: string, options: OnnxOptions = {}): Promise<ServiceBackend> {
  const files: LocalModelFiles = resolveLocalModels(modelDir);
  const dimensions = options.dimensions ?? LOCAL_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions > 1024) {
    throw new Error(`向量维度只能是 32~1024 的整数，现在是 ${dimensions}`);
  }
  const threads = options.threads ?? Math.min(8, Math.max(1, availableParallelism()));

  const ort = await importOptional<OrtLike>(ORT_SPECIFIER, 'ONNX Runtime 原生运行时');
  const tokenizers = await importOptional<{ Tokenizer: new (json: unknown, config: unknown) => TokenizerLike }>(
    TOKENIZERS_SPECIFIER,
    '分词器',
  );
  const sessionOptions = { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' };

  const embeddingConfig = readConfig(files.embedding.dir);
  const tokenizerFor = (dir: string): TokenizerLike => new tokenizers.Tokenizer(JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')), {});
  const embeddingTokenizer = tokenizerFor(files.embedding.dir);
  const rerankerTokenizer = tokenizerFor(files.reranker.dir);
  const eosId = embeddingTokenizer.token_to_id(EOS_TOKEN);
  const yesId = rerankerTokenizer.token_to_id('yes');
  const noId = rerankerTokenizer.token_to_id('no');
  if (eosId === undefined || yesId === undefined || noId === undefined) {
    throw new Error('分词器里找不到 <|endoftext|> / yes / no 这几个token，模型文件可能不对');
  }

  const embeddingSession = await ort.InferenceSession.create(join(files.embedding.dir, files.embedding.file), sessionOptions);
  const rerankerSession = await ort.InferenceSession.create(join(files.reranker.dir, files.reranker.file), sessionOptions);
  const embeddingHidden = Number(embeddingConfig.hidden_size ?? 1024);
  if (dimensions > embeddingHidden) throw new Error(`模型只有 ${embeddingHidden} 维，截不到 ${dimensions} 维`);
  const embeddingCache = cacheShape(embeddingSession, embeddingConfig);
  const rerankerCache = cacheShape(rerankerSession, readConfig(files.reranker.dir));
  const serialized = serialize();

  const embedOne = async (text: string, mode: 'query' | 'document'): Promise<Float32Array> => {
    const body = text.slice(0, MAX_TEXT_CHARS);
    const input = mode === 'query' ? `Instruct: ${QUERY_INSTRUCTION}\nQuery:${body}` : body;
    const encoded = embeddingTokenizer.encode(input, { add_special_tokens: true }).ids;
    // Qwen3-Embedding 取最后一个 token 的隐状态；它的分词器会自动在结尾补 <|endoftext|>，这里再兜一次底
    let ids = encoded.length > MAX_EMBED_TOKENS ? [...encoded.slice(0, MAX_EMBED_TOKENS - 1), eosId] : encoded;
    if (ids[ids.length - 1] !== eosId) ids = [...ids, eosId];
    const output = await embeddingSession.run(feedsFor(ort, embeddingCache, ids));
    const hidden = output.last_hidden_state;
    if (!hidden) throw new Error('向量模型没有输出 last_hidden_state');
    const last = rowAt(hidden, ids.length - 1, embeddingHidden);
    return l2Normalize(last.slice(0, dimensions));
  };

  const scoreOne = async (query: string, document: string): Promise<number> => {
    const prompt =
      `<|im_start|>system\n${RERANK_SYSTEM}<|im_end|>\n` +
      `<|im_start|>user\n<Instruct>: ${RERANK_INSTRUCTION}\n\n<Query>: ${query.slice(0, MAX_QUERY_CHARS)}\n\n` +
      `<Document>: ${document.slice(0, MAX_DOCUMENT_CHARS)}<|im_end|>\n` +
      '<|im_start|>assistant\n<think>\n\n</think>\n';
    const ids = rerankerTokenizer.encode(prompt, { add_special_tokens: false }).ids;
    const output = await rerankerSession.run(feedsFor(ort, rerankerCache, ids));
    const logits = output.logits;
    if (!logits || logits.dims.length !== 3) throw new Error('精排模型没有输出三维 logits');
    const vocab = logits.dims[2] as number;
    const last = rowAt(logits, ids.length - 1, vocab);
    const yes = Math.exp(last[yesId] as number);
    const no = Math.exp(last[noId] as number);
    return yes / (yes + no);
  };

  const modelId = localModelId(files, dimensions);
  return {
    kind: 'onnx',
    modelId,
    dimensions,
    models: {
      embedding: {
        repo: files.embedding.manifest?.repo ?? null,
        revision: files.embedding.manifest?.revision ?? null,
        file: files.embedding.file,
      },
      reranker: {
        repo: files.reranker.manifest?.repo ?? null,
        revision: files.reranker.manifest?.revision ?? null,
        file: files.reranker.file,
      },
      threads,
      pooling: 'last_token',
      dimensions,
    },
    embed: (texts, mode) => serialized(async () => {
      const vectors: Float32Array[] = [];
      for (const text of texts) vectors.push(await embedOne(text, mode));
      return vectors;
    }),
    rerank: (query, documents, topK) => serialized(async () => {
      const hits: RerankScore[] = [];
      for (let index = 0; index < documents.length; index += 1) {
        hits.push({ index, score: await scoreOne(query, documents[index] as string) });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, topK);
    }),
  };
}
