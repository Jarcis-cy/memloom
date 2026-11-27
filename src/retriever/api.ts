/**
 * API 模式（架构规格 §3.2 第 2 档）：显式配置 base URL 才启用，对齐 OpenAI 兼容的 /embeddings
 * 与 /rerank（SiliconFlow / Jina / Cohere 风格）JSON。
 *
 * 凭据只从调用方的内存配置来，不写日志、不进 health、不出现在报错里；
 * 请求顺序与下标、模型身份与维度、超时和坏响应都逐项校验，任何不对都抛 RetrieverUnavailable，由混合召回退回字面检索。
 */
import { RetrieverUnavailable, clampScore, l2Normalize, type RerankHit, type Retriever, type RetrieverHealth } from './types.js';

export interface ApiRetrieverOptions {
  /** 完整前缀，含 /v1，例如 https://api.siliconflow.cn/v1 */
  baseUrl: string;
  /** 例如 Qwen/Qwen3-Embedding-0.6B 或 text-embedding-3-small */
  embedModel: string;
  /** 例如 Qwen/Qwen3-Reranker-0.6B */
  rerankModel: string;
  /** 只放内存；不给就不带 Authorization 头 */
  apiKey?: string;
  /** 向量维度：作为 dimensions 参数发给服务端并截断；存量向量靠它保证可比 */
  dimensions: number;
  timeoutMs?: number;
  /** 可注入的 fetch（测试用回环服务） */
  fetchImpl?: typeof fetch;
  /** query 侧指令前缀（有的服务要求 query 带指令） */
  queryInstruction?: string;
}

function baseUrlOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`API base URL 不合法：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`API base URL 只支持 http / https：${value}`);
  return value.replace(/\/+$/, '');
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

function bodySnippet(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

export class ApiRetriever implements Retriever {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly rerankModel: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly queryInstruction: string | undefined;

  constructor(options: ApiRetrieverOptions) {
    if (!options.baseUrl) throw new Error('API 模式必须显式给出 base URL（含 /v1）');
    if (!options.embedModel || !options.rerankModel) throw new Error('API 模式必须显式给出向量模型和精排模型的名字');
    this.baseUrl = baseUrlOf(options.baseUrl);
    this.embedModel = options.embedModel;
    this.rerankModel = options.rerankModel;
    this.apiKey = options.apiKey && options.apiKey.trim() !== '' ? options.apiKey.trim() : undefined;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.queryInstruction = options.queryInstruction;
    // 向量身份 = 服务地址 + 模型名 + 维度；换了任何一项，库里的旧向量都不再拿来比
    this.modelId = `api:${hostOf(this.baseUrl)}:${this.embedModel}:${options.dimensions}`;
    if (!Number.isInteger(options.dimensions) || options.dimensions < 32 || options.dimensions > 4096) throw new Error('API 模式必须给出 32~4096 的整数维度');
    this.dimensions = options.dimensions;
  }

  async embed(texts: string[], mode: 'query' | 'document'): Promise<Float32Array[]> {
    const input = texts.map((text) => (mode === 'query' && this.queryInstruction ? `${this.queryInstruction}${text}` : text));
    const body: Record<string, unknown> = { model: this.embedModel, input, encoding_format: 'float' };
    body.dimensions = this.dimensions;
    const json = (await this.post('/embeddings', body)) as { data?: unknown };
    if (!json || !Array.isArray(json.data)) throw this.fail('bad_response', '/embeddings 没有返回 data 数组');
    const rows = json.data as Array<Record<string, unknown>>;
    if (rows.length !== texts.length) throw this.fail('bad_response', `/embeddings 返回了 ${rows.length} 条向量，要的是 ${texts.length} 条`);
    // 服务端可能乱序返回：严格按 index 排回请求顺序
    const ordered = [...rows].sort((a, b) => Number(a.index) - Number(b.index));
    return ordered.map((row, position) => {
      if (Number(row.index) !== position) throw this.fail('bad_response', `/embeddings 的 index 对不上请求顺序（第 ${position} 条是 ${String(row.index)}）`);
      const vector = row.embedding;
      if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw this.fail('bad_response', `/embeddings 第 ${position} 条向量不是数字数组`);
      }
      let result = Float32Array.from(vector as number[]);
      if (result.length < this.dimensions) throw this.fail('bad_response', `/embeddings 只返回 ${result.length} 维，不到要求的 ${this.dimensions} 维`);
      // 服务端没理会 dimensions 参数时按 Matryoshka 截断，再归一化一次
      if (result.length > this.dimensions) result = result.slice(0, this.dimensions);
      return l2Normalize(result);
    });
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    const json = (await this.post('/rerank', {
      model: this.rerankModel,
      query,
      documents,
      top_n: Math.min(topK, documents.length),
      return_documents: false,
    })) as { results?: unknown };
    if (!json || !Array.isArray(json.results)) throw this.fail('bad_response', '/rerank 没有返回 results 数组');
    const hits = (json.results as Array<Record<string, unknown>>).map((row) => {
      const index = row.index;
      const raw = row.relevance_score ?? row.score;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= documents.length) {
        throw this.fail('bad_response', `/rerank 返回的下标不合法：${String(index)}`);
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw this.fail('bad_response', '/rerank 返回的分数不是数字');
      return { index: index as number, score: clampScore(raw) };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** 不发请求：只报告配置。ok 表示配置齐全，不代表此刻网络可用。 */
  health(): Promise<RetrieverHealth> {
    return Promise.resolve({
      ok: true,
      mode: 'api',
      detail: `API 模式：${hostOf(this.baseUrl)}，向量模型 ${this.embedModel}，精排模型 ${this.rerankModel}${this.apiKey ? '，已带凭据' : '，未带凭据'}（未发请求验证）`,
    });
  }

  private fail(code: string, message: string): RetrieverUnavailable {
    return new RetrieverUnavailable(code, message);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = reason.toLowerCase().includes('abort') || reason.toLowerCase().includes('timeout') ? 'timeout' : 'network';
      throw this.fail(code, `请求 ${hostOf(this.baseUrl)}${path} 失败：${reason}`);
    }
    const text = await response.text();
    if (!response.ok) throw this.fail('http_error', `${hostOf(this.baseUrl)}${path} 返回 HTTP ${response.status}：${bodySnippet(text)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw this.fail('bad_response', `${hostOf(this.baseUrl)}${path} 返回的不是 JSON`);
    }
  }
}
