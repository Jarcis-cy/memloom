import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/core/index.js';
import { ApiRetriever, createRetriever, hybridRecall, indexVectors, pickHints, retrieverConfigFromEnv } from '../src/retriever/index.js';

const T0 = '2026-11-27T10:00:00.000Z';
const SECRET = 'sk-test-secret-DO-NOT-LEAK-123';

interface Recorded {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface Mock {
  baseUrl: string;
  recorded: Recorded[];
  close: () => Promise<void>;
}

type Handler = (request: Recorded, response: ServerResponse) => void | Promise<void>;

/** 回环模拟服务：只在 127.0.0.1 的随机端口上听，按 path 分发，记录每个请求。 */
async function startMock(handler: Handler): Promise<Mock> {
  const recorded: Recorded[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      const record: Recorded = { path: request.url ?? '', headers: request.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
      recorded.push(record);
      void Promise.resolve(handler(record, response)).catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('拿不到回环端口');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** 确定性的假向量：按文本里的概念词给 8 维，方便验证顺序和截断。 */
function fakeVector(text: string): number[] {
  const vector = Array.from({ length: 32 }, (_, index) => (index + 1) / 100);
  if (text.includes('软链接')) vector[0] = 0.9;
  if (text.includes('汇报')) vector[1] = 0.9;
  return vector;
}

function api(mock: Mock, extra: Partial<ConstructorParameters<typeof ApiRetriever>[0]> = {}): ApiRetriever {
  return new ApiRetriever({ baseUrl: mock.baseUrl, embedModel: 'test-embedding', rerankModel: 'test-reranker', apiKey: SECRET, dimensions: 32, ...extra });
}

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'memloom-retriever-api-'));
  const store = openStore(join(root, 'test.db'));
  try {
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠', now: T0 });
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备汇报工作结果的时候', rule: '先说结论，再说细节', now: T0 });
    await fn(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('API 模式：embeddings 乱序返回也按 index 排回请求顺序，按维度截断并归一化；凭据只走请求头', async () => {
  const mock = await startMock((request, response) => {
    if (request.path === '/v1/embeddings') {
      const input = request.body.input as string[];
      // 故意倒着返回，模拟服务端乱序
      json(response, 200, { data: input.map((text, index) => ({ index, embedding: fakeVector(text) })).reverse() });
    }
  });
  try {
    const retriever = api(mock);
    assert.equal(retriever.modelId, `api:127.0.0.1:${mock.baseUrl.split(':')[2]?.split('/')[0]}:test-embedding:32`);
    const vectors = await retriever.embed(['软链接目录', '汇报结果', '无关'], 'document');
    assert.equal(vectors.length, 3);
    assert.equal(vectors[0]?.length, 32);
    assert.ok(Math.abs(Math.hypot(...(vectors[0] ?? [])) - 1) < 1e-5, '截断后重新 L2 归一化');
    assert.ok((vectors[0]?.[0] ?? 0) > (vectors[1]?.[0] ?? 0), '第一条是软链接那条');
    assert.ok((vectors[1]?.[1] ?? 0) > (vectors[0]?.[1] ?? 0), '第二条是汇报那条');
    const sent = mock.recorded[0] as Recorded;
    assert.equal(sent.body.model, 'test-embedding');
    assert.equal(sent.body.dimensions, 32);
    assert.equal(sent.headers.authorization, `Bearer ${SECRET}`);
    const health = await retriever.health();
    assert.equal(health.mode, 'api');
    assert.ok(!JSON.stringify(health).includes(SECRET), 'health 里不能出现凭据');
  } finally {
    await mock.close();
  }
});

test('API 模式：rerank 读 relevance_score、排序并夹到 [0,1]；混合召回和提醒照常工作', async () => {
  const mock = await startMock((request, response) => {
    if (request.path === '/v1/embeddings') {
      const input = request.body.input as string[];
      json(response, 200, { data: input.map((text, index) => ({ index, embedding: fakeVector(text) })) });
    } else if (request.path === '/v1/rerank') {
      const documents = request.body.documents as string[];
      json(response, 200, {
        results: documents.map((text, index) => ({ index, relevance_score: text.includes('软链接') ? 1.7 : -0.2 })).reverse(),
      });
    }
  });
  try {
    await withStore(async (store) => {
      const retriever = api(mock);
      const direct = await retriever.rerank('软链接', ['软链接目录', '汇报', '无关'], 2);
      assert.deepEqual(direct, [
        { index: 0, score: 1 },
        { index: 2, score: 0 },
      ]);
      await indexVectors({ store, retriever, scope: 'personal' });
      assert.ok(store.listPrinciples('personal').every((principle) => principle.embeddingModel === retriever.modelId && principle.embedding?.byteLength === 128));
      const result = await hybridRecall({ store, scope: 'personal', query: '软连接', retriever });
      assert.equal(result.mode.stage, 'full');
      assert.equal(result.mode.retriever, 'api');
      assert.ok(result.items[0]?.principle?.rule.includes('软链接'));
      assert.equal(pickHints(result.items).length, 1);
      const rerankCall = mock.recorded.find((request) => request.path === '/v1/rerank') as Recorded;
      assert.equal(rerankCall.body.model, 'test-reranker');
      assert.equal(rerankCall.body.top_n, 2);
      assert.equal(rerankCall.body.return_documents, false);
    });
  } finally {
    await mock.close();
  }
});

test('API 模式：服务返回 500、非 JSON、下标越界都变成「不可用」，混合召回退回字面并如实标注', async () => {
  let mode: '500' | 'json' | 'index' = '500';
  const mock = await startMock((request, response) => {
    if (request.path === '/v1/embeddings') {
      if (mode === '500') return json(response, 500, { error: { message: '后端挂了' } });
      if (mode === 'json') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>不是 JSON</html>');
        return;
      }
      return json(response, 200, { data: [{ index: 7, embedding: fakeVector('x') }] });
    }
    response.writeHead(503);
    response.end();
  });
  try {
    await withStore(async (store) => {
      const retriever = api(mock);
      for (const current of ['500', 'json', 'index'] as const) {
        mode = current;
        await assert.rejects(retriever.embed(['软链接'], 'query'), (error: unknown) => typeof (error as { code?: string }).code === 'string');
        const result = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
        assert.equal(result.mode.stage, 'lexical-only', current);
        assert.equal(result.mode.reranked, false);
        assert.ok(result.mode.vectorReason && !result.mode.vectorReason.includes(SECRET), `报错里不能带凭据：${result.mode.vectorReason}`);
        assert.ok(result.items.length > 0 && result.items.every((item) => item.source === 'lexical'));
      }
    });
  } finally {
    await mock.close();
  }
});

test('API 模式：请求超时和网络不可用都及时退回字面，不卡主流程', async () => {
  const slow = await startMock((request, response) => {
    setTimeout(() => json(response, 200, { data: [] }), 500);
    void request;
  });
  try {
    await withStore(async (store) => {
      const retriever = api(slow, { timeoutMs: 100 });
      const started = Date.now();
      const result = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
      assert.ok(Date.now() - started < 1_500, `超时后要马上退回，实际 ${Date.now() - started} 毫秒`);
      assert.equal(result.mode.stage, 'lexical-only');
      assert.match(result.mode.vectorReason ?? '', /超时|timeout|abort/i);
    });
  } finally {
    await slow.close();
  }
  const dead = await startMock(() => {});
  await dead.close();
  await withStore(async (store) => {
    const retriever = api(dead);
    const started = Date.now();
    const result = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.ok(Date.now() - started < 1_500);
    assert.equal(result.mode.stage, 'lexical-only');
    assert.match(result.mode.vectorReason ?? '', /失败/);
    assert.equal(result.items[0]?.lexicalScore, 1, '网络不可用时仍然给出真正的字面结果');
    assert.deepEqual(pickHints(result.items), [], '字面兜底不冒充语义提醒');
  });
});

test('API 模式：没给凭据就不带 Authorization；配置缺项直接说清楚；env 读取对齐字段', async () => {
  const mock = await startMock((request, response) => {
    json(response, 200, { data: (request.body.input as string[]).map((text, index) => ({ index, embedding: fakeVector(text) })) });
  });
  try {
    const retriever = api(mock, { apiKey: undefined });
    await retriever.embed(['软链接'], 'document');
    assert.equal(mock.recorded[0]?.headers.authorization, undefined);
    assert.throws(() => new ApiRetriever({ baseUrl: '', embedModel: 'a', rerankModel: 'b', dimensions: 32 }), /base URL/);
    assert.throws(() => new ApiRetriever({ baseUrl: mock.baseUrl, embedModel: 'a', rerankModel: 'b', dimensions: 0 }), /维度/);
  } finally {
    await mock.close();
  }
  const env = {
    MEMLOOM_RETRIEVER_MODE: 'api',
    MEMLOOM_API_BASE_URL: mock.baseUrl,
    MEMLOOM_EMBED_MODEL: 'Qwen/Qwen3-Embedding-0.6B',
    MEMLOOM_RERANK_MODEL: 'Qwen/Qwen3-Reranker-0.6B',
    MEMLOOM_API_KEY: 'k',
    MEMLOOM_EMBED_DIMENSIONS: '512',
  };
  const config = retrieverConfigFromEnv(env);
  assert.ok(config.mode === 'api' && config.embedModel === 'Qwen/Qwen3-Embedding-0.6B' && config.dimensions === 512);
  assert.throws(() => retrieverConfigFromEnv({ MEMLOOM_RETRIEVER_MODE: 'api' }), /必须给/);
  assert.throws(() => retrieverConfigFromEnv({ MEMLOOM_RETRIEVER_MODE: 'local-onnx' }), /必须给/);
  const auto = retrieverConfigFromEnv({ MEMLOOM_STATE_DIR: '/tmp/x', MEMLOOM_MODEL_DIR: '/tmp/x/models', MEMLOOM_API_BASE_URL: 'http://127.0.0.1:1/v1' });
  assert.ok(auto.mode === 'auto' && auto.modelDir === '/tmp/x/models');
  const created = createRetriever({ mode: 'auto', stateDir: '/tmp/x', modelDir: '/tmp/x/definitely-missing' });
  assert.equal((await created.health()).mode, 'fts-only');
  const fts = createRetriever({ mode: 'fts-only' });
  assert.equal((await fts.health()).mode, 'fts-only');
});
