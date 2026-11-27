/**
 * 共享检索服务的线路协议：一行一个 JSON 请求，一行一个 JSON 回应。
 * 客户端、真实守护进程、测试用的替身守护进程都只用这一套消息。
 * 协议里只有 embed / rerank / status / stop 四种方法，没有任何执行外部命令的入口。
 */

export const PROTOCOL_VERSION = 1;

/** 单次请求的硬上限，超过直接拒绝，防止把整库经历一次性塞给模型。 */
export const MAX_TEXTS_PER_REQUEST = 64;
export const MAX_TEXT_CHARS = 8_000;

export interface EmbedParams {
  texts: string[];
  mode: 'query' | 'document';
}

export interface RerankParams {
  query: string;
  documents: string[];
  topK: number;
}

export type Request =
  | { id: number; method: 'embed'; params: EmbedParams }
  | { id: number; method: 'rerank'; params: RerankParams }
  | { id: number; method: 'status' }
  | { id: number; method: 'stop'; reason?: string };

export interface ServiceStatus {
  protocolVersion: number;
  pid: number;
  /** 后端类型：onnx = 真实本地模型，stub = 测试替身 */
  backend: 'onnx' | 'stub';
  modelId: string;
  dimensions: number;
  stateDir: string;
  modelDir: string;
  startedAt: string;
  loadedAt: string | null;
  loading: boolean;
  inFlight: number;
  requestsServed: number;
  lastActivityAt: string;
  idleMs: number;
  rssBytes: number;
  nodeVersion: string;
  /** 模型文件与 revision 等取证信息（不含任何凭据） */
  models: Record<string, unknown>;
}

export type EmbedResult = { vectors: Array<Array<number>>; modelId: string; dimensions: number };
export type RerankResult = { hits: Array<{ index: number; score: number }> };
export type StopResult = { stopping: true };
export type ResponseResult = EmbedResult | RerankResult | ServiceStatus | StopResult;

export type Response =
  | { id: number; ok: true; result: ResponseResult }
  | { id: number; ok: false; code: string; error: string };

export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** 解析一行回应；坏行当协议错误抛出，由调用方转成「不可用」。 */
export function parseResponseLine(line: string): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('检索服务返回的不是 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { id?: unknown }).id !== 'number') {
    throw new Error('检索服务回应格式不对');
  }
  return parsed as Response;
}

export function protocolError(code: string, error: string): Response {
  return { id: -1, ok: false, code, error };
}
