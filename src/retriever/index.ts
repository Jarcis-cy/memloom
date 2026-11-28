/**
 * memloom M2 检索底座的公开入口：按配置造检索器（local-onnx / api / fts-only / auto），混合召回，向量补建。
 * 这一层不碰 ~/.memloom：状态目录和模型目录都由调用方显式给；auto 模式不给才落到默认位置。
 *
 * auto（没配 API）和显式 local-onnx 两条路径都由一个极薄的 AutoRetriever 顶着：模型文件齐了就用共享的 LocalRetriever，
 * 没齐就先退回字面检索，并在真正要召回时拉起一次后台下载（不等网络）；同一个实例看到模型下完就自动切过去。
 * 已配置 API、fts-only、或关了自动下载（MEMLOOM_AUTO_DOWNLOAD=0 / autoDownload:false）的情况绝不联网。
 */
import { ApiRetriever, type ApiRetrieverOptions } from './api.js';
import { FtsOnlyRetriever } from './fts.js';
import { LocalRetriever, type LocalRetrieverOptions } from './local.js';
import { AutoRetriever } from './auto.js';
import { LOCAL_DIMENSIONS, localModelsPresent } from './modelid.js';
import { autoDownloadFromEnv } from './models.js';
import { defaultModelDir, defaultStateDir } from './paths.js';
import type { AutoDownloadConfig, AutoLocalOptions } from './auto.js';
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
export { inspectLocalModel, LOCAL_DIMENSIONS, localModelsPresent, resolveLocalModelId, resolveLocalModels } from './modelid.js';
export type { LocalModelFiles, LocalModelStatus, ManifestFile, ModelKind, ModelManifest } from './modelid.js';
export { defaultModelDir, defaultStateDir, modelDownloadPaths, statePaths } from './paths.js';
export type { ModelDownloadPaths } from './paths.js';
export {
  DEFAULT_CLI_ENTRY,
  DEFAULT_RETRY_BACKOFF_MS,
  MAX_TOTAL_BYTES,
  OFFICIAL_ENDPOINT,
  acquireDownloadLock,
  autoDownloadBlockReason,
  autoDownloadFromEnv,
  describeDownloadProgress,
  isLoopbackHost,
  modelDownloadStatus,
  normalizeEndpoint,
  planModelDownload,
  readDownloadLock,
  readDownloadState,
  resolveEndpoint,
  runModelDownload,
  spawnBackgroundDownload,
} from './models.js';
export type {
  DownloadBlock,
  DownloadLock,
  DownloadPlan,
  DownloadProgress,
  DownloadResult,
  DownloadRunOptions,
  DownloadStateRecord,
  DownloadStatusView,
  ModelDownloadStatus,
  ModelKindStatus,
} from './models.js';
export { PINNED_MODELS, SMALL_FILES } from './models-manifest.js';
export type { PinnedFile, PinnedModel, PinnedModels } from './models-manifest.js';

export { AutoRetriever, prepareHostRetriever, prepareRetriever } from './auto.js';
export type { AutoDownloadConfig, AutoLocalOptions, DownloadTrigger, LocalTestOptions, PreparedRetriever } from './auto.js';

export type LocalRetrieverConfig = Omit<LocalRetrieverOptions, 'daemonEntry' | 'spawnEnv'>;
export type ApiRetrieverConfig = ApiRetrieverOptions;
export type FtsRetrieverConfig = { reason?: string };

export type RetrieverConfig =
  | ({ mode: 'local-onnx' } & LocalRetrieverConfig & AutoDownloadConfig)
  | ({ mode: 'api' } & ApiRetrieverConfig)
  | ({ mode: 'fts-only' } & FtsRetrieverConfig)
  | ({
      /** 有本地模型就用本地（没有就后台下载、先字面检索），否则配了 API 就用 API，否则 fts-only */
      mode: 'auto';
      stateDir?: string;
      modelDir?: string;
      local?: AutoLocalOptions;
      api?: ApiRetrieverConfig;
    } & AutoDownloadConfig);

/** 当前配置对应的模型目录：local-onnx 用它自己给的，auto 用 MEMLOOM_MODEL_DIR 或 <状态目录>/models。 */
export function modelDirOf(config: RetrieverConfig, fallbackStateDir: string): string {
  switch (config.mode) {
    case 'local-onnx':
      return config.modelDir;
    case 'auto':
      return config.modelDir ?? defaultModelDir(config.stateDir ?? fallbackStateDir);
    default:
      return defaultModelDir(fallbackStateDir);
  }
}

