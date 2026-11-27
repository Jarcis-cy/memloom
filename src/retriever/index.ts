/**
 * memloom M2 检索底座的公开入口：按配置造检索器（local-onnx / api / fts-only / auto），混合召回，向量补建。
 * 这一层不碰 ~/.memloom：状态目录和模型目录都由调用方显式给；auto 模式不给才落到默认位置。
 */
import { ApiRetriever, type ApiRetrieverOptions } from './api.js';
import { FtsOnlyRetriever } from './fts.js';
import { LocalRetriever, type LocalRetrieverOptions } from './local.js';
import { LOCAL_DIMENSIONS, localModelsPresent } from './modelid.js';
import { defaultModelDir, defaultStateDir } from './paths.js';
import type { Retriever } from './types.js';

export { RetrieverUnavailable, bytesToVector, clampScore, cosine, l2Normalize, vectorToBytes } from './types.js';
export type { RerankHit, Retriever, RetrieverHealth, RetrieverMode } from './types.js';
export { ApiRetriever } from './api.js';
export type { ApiRetrieverOptions } from './api.js';
export { FtsOnlyRetriever, FTS_MODEL_ID } from './fts.js';
export { DEFAULT_DAEMON_ENTRY, LocalRetriever, probeService } from './local.js';
export type { LocalRetrieverOptions } from './local.js';
export { DEFAULT_IDLE_MS, probeSocket, runService } from './service.js';
export type { RerankScore, ServiceBackend, ServiceExit, ServiceOptions } from './service.js';
export { PROTOCOL_VERSION } from './protocol.js';
export type { Request, Response, ServiceStatus } from './protocol.js';
export {
  HINT_DEFAULTS,
  INDEX_DEFAULTS,
  RECALL_DEFAULTS,
  formatHintBlock,
  hintLine,
  hybridRecall,
  indexVectors,
  pickHints,
  rebuildVectors,
} from './hybrid.js';
export type {
  HintOptions,
  HybridRecallOptions,
  HybridRecallResult,
  IndexOptions,
  IndexResult,
  RecallItem,
  RecallMode,
  RecallType,
} from './hybrid.js';
export { LOCAL_DIMENSIONS, localModelsPresent, resolveLocalModelId } from './modelid.js';
export { defaultModelDir, defaultStateDir, statePaths } from './paths.js';

export type LocalRetrieverConfig = Omit<LocalRetrieverOptions, 'daemonEntry' | 'spawnEnv'>;
export type ApiRetrieverConfig = ApiRetrieverOptions;
export type FtsRetrieverConfig = { reason?: string };

export type RetrieverConfig =
  | ({ mode: 'local-onnx' } & LocalRetrieverConfig)
  | ({ mode: 'api' } & ApiRetrieverConfig)
  | ({ mode: 'fts-only' } & FtsRetrieverConfig)
  | {
      /** 有本地模型就用本地，否则配了 API 就用 API，否则 fts-only */
      mode: 'auto';
      stateDir?: string;
      modelDir?: string;
      local?: Pick<LocalRetrieverOptions, 'idleMs' | 'threads' | 'dimensions' | 'startupTimeoutMs' | 'requestTimeoutMs'>;
      api?: ApiRetrieverConfig;
    };

/**
 * 按配置造检索器。local-onnx 缺模型目录不在这里抛：返回的检索器 embed 会抛「不可用」，由混合召回退回字面检索。
 */
export function createRetriever(config: RetrieverConfig): Retriever {
  switch (config.mode) {
    case 'local-onnx':
      return new LocalRetriever(config);
    case 'api':
      return new ApiRetriever(config);
    case 'fts-only':
      return new FtsOnlyRetriever(config.reason);
    case 'auto': {
      const stateDir = config.stateDir ?? defaultStateDir();
      const modelDir = config.modelDir ?? defaultModelDir(stateDir);
      if (localModelsPresent(modelDir)) return new LocalRetriever({ stateDir, modelDir, ...(config.local ?? {}) });
      if (config.api) return new ApiRetriever(config.api);
      return new FtsOnlyRetriever(`没有找到本地模型目录「${modelDir}」（需要 embedding/ 与 reranker/），也没有配置 API；只做字面检索`);
    }
    default:
      throw new Error(`不认识的检索模式：${String((config as { mode?: unknown }).mode)}`);
  }
}

/**
 * 从环境变量读配置（M3 的 CLI 会读同一套）：
 * MEMLOOM_RETRIEVER_MODE（local-onnx / api / fts-only，不写就是 auto）、MEMLOOM_STATE_DIR、MEMLOOM_MODEL_DIR、
 * MEMLOOM_RETRIEVER_IDLE_MS、MEMLOOM_API_BASE_URL、MEMLOOM_EMBED_MODEL、MEMLOOM_RERANK_MODEL、
 * MEMLOOM_EMBED_DIMENSIONS、MEMLOOM_API_KEY（凭据只在内存里，不要写进任何日志）。
 */
export function retrieverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetrieverConfig {
  const mode = env.MEMLOOM_RETRIEVER_MODE;
  if (mode === 'fts-only') return { mode: 'fts-only' };
  if (mode === 'api') {
    const api = apiFromEnv(env);
    if (!api) throw new Error('MEMLOOM_RETRIEVER_MODE=api 时必须给 MEMLOOM_API_BASE_URL、MEMLOOM_EMBED_MODEL 和 MEMLOOM_RERANK_MODEL');
    return api;
  }
  const stateDir = env.MEMLOOM_STATE_DIR;
  const modelDir = env.MEMLOOM_MODEL_DIR;
  if (mode === 'local-onnx') {
    if (!stateDir || !modelDir) throw new Error('MEMLOOM_RETRIEVER_MODE=local-onnx 时必须给 MEMLOOM_STATE_DIR 和 MEMLOOM_MODEL_DIR');
    return { mode: 'local-onnx', stateDir, modelDir, idleMs: idleFromEnv(env) };
  }
  if (mode && mode !== 'auto') throw new Error(`不认识的 MEMLOOM_RETRIEVER_MODE：${mode}`);
  return { mode: 'auto', stateDir, modelDir, api: apiFromEnv(env) ?? undefined };
}

function idleFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const value = Number(env.MEMLOOM_RETRIEVER_IDLE_MS);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function apiFromEnv(env: NodeJS.ProcessEnv): Extract<RetrieverConfig, { mode: 'api' }> | null {
  if (!env.MEMLOOM_API_BASE_URL) return null;
  return {
    mode: 'api',
    baseUrl: env.MEMLOOM_API_BASE_URL,
    embedModel: env.MEMLOOM_EMBED_MODEL ?? '',
    rerankModel: env.MEMLOOM_RERANK_MODEL ?? '',
    apiKey: env.MEMLOOM_API_KEY,
    dimensions: Number(env.MEMLOOM_EMBED_DIMENSIONS ?? LOCAL_DIMENSIONS),
  };
}
