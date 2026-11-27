/**
 * fts-only：没有语义能力时的保底实现（架构规格 §3.2 第 3 档）。
 * embed 一律抛不可用；rerank 退化成 M1 的关键词重叠打分（0~1），并在结果里如实说明这不是模型精排。
 */
import { RetrieverUnavailable, type RerankHit, type Retriever, type RetrieverHealth } from './types.js';

export const FTS_MODEL_ID = 'fts-only';

export class FtsOnlyRetriever implements Retriever {
  readonly modelId = FTS_MODEL_ID;
  readonly dimensions = 0;

  constructor(private readonly reason = '没有配置语义检索器，只做字面检索') {}

  embed(_texts: string[], _mode: 'query' | 'document'): Promise<Float32Array[]> {
    return Promise.reject(new RetrieverUnavailable('fts_only', this.reason));
  }

  /** fts-only 没有精排能力：直接报不可用，字面打分由混合召回用 M1 的那套做，结果如实标成「没经过模型精排」。 */
  rerank(): Promise<RerankHit[]> {
    return Promise.reject(new RetrieverUnavailable('fts_only', this.reason));
  }

  health(): Promise<RetrieverHealth> {
    return Promise.resolve({ ok: false, mode: 'fts-only', detail: this.reason });
  }
}
