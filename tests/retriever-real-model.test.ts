import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/core/index.js';
import { LocalRetriever, hybridRecall, indexVectors, pickHints, type ServiceStatus } from '../src/retriever/index.js';
import { NEGATIVE_QUERIES, SYNTHETIC_EXPERIENCES, SYNTHETIC_PRINCIPLES, SYNONYM_CASES, TECH_ANCHOR_QUERY } from './fixtures/retriever/synthetic.js';

/**
 * 真实模型实跑（人工主动开启，不进离线 npm test）：
 *   MEMLOOM_TEST_MODEL_DIR=<模型目录> npm run test:real-model
 * 只用公开模型文件和合成中文语料；临时状态目录，不碰 ~/.memloom，不联网。
 */
const MODEL_DIR = process.env.MEMLOOM_TEST_MODEL_DIR;
const REAL_DAEMON = fileURLToPath(new URL('../src/retriever/daemon.js', import.meta.url));
const ENTRY_URL = new URL('../src/retriever/index.js', import.meta.url).href;
const T0 = '2026-11-27T10:00:00.000Z';
const IDLE_MS = 20_000;
const CLIENTS = 5;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rssMiB(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
}

/** 系统里命令行带着我们状态目录的守护进程有几个（证明只有一份模型实例在内存里）。 */
function daemonCount(stateDir: string): number {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes('retriever/daemon.js') && line.includes(stateDir)).length;
}

function runClient(stateDir: string, query: string): Promise<{ pid: number; modelId: string; dims: number; backend: string; error?: string }> {
  const script = `
    import { LocalRetriever } from ${JSON.stringify(ENTRY_URL)};
    const retriever = new LocalRetriever({ stateDir: process.env.STATE_DIR, modelDir: process.env.MODEL_DIR, idleMs: ${IDLE_MS}, threads: 8, startupTimeoutMs: 180000 });
    try {
      const status = await retriever.warmup();
      const [vector] = await retriever.embed([${JSON.stringify(query)}], 'query');
      process.stdout.write(JSON.stringify({ pid: status.pid, modelId: status.modelId, dims: status.dimensions, backend: status.backend, vectorDims: vector.length }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
    }
  `;
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STATE_DIR: stateDir, MODEL_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('exit', () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error(`客户端输出不是 JSON：${out}`));
        }
      });
    });
  });
}

