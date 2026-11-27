import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/core/index.js';
import {
  FtsOnlyRetriever,
  hybridRecall,
  indexVectors,
  pickHints,
  rebuildVectors,
  formatHintBlock,
  vectorToBytes,
  type RecallItem,
  type Retriever,
} from '../src/retriever/index.js';
import { RetrieverUnavailable } from '../src/retriever/types.js';
import { NEGATIVE_QUERIES, STUB_CONCEPTS, SYNTHETIC_EXPERIENCES, SYNTHETIC_PRINCIPLES, SYNONYM_CASES, TECH_ANCHOR_QUERY } from './fixtures/retriever/synthetic.js';

const T0 = '2026-11-27T10:00:00.000Z';
const DIMS = 64;

/** 离线假检索器：概念位向量 + 概念重叠精排；可以按需让某一步失败或卡住。 */
class FakeRetriever implements Retriever {
  readonly modelId = 'fake-concept:64';
  readonly dimensions = DIMS;
  failEmbed = false;
  /** 向量失败时的错误码：'fake' 当作接口坏（还会去试精排），'start_failed' 当作本地服务已确定不可用 */
  failEmbedCode = 'fake';
  failRerank = false;
  hangEmbed = false;
  embedCalls = 0;
  rerankCalls = 0;
  lastRerankDocs = 0;

  private concepts(text: string): Set<number> {
    const found = new Set<number>();
    STUB_CONCEPTS.forEach((concept, index) => {
      if (concept.words.some((word) => text.toLowerCase().includes(word.toLowerCase()))) found.add(index);
    });
    return found;
  }

  async embed(texts: string[], _mode: 'query' | 'document'): Promise<Float32Array[]> {
    this.embedCalls += 1;
    if (this.failEmbed) throw new RetrieverUnavailable(this.failEmbedCode, this.failEmbedCode === 'fake' ? '向量服务坏了' : '共享检索服务启动阶段异常退出');
    if (this.hangEmbed) await new Promise(() => {});
    return texts.map((text) => {
      const vector = new Float32Array(DIMS);
      for (const concept of this.concepts(text)) vector[concept] = 1;
      vector[DIMS - 1] = text.length % 7;
      const norm = Math.hypot(...vector) || 1;
      for (let i = 0; i < DIMS; i += 1) vector[i] = (vector[i] as number) / norm;
      return vector;
    });
  }

