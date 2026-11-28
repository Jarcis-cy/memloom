/**
 * 极薄的 auto / local-onnx 检索器（返工方案 §3.2 第 3 点）：一份实例顶「缺模型 → 字面检索 + 后台下载 → 下完自动切语义检索」整个过程。
 *
 * - 模型文件齐了（resolveLocalModels 的文件级检查，微秒级）就懒创建 LocalRetriever，连的是同一个状态目录的共享服务；
 *   维度和 modelId 永远跟真实的 delegate 走，存量向量按它的 modelId 过滤，不会和别的模型混比；
 * - 没齐时 embed / rerank 直接抛不可用，混合召回退回字面检索，字面分不冒充精排分；
 * - 只在 prepare()（真正要召回 / 建向量之前的显式预检，以及宿主 session_start 的那一次）里拉起后台下载：
 *   不等网络、同一实例 10 秒内不重复拉、别的进程在下载（活锁）不抢、失败或中断在退避期内不反复拉；
 *   health() 这类「看状态」的入口从不拉起任何进程，所以 doctor / models status 永远不联网。
 * - 已配置 API、fts-only、或关了自动下载（MEMLOOM_AUTO_DOWNLOAD=0 / autoDownload:false）的情况绝不联网。
 */
import { FtsOnlyRetriever } from './fts.js';
import { LocalRetriever, type LocalRetrieverOptions } from './local.js';
import { localModelsPresent } from './modelid.js';
import { autoDownloadBlockReason, autoDownloadFromEnv, resolveEndpoint, spawnBackgroundDownload } from './models.js';
import { RetrieverUnavailable, type RerankHit, type Retriever, type RetrieverHealth } from './types.js';

/** 自动下载开关和镜像源：代码里 autoDownload:false 等同于 MEMLOOM_AUTO_DOWNLOAD=0 */
export interface AutoDownloadConfig {
  /** 默认 true；false = 缺模型也不联网，只退回字面检索 */
  autoDownload?: boolean;
  /** 镜像源，优先级高于 MEMLOOM_HF_ENDPOINT / HF_ENDPOINT；只接受 https://（回环测试可 http） */
  mirror?: string;
}

/** 测试可以注入的本地客户端选项（离线替身守护进程的入口和环境） */
export type LocalTestOptions = Pick<LocalRetrieverOptions, 'daemonEntry' | 'spawnEnv'>;
export type AutoLocalOptions = Pick<LocalRetrieverOptions, 'idleMs' | 'threads' | 'dimensions' | 'startupTimeoutMs' | 'requestTimeoutMs'> & LocalTestOptions;

/** 缺模型时这一轮拉起了什么：spawned = 刚拉起后台下载；coalesced = 已有下载在跑；skipped = 退避期 / 镜像地址无效 / 拉不起来 */
export type DownloadTrigger = { state: 'spawned' | 'coalesced' | 'skipped'; reason?: string };

export interface PreparedRetriever {
  /** 这一轮真正干活的检索器（已经切到本地模型时就是 LocalRetriever，否则是字面检索） */
  retriever: Retriever;
  /** null = 模型已就绪，或自动下载关着，什么都不用说 */
  download: DownloadTrigger | null;
}