test('真实模型：五个独立客户端首次并发共用一个服务进程，中文同义正反例精排正确，闲置退出后可再拉起', { skip: MODEL_DIR ? false : '没有设置 MEMLOOM_TEST_MODEL_DIR，跳过真实模型实跑', timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'memloom-retriever-real-'));
  const stateDir = join(root, 'state');
  const evidence: Record<string, unknown> = { modelDir: MODEL_DIR, node: process.version, platform: `${process.platform} ${process.arch}` };
  try {
    // 1) 五个真正独立的客户端进程，同一时刻撞在一个空的状态目录上
    const startedAt = Date.now();
    const clients = await Promise.all(SYNTHETIC_PRINCIPLES.slice(0, CLIENTS).map((_, index) => runClient(stateDir, `并发客户端 ${index}：软链接目录`)));
    const firstCallMs = Date.now() - startedAt;
    for (const client of clients) assert.ok(!client.error, `客户端失败：${client.error ?? ''}`);
    const pids = new Set(clients.map((client) => client.pid));
    assert.equal(pids.size, 1, `五个客户端必须连到同一个服务进程：${[...pids].join(',')}`);
    const pid = pids.values().next().value as number;
    assert.notEqual(pid, process.pid);
    assert.ok(isAlive(pid));
    for (const client of clients) {
      assert.equal(client.backend, 'onnx');
      assert.equal(client.dims, 512);
      assert.equal(client.modelId, clients[0]?.modelId);
    }
    const running = daemonCount(stateDir);
    assert.equal(running, 1, `系统里只应有一个检索服务进程，实际 ${running}`);
    const log = readFileSync(join(stateDir, 'retriever.log'), 'utf8');
    assert.equal(log.split('模型加载完成').length - 1, 1, '模型只加载了一次');
    evidence.clients = clients;
    evidence.firstCallMs = firstCallMs;
    evidence.daemonProcesses = running;
    evidence.logLosers = log.split('本进程不加载模型，直接退出').length - 1;

    // 2) 合成语料进临时库，建索引，跑中文同义正反例
    const store = openStore(join(root, 'test.db'));
    try {
      SYNTHETIC_PRINCIPLES.forEach((principle) => store.insertPrinciple({ scope: 'personal', triggerWhen: principle.triggerWhen, rule: principle.rule, now: T0 }));
      SYNTHETIC_EXPERIENCES.forEach((experience) => store.addExperience({ scope: 'personal', kind: experience.kind, summary: experience.summary, evidence: experience.evidence ?? null, source: 'manual', createdAt: T0 }));
      const retriever = new LocalRetriever({ stateDir, modelDir: MODEL_DIR as string, idleMs: IDLE_MS, threads: 8 });
      const indexStarted = Date.now();
      const indexed = await indexVectors({ store, retriever, scope: 'personal' });
      const indexMs = Date.now() - indexStarted;
      assert.equal(indexed.failed, 0);
      assert.equal(indexed.embedded, SYNTHETIC_PRINCIPLES.length + SYNTHETIC_EXPERIENCES.length);
      evidence.index = { ...indexed, ms: indexMs };

      const status = (await retriever.status()) as ServiceStatus;
      evidence.service = { pid: status.pid, rssMiB: rssMiB(status.pid), models: status.models, modelId: status.modelId };
      assert.equal(status.pid, pid);

      const ranking: Array<Record<string, unknown>> = [];
      for (const case_ of SYNONYM_CASES) {
        const result = await hybridRecall({ store, scope: 'personal', query: case_.query, retriever });
        const top = result.items[0];
        assert.equal(result.mode.stage, 'full', case_.query);
        const acceptedTop =
          top && (top.type === 'principle' ? case_.accept.principles.includes(top.id - 1) : case_.accept.experiences.includes(top.id - 1));
        assert.ok(acceptedTop, `${case_.query} 排第一的应是同话题的原则 ${case_.accept.principles.join('/')} 或经历 ${case_.accept.experiences.join('/')}，实际 ${top?.type}:${top?.id}`);
        assert.ok((top.score as number) >= 0.72, `${case_.query} 的精排分 ${top?.score} 应 ≥ 0.72`);
        assert.ok(result.items.every((item) => item.lexicalScore === null), `${case_.query} 字面一条都找不到，只能靠向量`);
        assert.ok(pickHints(result.items).length >= 1);
        ranking.push({ query: case_.query, items: result.items.slice(0, 5).map((item) => ({ type: item.type, id: item.id, rerank: Number(item.score.toFixed(4)), cosine: item.vectorScore === null ? null : Number(item.vectorScore.toFixed(4)), source: item.source })) });
      }
      for (const query of NEGATIVE_QUERIES) {
        const result = await hybridRecall({ store, scope: 'personal', query, retriever });
        assert.ok(result.items.every((item) => item.score < 0.72), `${query} 不该有 ≥ 0.72 的命中`);
        assert.deepEqual(pickHints(result.items), []);
        ranking.push({ query, items: result.items.slice(0, 3).map((item) => ({ type: item.type, id: item.id, rerank: Number(item.score.toFixed(4)) })) });
      }
      const anchor = await hybridRecall({ store, scope: 'personal', query: TECH_ANCHOR_QUERY, retriever });
      assert.ok(anchor.items[0]?.experience?.summary.includes('ENOENT'));
      ranking.push({ query: TECH_ANCHOR_QUERY, items: anchor.items.slice(0, 3).map((item) => ({ type: item.type, id: item.id, rerank: Number(item.score.toFixed(4)), source: item.source })) });
      evidence.ranking = ranking;

      // 3) 一次普通 CPU 配置下的实际耗时与内存（不当作硬保证）
      const timing: Record<string, number> = {};
      for (const [label, query] of [['短查询', '软链接'], ['长查询', '改完代码以后忘了先编译就直接跑测试，结果一直跑到的是旧产物，排查了很久才发现'], ...NEGATIVE_QUERIES.map((q, i) => [`反例${i + 1}`, q] as const)]) {
        const t = Date.now();
        const result = await hybridRecall({ store, scope: 'personal', query, retriever });
        timing[label] = Date.now() - t;
        void result;
      }
      evidence.recallMs = timing;
      evidence.rssMiBAfterRecall = rssMiB(status.pid);

      // 4) 闲置退出：pid 消失、文件清掉；下一次请求拉起新进程
      const idleStarted = Date.now();
      while (isAlive(pid) && Date.now() - idleStarted < IDLE_MS + 15_000) await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(isAlive(pid), false, `闲置 ${IDLE_MS / 1000} 秒后服务必须退出`);
      evidence.idleExitMs = Date.now() - idleStarted;
      assert.equal(existsSync(join(stateDir, 'retriever.sock')), false);
      assert.deepEqual(readdirSync(join(stateDir, 'retriever.lock')), [], '闲置退出时清掉自己的票，锁目录空了');
      const logAfter = readFileSync(join(stateDir, 'retriever.log'), 'utf8');
      assert.match(logAfter, /退出：idle/);
      const again = await hybridRecall({ store, scope: 'personal', query: '怎么做工作汇报', retriever });
      const revived = (await retriever.status()) as ServiceStatus;
      assert.ok(revived && revived.pid !== pid, '重新拉起的必须是新进程');
      assert.ok(again.items[0]?.principle?.id === 2 && again.mode.stage === 'full');
      evidence.revivedPid = revived.pid;
      evidence.revivedRecall = again.items.slice(0, 2).map((item) => ({ id: item.id, rerank: Number(item.score.toFixed(4)) }));
      const stopped = await retriever.stop('真实模型测试收尾');
      assert.equal(stopped.stopped, true);
      assert.equal(daemonCount(stateDir), 0, '收尾后不能再留着服务进程');
      evidence.stateFilesLeft = readdirSync(stateDir).sort();
    } finally {
      store.close();
    }
  } finally {
    console.log(`    真实模型取证：${JSON.stringify(evidence)}`);
    rmSync(root, { recursive: true, force: true });
  }
});