  async rerank(query: string, documents: string[], topK: number): Promise<Array<{ index: number; score: number }>> {
    this.rerankCalls += 1;
    this.lastRerankDocs = documents.length;
    if (this.failRerank) throw new RetrieverUnavailable('fake', '精排服务坏了');
    const queryConcepts = this.concepts(query);
    return documents
      .map((document, index) => {
        const shared = [...queryConcepts].filter((concept) => this.concepts(document).has(concept)).length;
        // 和替身守护进程一样：共享的概念越多分略高，含报错码的经历靠两个概念压过只沾边的泛原则
        return { index, score: shared > 0 ? 0.9 + 0.02 * (shared - 1) : 0.05 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async health(): Promise<{ ok: boolean; mode: 'local-onnx' | 'api' | 'fts-only'; detail?: string }> {
    return { ok: true, mode: 'api', detail: '离线假检索器' };
  }
}

async function withCorpus(fn: (store: Store, root: string) => Promise<void>, options: { seed?: 'personal' | 'both' } = { seed: 'both' }): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'memloom-retriever-'));
  const store = openStore(join(root, 'test.db'));
  const seed = (scope: string, suffix: string): void => {
    SYNTHETIC_PRINCIPLES.forEach((principle, index) =>
      store.insertPrinciple({ scope, triggerWhen: `${principle.triggerWhen}${suffix}`, rule: `${principle.rule}${suffix}`, now: T0 }),
    );
    SYNTHETIC_EXPERIENCES.forEach((experience) =>
      store.addExperience({ scope, kind: experience.kind, summary: `${experience.summary}${suffix}`, evidence: experience.evidence ?? null, source: 'manual', createdAt: T0 }),
    );
  };
  seed('personal', '');
  if (options.seed === 'both') seed('project:demo', '（项目）');
  try {
    await fn(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('混合召回：中文同义句靠向量找到字面找不到的原则，精排排第一，提醒只留高分的 2~3 条', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    const indexed = await indexVectors({ store, retriever, scope: 'personal' });
    assert.equal(indexed.embedded, SYNTHETIC_PRINCIPLES.length + SYNTHETIC_EXPERIENCES.length);

    for (const case_ of SYNONYM_CASES) {
      const result = await hybridRecall({ store, scope: 'personal', query: case_.query, retriever });
      const top = result.items[0] as RecallItem;
      assert.equal(result.mode.stage, 'full', case_.query);
      assert.equal(result.mode.reranked, true);
      // 离线替身的精排分是并列的：只要求同话题的条目进前三且分数 ≥ 0.72；排第一的严格性由真实模型测试验证
      const inTop = result.items.slice(0, 3).some((item) =>
        item.type === 'principle' ? case_.accept.principles.includes(item.id - 1) : case_.accept.experiences.includes(item.id - 1),
      );
      assert.ok(inTop, `${case_.query} 前三里应有同话题条目，实际 ${result.items.slice(0, 3).map((item) => `${item.type}:${item.id}`).join(',')}`);
      assert.ok(top.score >= 0.72, `${case_.query} 的精排分 ${top.score} 应 ≥ 0.72`);
      // 同义句在语料里没有任何三字窗口能对上：字面阶段必须一条都没找到，全靠向量
      assert.ok(result.items.every((item) => item.lexicalScore === null), `${case_.query} 不该有字面命中`);
      assert.ok(result.items.every((item) => item.source === 'vector'));
      const hints = pickHints(result.items);
      assert.ok(hints.length >= 1 && hints.length <= 3, `${case_.query} 提醒 ${hints.length} 条`);
      const block = formatHintBlock(hints);
      assert.ok(block.startsWith('<memory-hint>') && block.length <= 400 + 80, `提醒块 ${block.length} 字`);
    }

    for (const query of NEGATIVE_QUERIES) {
      const result = await hybridRecall({ store, scope: 'personal', query, retriever });
      assert.equal(result.mode.stage, 'full');
      assert.ok(result.items.every((item) => item.score <= 0.05), `${query} 不该有高分：${JSON.stringify(result.items.map((i) => i.score))}`);
      assert.deepEqual(pickHints(result.items), [], `${query} 没有高置信命中就不提醒`);
      assert.equal(formatHintBlock(pickHints(result.items)), '');
    }
  });
});

test('混合召回：技术锚点靠字面补位找回来，和向量命中的去重合并，候选封顶 15', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    await indexVectors({ store, retriever, scope: 'personal' });
    const result = await hybridRecall({ store, scope: 'personal', query: TECH_ANCHOR_QUERY, retriever });
    const anchor = result.items.find((item) => item.type === 'experience' && item.experience?.summary.includes('ENOENT'));
    assert.ok(anchor, 'ENOENT 这条经历必须找回来');
    assert.equal(anchor.lexicalScore, 1);
    assert.ok(anchor.source === 'lexical' || anchor.source === 'vector+lexical');
    // 去重：同一个 (类型, 编号) 只出现一次
    const keys = result.items.map((item) => `${item.type}:${item.id}`);
    assert.equal(new Set(keys).size, keys.length);
    // 向量 12 + 字面 8 → 封顶 15：再造 30 条同概念原则，候选也不能超过 15
    for (let i = 0; i < 30; i += 1) {
      store.insertPrinciple({ scope: 'personal', triggerWhen: `当你第 ${i} 次删软链接目录时`, rule: `第 ${i} 条：先看是不是软链接`, now: T0 });
    }
    await rebuildVectors({ store, retriever, scope: 'personal' });
    const big = await hybridRecall({ store, scope: 'personal', query: '软链接目录', retriever, candidateLimit: 15, limit: 20 });
    assert.ok(retriever.lastRerankDocs <= 15, `送给精排的候选 ${retriever.lastRerankDocs} 条，必须 ≤ 15`);
    assert.ok(retriever.lastRerankDocs >= 12, `候选应同时来自向量和字面，实际 ${retriever.lastRerankDocs}`);
    assert.ok(big.items.length <= 15);
  });
});

