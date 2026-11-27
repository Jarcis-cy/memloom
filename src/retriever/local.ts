/**
 * 本地模式的客户端：连共享 Unix socket 上的检索服务；服务不在就按需拉起（脱离父进程的守护进程）。
 *
 * 这个文件绝不在客户端进程里 import ONNX 运行时或模型：它只会 `node daemon.js <状态目录>` 另起一个进程。
 * 并发首启时几个客户端可能各拉起一个守护进程，守护进程之间靠独占锁决定谁加载模型，其余的不加载就退出。
 * 任何一步失败（缺模型、起不来、超时、回应坏掉、模型身份不一致）都抛 RetrieverUnavailable，由混合召回退回字面检索。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LOCAL_DIMENSIONS, resolveLocalModelId, resolveLocalModels } from './modelid.js';
import { ensureStateDir, statePaths, type StatePaths } from './paths.js';
import { MAX_TEXT_CHARS, MAX_TEXTS_PER_REQUEST, PROTOCOL_VERSION, encodeLine, parseResponseLine, type Request, type Response, type ServiceStatus } from './protocol.js';
import { DEFAULT_IDLE_MS, isProcessAlive, looksLikeDaemon, probeSocket, readLock } from './service.js';
import { RetrieverUnavailable, clampScore, l2Normalize, type RerankHit, type Retriever, type RetrieverHealth } from './types.js';

/** 编译后的守护进程入口，和这个客户端文件并排 */
export const DEFAULT_DAEMON_ENTRY = fileURLToPath(new URL('./daemon.js', import.meta.url));

export interface LocalRetrieverOptions {
  /** socket、锁、日志所在目录；只允许当前用户访问。测试和示例必须传临时目录 */
  stateDir: string;
  /** 模型目录，里面是 embedding/ 与 reranker/ */
  modelDir: string;
  /** 服务完全闲置多久退出，默认 10 分钟 */
  idleMs?: number;
  threads?: number;
  dimensions?: number;
  /** 等服务起来（含第一次加载模型）的上限，默认 120 秒 */
  startupTimeoutMs?: number;
  /** 服务就绪后单次请求的上限，默认 60 秒 */
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** 仅测试用：换成别的守护进程入口脚本（例如离线替身） */
  daemonEntry?: string;
  /** 仅测试用：拉起守护进程时额外塞的环境变量 */
  spawnEnv?: Record<string, string>;
}

interface LastError {
  pid: number;
  at: string;
  detail: string;
}