/**
 * 自动下载在这个配置下是否生效：只有 auto / local-onnx 两档会缺模型下载，api 和 fts-only 永远不下载。
 * 配置里 autoDownload:false 优先，其次 MEMLOOM_AUTO_DOWNLOAD=0，默认开启。
 */
export function autoDownloadOf(config: RetrieverConfig, env: NodeJS.ProcessEnv = process.env): { enabled: boolean; note: string } {
  switch (config.mode) {
    case 'local-onnx':
    case 'auto': {
      if (config.autoDownload === false) return { enabled: false, note: '代码里 autoDownload:false：缺模型也不联网' };
      if (config.autoDownload === true || autoDownloadFromEnv(env)) return { enabled: true, note: '缺模型时在后台自动下载（MEMLOOM_AUTO_DOWNLOAD=0 可关）' };
      return { enabled: false, note: 'MEMLOOM_AUTO_DOWNLOAD=0：缺模型也不联网；需要时手动运行 memloom models download' };
    }
    case 'api':
      return { enabled: false, note: '当前是 api 模式，用远端模型，不下载本地模型' };
    case 'fts-only':
      return { enabled: false, note: '当前是 fts-only 模式，不会自动下载' };
  }
}

/**
 * 按配置造检索器。local-onnx 缺模型目录不在这里抛：返回的检索器 embed 会抛「不可用」，由混合召回退回字面检索。
 */
export function createRetriever(config: RetrieverConfig): Retriever {
  switch (config.mode) {
    case 'local-onnx': {
      const { mode, autoDownload, mirror, stateDir, modelDir, ...rest } = config;
      return new AutoRetriever({ stateDir, modelDir, local: rest, autoDownload, mirror });
    }
    case 'api':
      return new ApiRetriever(config);
    case 'fts-only':
      return new FtsOnlyRetriever(config.reason);
    case 'auto': {
      const stateDir = config.stateDir ?? defaultStateDir();
      const modelDir = config.modelDir ?? defaultModelDir(stateDir);
      if (localModelsPresent(modelDir)) return new LocalRetriever({ stateDir, modelDir, ...(config.local ?? {}) });
      // 配了 API 就用 API：这条路径从不自动下载本地模型
      if (config.api) return new ApiRetriever(config.api);
      return new AutoRetriever({ stateDir, modelDir, local: config.local, autoDownload: config.autoDownload, mirror: config.mirror });
    }
    default:
      throw new Error(`不认识的检索模式：${String((config as { mode?: unknown }).mode)}`);
  }
}

/**
 * 从环境变量读配置（M3 的 CLI 会读同一套）：
 * MEMLOOM_RETRIEVER_MODE（local-onnx / api / fts-only，不写就是 auto）、MEMLOOM_STATE_DIR、MEMLOOM_MODEL_DIR、
 * MEMLOOM_RETRIEVER_IDLE_MS、MEMLOOM_API_BASE_URL、MEMLOOM_EMBED_MODEL、MEMLOOM_RERANK_MODEL、
 * MEMLOOM_EMBED_DIMENSIONS、MEMLOOM_API_KEY（凭据只在内存里，不要写进任何日志）、
 * MEMLOOM_AUTO_DOWNLOAD（=0 关闭自动下载）、MEMLOOM_HF_ENDPOINT / HF_ENDPOINT（模型镜像源，--mirror 优先）。
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
  // autoDownload 不在这里定：配置里没写就看 MEMLOOM_AUTO_DOWNLOAD（AutoRetriever 和 autoDownloadOf 都这么判）
  const download = { mirror: mirrorFromEnv(env) };
  if (mode === 'local-onnx') {
    if (!stateDir || !modelDir) throw new Error('MEMLOOM_RETRIEVER_MODE=local-onnx 时必须给 MEMLOOM_STATE_DIR 和 MEMLOOM_MODEL_DIR');
    return { mode: 'local-onnx', stateDir, modelDir, idleMs: idleFromEnv(env), ...download };
  }
  if (mode && mode !== 'auto') throw new Error(`不认识的 MEMLOOM_RETRIEVER_MODE：${mode}`);
  return { mode: 'auto', stateDir, modelDir, api: apiFromEnv(env) ?? undefined, ...download };
}

function idleFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const value = Number(env.MEMLOOM_RETRIEVER_IDLE_MS);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 镜像源原样带回（MEMLOOM_HF_ENDPOINT 优先于 HF_ENDPOINT）；合法性在真正要用它时才检查，不让一个写错的地址拖垮所有命令。 */
function mirrorFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return (env.MEMLOOM_HF_ENDPOINT ?? '').trim() || (env.HF_ENDPOINT ?? '').trim() || undefined;
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