test('降级：向量不可用退字面补位再精排；精排也不可用就按字面分排序并如实标注，提醒为空', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    await indexVectors({ store, retriever, scope: 'personal' });

    retriever.failEmbed = true;
    const lexOnly = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.equal(lexOnly.mode.stage, 'lexical-rerank');
    assert.match(lexOnly.mode.vectorReason ?? '', /坏了/);
    assert.ok(lexOnly.items.length > 0 && lexOnly.items.every((item) => item.source === 'lexical' && item.reranked));
    assert.ok(pickHints(lexOnly.items).length >= 1, '字面找到的候选经过模型精排后仍可提醒');

    retriever.failRerank = true;
    const none = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.equal(none.mode.stage, 'lexical-only');
    assert.equal(none.mode.reranked, false);
    assert.ok(none.items.every((item) => !item.reranked));
    for (let i = 1; i < none.items.length; i += 1) assert.ok((none.items[i - 1] as RecallItem).score >= (none.items[i] as RecallItem).score);
    assert.deepEqual(pickHints(none.items), [], '没经过模型精排的结果不提醒');

    retriever.failEmbed = false;
    const vectorOnly = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.equal(vectorOnly.mode.stage, 'vector-only');
    assert.ok(vectorOnly.items[0] && vectorOnly.items[0].vectorScore !== null && vectorOnly.items[0].lexicalScore !== null);
  });
});

test('降级：向量这一步卡住时按超时退回，不拖住主流程', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    await indexVectors({ store, retriever, scope: 'personal' });
    retriever.hangEmbed = true;
    const started = Date.now();
    const result = await hybridRecall({ store, scope: 'personal', query: 'ENOENT', retriever, embedTimeoutMs: 100 });
    assert.ok(Date.now() - started < 3_000, `不该卡住，实际 ${Date.now() - started} 毫秒`);
    assert.equal(result.mode.stage, 'lexical-rerank');
    assert.ok(result.items[0]?.experience?.summary.includes('ENOENT'));
  });
});

test('fts-only 检索器：embed 直接不可用，混合召回照常给字面结果', async () => {
  await withCorpus(async (store) => {
    const retriever = new FtsOnlyRetriever();
    assert.equal((await retriever.health()).mode, 'fts-only');
    await assert.rejects(retriever.embed(['x'], 'query'), { message: /只做字面检索/ });
    const result = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.equal(result.mode.retriever, 'fts-only');
    assert.equal(result.mode.stage, 'lexical-only');
    assert.ok(result.items.length > 0);
  });
});

test('作用域隔离：个人域的查询看不到项目域的原则和经历，补建向量也只碰指定作用域', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    const personal = await indexVectors({ store, retriever, scope: 'personal' });
    assert.equal(personal.scope, 'personal');
    assert.equal(store.listPrinciples('project:demo').every((principle) => principle.embedding === null), true, '项目域不该被顺手建了向量');
    const project = await indexVectors({ store, retriever, scope: 'project:demo' });
    assert.equal(project.embedded, SYNTHETIC_PRINCIPLES.length + SYNTHETIC_EXPERIENCES.length);

    const fromPersonal = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.ok(fromPersonal.items.length > 0);
    assert.ok(fromPersonal.items.every((item) => (item.principle?.scope ?? item.experience?.scope) === 'personal'));
    const fromProject = await hybridRecall({ store, scope: 'project:demo', query: '软链接', retriever });
    assert.ok(fromProject.items.length > 0);
    assert.ok(fromProject.items.every((item) => (item.principle?.scope ?? item.experience?.scope) === 'project:demo'));
    assert.ok(fromProject.items.every((item) => item.text.includes('（项目）')));
  });
});