const SPAWN_SETTLE_MS = 10_000;
const SPAWN_FAILURE_BLOCK_MS = 30_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutoRetriever implements Retriever {
  private readonly fts: FtsOnlyRetriever;
  private local: LocalRetriever | null = null;
  private readonly stateDir: string;
  private readonly modelDir: string;
  private readonly localOptions: AutoLocalOptions;
  private readonly autoDownload: boolean;
  private readonly mirror: string | undefined;
  private readonly cliEntry: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private log: (line: string) => void;
  private lastSpawnAt = 0;
  private spawnBlockedUntil = 0;

  constructor(options: {
    stateDir: string;
    modelDir: string;
    local?: AutoLocalOptions;
    autoDownload?: boolean;
    mirror?: string;
    /** 仅测试：换命令行入口 */
    cliEntry?: string;
    /** 仅测试：后台进程继承的环境 */
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    reason?: string;
  }) {
    this.stateDir = options.stateDir;
    this.modelDir = options.modelDir;
    this.localOptions = options.local ?? {};
    this.autoDownload = options.autoDownload ?? autoDownloadFromEnv(options.env ?? process.env);
    this.mirror = options.mirror;
    this.cliEntry = options.cliEntry;
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.fts = new FtsOnlyRetriever(options.reason ?? `本地模型目录「${this.modelDir}」还没有下齐（需要 embedding/ 与 reranker/ 各自的 tokenizer.json、config.json 和 onnx/ 模型文件）；当前只做字面检索`);
    this.syncLocal();
  }

  get modelId(): string {
    this.syncLocal();
    return this.current().modelId;
  }

  get dimensions(): number {
    this.syncLocal();
    return this.current().dimensions;
  }

  /** 模型文件齐了就懒创建一次 LocalRetriever（之后一直复用它，它连的是全机共享的那一个服务） */
  private syncLocal(): void {
    if (this.local) return;
    if (!localModelsPresent(this.modelDir)) return;
    try {
      this.local = new LocalRetriever({ stateDir: this.stateDir, modelDir: this.modelDir, ...this.localOptions });
      this.log(`本地模型已就绪（${this.local.modelId}），检索切换到本地语义模式`);
    } catch (error) {
      this.log(`本地模型文件齐了但造不出检索客户端：${messageOf(error)}`);
    }
  }

  private current(): Retriever {
    return this.local ?? this.fts;
  }

  /** 真正要召回 / 建向量之前的显式预检：齐了就切；没齐且允许自动下载就拉起一次后台下载（不等网络），本轮照常字面检索。 */
  prepare(): PreparedRetriever {
    this.syncLocal();
    if (this.local) return { retriever: this.local, download: null };
    if (!this.autoDownload) return { retriever: this.fts, download: null };
    return { retriever: this.fts, download: this.maybeStartDownload() };
  }

  private maybeStartDownload(): DownloadTrigger | null {
    const now = Date.now();
    if (now < this.spawnBlockedUntil) return null;
    if (now - this.lastSpawnAt < SPAWN_SETTLE_MS) return null;
    let endpoint: string;
    try {
      endpoint = resolveEndpoint(this.env, this.mirror);
    } catch (error) {
      this.spawnBlockedUntil = now + SPAWN_FAILURE_BLOCK_MS;
      const reason = `镜像源地址无效，不会自动下载：${messageOf(error)}`;
      this.log(reason);
      return { state: 'skipped', reason };
    }
    const blocked = autoDownloadBlockReason({ modelDir: this.modelDir, stateDir: this.stateDir, now });
    if (blocked) {
      this.log(`不拉起后台下载：${blocked.reason}`);
      return { state: blocked.kind === 'lock' ? 'coalesced' : 'skipped', reason: blocked.reason };
    }
    const spawned = spawnBackgroundDownload({
      stateDir: this.stateDir,
      modelDir: this.modelDir,
      endpoint,
      cliEntry: this.cliEntry,
      env: this.env,
      onError: (message) => {
        this.spawnBlockedUntil = Date.now() + SPAWN_FAILURE_BLOCK_MS;
        this.log(`后台下载进程出错：${message}`);
      },
      onExit: ({ code }) => {
        if (code !== 0 && code !== null) this.log(`后台下载进程以退出码 ${String(code)} 结束；原因看 memloom models status`);
      },
    });
    if (spawned.pid === null) {
      this.spawnBlockedUntil = now + SPAWN_FAILURE_BLOCK_MS;
      this.log(spawned.reason);
      return { state: 'skipped', reason: `${spawned.reason}；这次只做字面检索` };
    }
    this.lastSpawnAt = now;
    this.log(`已在后台拉起模型下载（pid=${String(spawned.pid)}）；本轮先用字面检索，下完自动切过去`);
    return { state: 'spawned', reason: '本地语义模型正在后台下载，当前先用字面检索，下完自动切过去' };
  }

  /** 宿主把自己的日志接进来（切换、拉起下载、失败原因都记一行）；不给就静默 */
  setLog(log: (line: string) => void): void {
    this.log = log;
  }

  /** 真实召回路径：这一轮用 prepare() 定下的检索器，整次调用不换人 */
  async embed(texts: string[], mode: 'query' | 'document'): Promise<Float32Array[]> {
    const { retriever } = this.prepare();
    return retriever.embed(texts, mode);
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    const { retriever } = this.prepare();
    return retriever.rerank(query, documents, topK);
  }

  /** 只看状态、不拉起任何进程；模型已经下齐时如实报告本地模式。 */
  async health(): Promise<RetrieverHealth> {
    this.syncLocal();
    return this.current().health();
  }

  /** 会话开始时的预热：模型没齐就直接说不可用，不去等下载。 */
  async warmup(): Promise<{ modelId: string }> {
    this.syncLocal();
    if (!this.local) throw new RetrieverUnavailable('model_missing', '本地模型还没下齐，不能预热');
    return this.local.warmup();
  }
}

/** 混合召回和向量补建入口的统一预检：AutoRetriever 借此切换 / 拉起下载，别的检索器原样返回。 */
export function prepareRetriever(retriever: Retriever): Retriever {
  if (retriever instanceof AutoRetriever) return retriever.prepare().retriever;
  return retriever;
}

/** 宿主 session_start 的那一次显式预检：同一份回执里说明这一轮有没有拉起后台下载。 */
export function prepareHostRetriever(retriever: Retriever): PreparedRetriever {
  if (retriever instanceof AutoRetriever) return retriever.prepare();
  return { retriever, download: null };
}