/** Request 是联合类型，去掉 id 要逐个成员去 */
type RequestWithoutId<T = Request> = T extends unknown ? Omit<T, 'id'> : never;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class LocalRetriever implements Retriever {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly paths: StatePaths;
  private readonly modelDir: string;
  private readonly idleMs: number;
  private readonly threads: number;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly daemonEntry: string;
  private readonly spawnEnv: Record<string, string> | undefined;
  /** 模型目录不完整时的原因；这种情况下 embed 直接抛不可用，连服务都不去拉 */
  private readonly unavailableReason: string | null;
  private requestId = 0;
  private spawnedAt = 0;
  private spawnBlockedUntil = 0;
  private lastSpawnFailure: string | null = null;
  /** 最近一次拉起的守护进程的异常退出（输掉锁正常退出 code 0 不算）；null 表示还没出事 */
  private lastChildCrash: { code: number | null; signal: string | null; detail: string } | null = null;
  /** 最近一次确认就绪的服务进程号 */
  private readyPid = 0;

  constructor(options: LocalRetrieverOptions) {
    this.dimensions = options.dimensions ?? LOCAL_DIMENSIONS;
    this.paths = statePaths(options.stateDir);
    this.modelDir = resolve(options.modelDir);
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.threads = options.threads ?? 0;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1_500;
    this.daemonEntry = options.daemonEntry ?? DEFAULT_DAEMON_ENTRY;
    this.spawnEnv = options.spawnEnv;
    if (process.platform === 'win32') {
      this.unavailableReason = '本地共享检索服务目前只在 Linux / macOS 的 Unix socket 上实现，Windows 还没有实测';
      this.modelId = `local-unavailable:${this.dimensions}`;
      return;
    }
    let reason: string | null = null;
    if (options.dimensions !== undefined && options.dimensions !== LOCAL_DIMENSIONS) {
      // 守护进程固定按 512 维（Matryoshka 截断）加载；别的维度现在不支持，直接说清楚并安全退回，不假装健康
      reason = `本地模型目前只支持 ${LOCAL_DIMENSIONS} 维，你配置的是 ${options.dimensions} 维；去掉 dimensions 或改成 ${LOCAL_DIMENSIONS}`;
    } else {
      try {
        resolveLocalModels(this.modelDir);
      } catch (error) {
        reason = messageOf(error);
      }
    }
    this.unavailableReason = reason;
    this.modelId = resolveLocalModelId(this.modelDir, this.dimensions) ?? `local-unavailable:${this.dimensions}`;
  }

  /* ---------- Retriever ---------- */

  async embed(texts: string[], mode: 'query' | 'document'): Promise<Float32Array[]> {
    this.assertUsable();
    this.assertTexts(texts);
    const result = (await this.request({ method: 'embed', params: { texts, mode } })) as {
      vectors: number[][];
      modelId: string;
      dimensions: number;
    };
    this.assertSameModel(result.modelId, result.dimensions);
    if (result.vectors.length !== texts.length) {
      throw new RetrieverUnavailable('bad_response', `服务返回了 ${result.vectors.length} 条向量，要的是 ${texts.length} 条`);
    }
    return result.vectors.map((vector) => {
      if (vector.length !== this.dimensions) throw new RetrieverUnavailable('bad_response', `服务返回的向量是 ${vector.length} 维，要的是 ${this.dimensions} 维`);
      return l2Normalize(Float32Array.from(vector));
    });
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    this.assertUsable();
    if (typeof query !== 'string' || query.length === 0 || query.length > MAX_TEXT_CHARS) {
      throw new RetrieverUnavailable('bad_params', 'rerank 的 query 必须是 1~8000 字的文本');
    }
    this.assertTexts(documents);
    if (!Number.isInteger(topK) || topK < 1) throw new RetrieverUnavailable('bad_params', 'rerank 的 topK 必须是正整数');
    const result = (await this.request({ method: 'rerank', params: { query, documents, topK: Math.min(topK, MAX_TEXTS_PER_REQUEST) } })) as {
      hits: RerankHit[];
    };
    return result.hits
      .filter((hit) => Number.isInteger(hit.index) && hit.index >= 0 && hit.index < documents.length)
      .map((hit) => ({ index: hit.index, score: clampScore(hit.score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** 只探测、不拉起：如实报告服务此刻的状态。 */
  async health(): Promise<RetrieverHealth> {
    if (this.unavailableReason) return { ok: false, mode: 'fts-only', detail: this.unavailableReason };
    try {
      const status = await this.fetchStatus();
      if (status.loading) return { ok: false, mode: 'local-onnx', detail: `共享检索服务 pid=${status.pid} 正在加载模型` };
      if (!status.loadedAt) return { ok: false, mode: 'local-onnx', detail: `共享检索服务 pid=${status.pid} 没有加载成模型` };
      if (status.modelId !== this.modelId || status.dimensions !== this.dimensions) {
        return {
          ok: false,
          mode: 'local-onnx',
          detail: `共享服务里的模型是 ${status.modelId}（${status.dimensions} 维），和本地模型目录算出来的 ${this.modelId}（${this.dimensions} 维）不一致，不能用；先停掉服务再试`,
        };
      }
      return {
        ok: true,
        mode: 'local-onnx',
        detail: `共享服务 pid=${status.pid}，模型 ${status.modelId}，驻留 ${(status.rssBytes / 1024 / 1024).toFixed(0)} MiB，完全闲置 ${Math.round(status.idleMs / 1000)} 秒后退出`,
      };
    } catch (error) {
      const holder = readLock(this.paths.lockPath);
      if (holder && isProcessAlive(holder.pid)) {
        return { ok: false, mode: 'local-onnx', detail: `共享检索服务 pid=${holder.pid} 正在启动或正忙（加载模型那几秒可能暂时不回应）` };
      }
      return {
        ok: false,
        mode: 'local-onnx',
        detail: `共享检索服务此刻没有在运行（${this.paths.socketPath}）；下一次检索会自动拉起（${messageOf(error)}）`,
      };
    }
  }

  /* ---------- 内部状态与安全停止（给 M3 的 daemon status / stop 用） ---------- */

  /** 只探测、不拉起：服务没在跑返回 null。 */
  async status(): Promise<ServiceStatus | null> {
    if (this.unavailableReason) return null;
    try {
      return await this.fetchStatus();
    } catch {
      return null;
    }
  }

  /** 按需拉起并等到模型就绪；返回服务状态。 */
  async warmup(): Promise<ServiceStatus> {
    this.assertUsable();
    return this.ensureReady();
  }

  /** 请求服务安全退出：在途请求做完就停，socket 和锁自己清掉。绝不杀进程。 */
  async stop(reason = '客户端请求停止'): Promise<{ running: boolean; stopped: boolean; pid: number | null }> {
    const status = await this.status();
    if (!status) return { running: false, stopped: false, pid: null };
    await this.roundTrip({ id: this.nextId(), method: 'stop', reason }, this.connectTimeoutMs * 4);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && isProcessAlive(status.pid)) await sleep(100);
    return { running: true, stopped: !isProcessAlive(status.pid), pid: status.pid };
  }

  /* ---------- 实现 ---------- */

  private assertUsable(): void {
    if (this.unavailableReason) throw new RetrieverUnavailable('model_missing', this.unavailableReason);
  }

  private assertTexts(texts: string[]): void {
    if (
      !Array.isArray(texts) ||
      texts.length === 0 ||
      texts.length > MAX_TEXTS_PER_REQUEST ||
      texts.some((text) => typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS)
    ) {
      throw new RetrieverUnavailable('bad_params', `每次 1~${MAX_TEXTS_PER_REQUEST} 条非空文本，每条不超过 ${MAX_TEXT_CHARS} 字`);
    }
  }

  private assertSameModel(modelId: string, dimensions: number): void {
    if (modelId !== this.modelId || dimensions !== this.dimensions) {
      throw new RetrieverUnavailable(
        'model_mismatch',
        `共享服务里的模型是 ${modelId}（${dimensions} 维），和本地模型目录算出来的 ${this.modelId}（${this.dimensions} 维）不一致；先 memloom daemon stop 再试`,
      );
    }
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private async request(request: RequestWithoutId): Promise<unknown> {
    const status = await this.ensureReady();
    this.assertSameModel(status.modelId, status.dimensions);
    const result = await this.roundTrip({ ...request, id: this.nextId() } as Request, this.requestTimeoutMs);
    return result;
  }

  private fetchStatus(): Promise<ServiceStatus> {
    return this.roundTrip({ id: this.nextId(), method: 'status' }, this.connectTimeoutMs) as Promise<ServiceStatus>;
  }

  /** 服务在跑且模型就绪就立刻返回；否则拉起（每个调用方最多拉一次）并轮询到就绪或超时。 */
  private async ensureReady(): Promise<ServiceStatus> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let spawned = false;
    let lastSeen = '';
    for (;;) {
      try {
        const status = await this.fetchStatus();
        if (status.protocolVersion !== PROTOCOL_VERSION) {
          throw new RetrieverUnavailable('protocol_mismatch', `共享服务协议版本是 ${status.protocolVersion}，这边只认 ${PROTOCOL_VERSION}`);
        }
        if (status.loadedAt && !status.loading) {
          this.readyPid = status.pid;
          return status;
        }
        lastSeen = status.loading ? `pid=${status.pid} 正在加载模型` : `pid=${status.pid} 没有加载成模型`;
      } catch (error) {
        lastSeen = messageOf(error);
      }
      // 守护进程在装载阶段异常退出（崩溃、被信号打死、spawn 失败）而没来得及写 last-error：
      // 真正退出了就马上在同一调用里报不可用，不再用剩余预算干等，短窗口内也不重复拉起
      const crash = this.readFreshChildCrash();
      if (crash) {
        this.spawnBlockedUntil = Date.now() + 30_000;
        this.lastSpawnFailure = crash.detail;
        throw new RetrieverUnavailable('start_failed', `共享检索服务启动阶段异常退出：${crash.detail}`);
      }
      const failure = this.readFreshFailure();
      if (failure) {
        this.spawnBlockedUntil = Date.now() + 30_000;
        this.lastSpawnFailure = failure.detail;
        throw new RetrieverUnavailable('start_failed', `共享检索服务起不来：${failure.detail}`);
      }
      if (Date.now() > deadline) {
        throw new RetrieverUnavailable('timeout', `等共享检索服务就绪超过 ${this.startupTimeoutMs} 毫秒（最后看到：${lastSeen}）`);
      }
      if (this.spawnBlockedUntil > Date.now()) {
        throw new RetrieverUnavailable('start_failed', `共享检索服务刚刚起不来（${this.lastSpawnFailure}），30 秒内不再重试`);
      }
      if (!spawned) {
        await this.spawnOnce();
        spawned = true;
      }
      await sleep(300);
    }
  }

  /** 本进程拉起的子进程的异常退出；输掉锁正常退出（code 0）和写明原因的加载失败（code 1，走 last-error）不算。 */
  private readFreshChildCrash(): { code: number | null; signal: string | null; detail: string } | null {
    const crash = this.lastChildCrash;
    this.lastChildCrash = null;
    if (!crash || this.spawnedAt === 0) return null;
    if (crash.code === 0 || crash.code === 1) return null;
    return crash;
  }

  /** 守护进程加载模型失败时会留下这个文件；比我们拉起它的时间新才算数。 */
  private readFreshFailure(): LastError | null {
    try {
      if (!existsSync(this.paths.lastErrorPath)) return null;
      if (this.spawnedAt === 0 || !existsSync(this.paths.lastErrorPath)) return null;
      const parsed = JSON.parse(readFileSync(this.paths.lastErrorPath, 'utf8')) as LastError;
      if (Date.parse(parsed.at) >= this.spawnedAt - 1_000 && typeof parsed.detail === 'string') return parsed;
    } catch {
      // 坏文件当没有
    }
    return null;
  }

  private async spawnOnce(): Promise<void> {
    const holder = readLock(this.paths.lockPath);
    if (holder && isProcessAlive(holder.pid) && (holder.entry === '' || looksLikeDaemon(holder.pid, holder.entry))) {
      // 已经有守护进程在起或在跑：不再多起一个，等它的 socket 就行
      return;
    }
    if (!existsSync(this.daemonEntry)) {
      throw new RetrieverUnavailable('daemon_missing', `找不到守护进程入口 ${this.daemonEntry}，请先 npm run build`);
    }
    ensureStateDir(this.paths.stateDir);
    const child = spawn(process.execPath, [this.daemonEntry, this.paths.stateDir], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        MEMLOOM_RETRIEVER_MODEL_DIR: this.modelDir,
        MEMLOOM_RETRIEVER_IDLE_MS: String(this.idleMs),
        ...(this.threads > 0 ? { MEMLOOM_RETRIEVER_THREADS: String(this.threads) } : {}),
        ...(this.spawnEnv ?? {}),
      },
    });
    // 脱离父进程：父进程退了服务继续留着给别人用；出错了也不会拖累调用方。
    // unref 只是 不替它撑住事件循环，退出事件照样收得到：这正是「装载阶段悄悄崩了」能被立刻发现的原因。
    child.unref();
    child.once('error', (error) => {
      this.lastChildCrash = { code: null, signal: null, detail: `拉不起进程：${messageOf(error)}` };
    });
    child.once('exit', (code, signal) => {
      if (code === 0 || code === 1) return;
      // 曾经就绪过、服务了一段时间才死的进程不算启动崩溃：那是正常的「按需再拉起」
      if (child.pid !== undefined && child.pid === this.readyPid) return;
      this.lastChildCrash = { code, signal, detail: signal ? `被信号 ${signal} 打死（退出码 ${String(code)}）` : `退出码 ${String(code)}，没有留下失败原因` };
    });
    this.spawnedAt = Date.now();
  }

  /** 一次连接一个请求：写一行 JSON，等一行 JSON。 */
  private roundTrip(request: Request, timeoutMs: number): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      if (!existsSync(this.paths.socketPath)) {
        reject(new RetrieverUnavailable('not_running', '共享检索服务没有在运行'));
        return;
      }
      const socket = createConnection(this.paths.socketPath);
      let settled = false;
      const fail = (code: string, message: string, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new RetrieverUnavailable(code, error ? `${message}：${messageOf(error)}` : message));
      };
      const timer = setTimeout(() => fail('timeout', `等共享检索服务回应超过 ${timeoutMs} 毫秒`), timeoutMs);
      socket.once('connect', () => socket.write(encodeLine(request)));
      socket.once('error', (error) => fail('connect_failed', `连不上共享检索服务 ${this.paths.socketPath}`, error));
      socket.once('close', () => fail('closed', '共享检索服务提前断开了连接'));
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      // readline 会把 socket 的错误再发一遍；socket 自己的 error 处理已经收尾了，这里只防漏到进程级
      lines.on('error', () => {});
      lines.on('line', (line) => {
        if (settled || line.trim() === '') return;
        let response: Response;
        try {
          response = parseResponseLine(line);
        } catch (error) {
          fail('bad_response', messageOf(error));
          return;
        }
        if (response.id !== request.id) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        socket.end();
        if (response.ok) resolvePromise(response.result);
        else reject(new RetrieverUnavailable(response.code, response.error));
      });
    });
  }
}

/** 探一下某个状态目录里的服务是否在跑（不拉起），给 doctor / daemon status 用。 */
export async function probeService(stateDir: string): Promise<{ running: boolean; socketPath: string; holderPid: number | null }> {
  const paths = statePaths(stateDir);
  const holder = readLock(paths.lockPath);
  const holderPid = holder && isProcessAlive(holder.pid) ? holder.pid : null;
  const probe = await probeSocket(paths.socketPath);
  return { running: probe === 'live', socketPath: paths.socketPath, holderPid };
}