test('向量索引：有界补建、只认同模型同维度的存量向量、新记录能被召回、force 全量重建', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    // 别的模型 / 别的长度写的向量不能拿来比
    const first = store.listPrinciples('personal')[0] as { id: number };
    store.setPrincipleEmbedding(first.id, vectorToBytes(new Float32Array(DIMS)), '别的模型:64');
    const second = store.listPrinciples('personal')[1] as { id: number };
    store.setPrincipleEmbedding(second.id, vectorToBytes(new Float32Array(DIMS)), retriever.modelId);
    store.setPrincipleEmbedding(second.id, vectorToBytes(new Float32Array(DIMS + 4)), retriever.modelId);

    const one = await indexVectors({ store, retriever, scope: 'personal', limit: 2 });
    assert.equal(one.scanned, 2);
    assert.equal(one.embedded, 2);
    assert.equal(one.failed, 0);
    assert.equal(retriever.embedCalls, 1, '两条一批，只调一次模型');
    const firstRow = store.getPrinciple(first.id);
    assert.equal(firstRow.embeddingModel, retriever.modelId);
    assert.equal(firstRow.embedding?.byteLength, DIMS * 4);

    // 分几次补完，再用它召回新加的记录
    const total = await rebuildVectors({ store, retriever, scope: 'personal' });
    assert.equal(total.failed, 0);
    assert.equal(total.scanned, SYNTHETIC_PRINCIPLES.length + SYNTHETIC_EXPERIENCES.length - 2, '前面已补好的两条不重算，其余补齐');
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备删掉一个软链接目录的时候', rule: '先 ls -la 看一眼', now: T0 });
    // 「软连接」在语料里没有三字窗口能对上：新记录只能靠向量被召回
    const fresh = await hybridRecall({ store, scope: 'personal', query: '软连接', retriever });
    assert.ok(!fresh.items.some((item) => item.text.includes('ls -la')), '还没补向量的新记录不会凭空出现');
    const bump = await indexVectors({ store, retriever, scope: 'personal' });
    assert.equal(bump.scanned, 1);
    assert.equal(bump.embedded, 1);
    const after = await hybridRecall({ store, scope: 'personal', query: '软连接', retriever });
    assert.ok(after.items.some((item) => item.type === 'principle' && item.text.includes('ls -la')), '补建后就能被召回');

    const forced = await rebuildVectors({ store, retriever, scope: 'personal', force: true });
    assert.equal(forced.failed, 0);
    assert.equal(forced.scanned, SYNTHETIC_PRINCIPLES.length + 1 + SYNTHETIC_EXPERIENCES.length);
  });
});

test('降级：向量阶段已确定本地服务不可用时不再花精排预算；只是 embed 接口坏（超时、坏响应）时仍试一次精排', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    await indexVectors({ store, retriever, scope: 'personal' });
    const before = retriever.rerankCalls;
    retriever.failEmbed = true;
    retriever.failEmbedCode = 'start_failed';
    const quick = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever, rerankTimeoutMs: 60_000 });
    assert.equal(quick.mode.stage, 'lexical-only');
    assert.equal(retriever.rerankCalls, before, '本地服务已确定不可用，就不该再去等精排');
    assert.match(quick.mode.rerankReason ?? '', /不再等精排/);
    assert.ok(quick.items.length > 0 && quick.items.every((item) => item.source === 'lexical'));
    retriever.failEmbedCode = 'timeout';
    const stillTries = await hybridRecall({ store, scope: 'personal', query: '软链接', retriever });
    assert.equal(stillTries.mode.stage, 'lexical-rerank', 'embed 坏而 rerank 能用的路径照旧走得通');
    assert.equal(retriever.rerankCalls, before + 1);
  });
});

function seedCrowd(store: Store, principles: number, experiences: number): void {
  for (let i = 0; i < principles; i += 1) {
    store.insertPrinciple({ scope: 'personal', triggerWhen: `当你第 ${i} 次准备删软链接目录的时候`, rule: `第 ${i} 条泛泛的中文原则：先看一眼是不是软链接，再决定要不要带尾斜杠`, now: T0 });
  }
  for (let i = 0; i < experiences; i += 1) {
    store.addExperience({ scope: 'personal', kind: 'pitfall', summary: `第 ${i} 条经历：软链接目录删起来要小心`, source: 'manual', createdAt: T0 });
  }
}

test('字面补位：原则和经历合计只留 8 条，含精确技术词的条目优先，不被一堆泛中文原则挤掉', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    seedCrowd(store, 12, 4);
    await rebuildVectors({ store, retriever, scope: 'personal' });
    const result = await hybridRecall({ store, scope: 'personal', query: '软链接 ENOENT', retriever, limit: 20 });
    const lexicalSourced = result.items.filter((item) => item.source !== 'vector');
    assert.ok(lexicalSourced.length <= 8, `字面补位合计 ${lexicalSourced.length} 条，必须 ≤ 8（不是原则、经历各 8 条）`);
    const anchor = result.items.find((item) => item.type === 'experience' && item.experience?.summary.includes('ENOENT'));
    assert.ok(anchor, '含唯一报错码 ENOENT 的经历必须在候选里');
    assert.equal(anchor.lexicalScore, 1);
    assert.ok(anchor.source.includes('lexical'));
    assert.equal(result.items[0]?.id, anchor.id, '精排后它排第一');
    assert.ok(retriever.lastRerankDocs <= 15, `送去精排的候选 ${retriever.lastRerankDocs} 条，必须 ≤ 15`);
  });
});

test('候选超过 15 条：仍最多 15、按类型 + 编号去重，向量 12 条加泛中文原则挤不掉含报错码的经历', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    seedCrowd(store, 14, 6);
    await rebuildVectors({ store, retriever, scope: 'personal' });
    // 「符号链接」字面上只对得上合成语料里的几条，向量的 12 条候选几乎全是另一批泛中文原则：两类合起来远超 15
    const result = await hybridRecall({ store, scope: 'personal', query: '符号链接 ENOENT', retriever, limit: 20 });
    assert.equal(retriever.lastRerankDocs, 15, `候选应正好封顶 15，实际 ${retriever.lastRerankDocs}`);
    assert.ok(result.items.length <= 15);
    const keys = result.items.map((item) => `${item.type}:${item.id}`);
    assert.equal(new Set(keys).size, keys.length, '类型 + 编号去重');
    const anchor = result.items.find((item) => item.type === 'experience' && item.experience?.summary.includes('ENOENT'));
    assert.ok(anchor, '含唯一报错码的经历不能被挤掉');
    assert.equal(result.items[0]?.id, anchor.id, '精排后含报错码的经历排第一');
    // 反例：查询里没有技术词时，字面补位同样合计 8 条
    const plain = await hybridRecall({ store, scope: 'personal', query: '软链接目录', retriever, limit: 20 });
    assert.ok(plain.items.filter((item) => item.source !== 'vector').length <= 8);
    assert.ok(retriever.lastRerankDocs <= 15);
  });
});

test('提醒块：400 字上限按 formatHintBlock 的完整文字算（含包装和说明）', async () => {
  await withCorpus(async (store) => {
    const retriever = new FakeRetriever();
    const base = '先看一眼它是不是软链接，再确认链接指向的目标目录还在不在，确认无误后才动手删除，删除时绝对不要带尾斜杠，也不要顺手加 -rf 参数。';
    const longRule = base + base;
    for (let i = 0; i < 3; i += 1) {
      store.insertPrinciple({ scope: 'personal', triggerWhen: `当你准备删第 ${i} 个软链接目录的时候`, rule: longRule, now: T0 });
    }
    await rebuildVectors({ store, retriever, scope: 'personal' });
    const result = await hybridRecall({ store, scope: 'personal', query: '软链接目录', retriever });
    const hints = pickHints(result.items);
    assert.ok(hints.length >= 1 && hints.length <= 3);
    const block = formatHintBlock(hints);
    assert.ok(block.length <= 400, `完整提醒块 ${block.length} 字，必须 ≤ 400`);
    assert.ok(block.startsWith('<memory-hint>') && block.includes('仅作参考') && block.endsWith('</memory-hint>'));
    const greedy = formatHintBlock(result.items.filter((item) => item.reranked && item.score >= 0.72).slice(0, 3));
    assert.ok(greedy.length > 400, `三条长规则不加预算会是 ${greedy.length} 字，证明预算确实起了作用`);
  });
});
