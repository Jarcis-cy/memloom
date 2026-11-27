/**
 * 离线替身守护进程：和真实守护进程（src/retriever/daemon.ts）走完全相同的进程骨架、锁、socket、闲置退出，
 * 只是后端不是 ONNX 模型，而是一张小小的同义概念表 + 字符三字窗口哈希。
 * 它只用来在离线测试里证明多进程并发、独占加载、闲置退出、安全停止这些「进程层面」的事；
 * 语义能力是否成立要靠真实模型测试（tests/retriever-real-model.test.ts），不能拿这个替身冒充。
 *
 * 可选环境变量：
 *   MEMLOOM_TEST_LOAD_COUNTER     每次真正「加载后端」就往这个文件追加一行 pid，测试据此数加载次数
 *   MEMLOOM_TEST_SPAWN_COUNTER    进程一启动就追加一行 pid，测试据此数被拉起了几次
 *   MEMLOOM_TEST_CRASH=exit|kill  一启动就异常退出 / 自杀（不写 last-error），模拟装载阶段的崩溃
 *   MEMLOOM_TEST_PAUSE_BEFORE_SCAN_MS / _BEFORE_STALE_UNLINK_MS / _AFTER_LISTEN_MS
 *                                 在对应钩子处停这么多毫秒，让并发竞态按剧本发生
 */
import { appendFileSync } from 'node:fs';
import { resolveLocalModelId } from '../../../src/retriever/modelid.js';
import { runService, type RerankScore, type ServiceBackend } from '../../../src/retriever/service.js';
import { l2Normalize } from '../../../src/retriever/types.js';
import { LOCAL_DIMENSIONS } from '../../../src/retriever/modelid.js';
import { STUB_CONCEPTS } from './synthetic.js';

const stateDir = process.argv[2] ?? '';
const modelDir = process.env.MEMLOOM_RETRIEVER_MODEL_DIR ?? '';
const idleMs = Number(process.env.MEMLOOM_RETRIEVER_IDLE_MS ?? '600000');
const loadCounter = process.env.MEMLOOM_TEST_LOAD_COUNTER;
const spawnCounter = process.env.MEMLOOM_TEST_SPAWN_COUNTER;
if (spawnCounter) appendFileSync(spawnCounter, `${process.pid}\n`);
const crash = process.env.MEMLOOM_TEST_CRASH;
if (crash === 'exit') process.exit(7);
if (crash === 'kill') process.kill(process.pid, 'SIGKILL');
const pause = (name: string): (() => Promise<void>) | undefined => {
  const ms = Number(process.env[`MEMLOOM_TEST_PAUSE_${name}_MS`] ?? '0');
  return ms > 0 ? async () => new Promise((resolve) => setTimeout(resolve, ms)) : undefined;
};

function conceptsOf(text: string): Set<number> {
  const found = new Set<number>();
  const lower = text.toLowerCase();
  STUB_CONCEPTS.forEach((concept, index) => {
    if (concept.words.some((word) => lower.includes(word.toLowerCase()))) found.add(index);
  });
  return found;
}

function hashTrigrams(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i + 3 <= text.length; i += 1) {
    const chunk = text.slice(i, i + 3);
    for (let j = 0; j < chunk.length; j += 1) hash = Math.imul(hash ^ chunk.charCodeAt(j), 16777619) >>> 0;
  }
  return hash;
}

/** 512 维：前几个维度是概念位（主信号），其余是三字窗口哈希（很小的噪声），最后 L2 归一化。 */
function stubVector(text: string): Float32Array {
  const vector = new Float32Array(LOCAL_DIMENSIONS);
  for (const concept of conceptsOf(text)) vector[concept] = 1;
  const hash = hashTrigrams(text);
  for (let i = STUB_CONCEPTS.length; i < LOCAL_DIMENSIONS; i += 1) vector[i] = ((hash >>> (i % 29)) & 1) * 0.02;
  return l2Normalize(vector);
}

const backend: ServiceBackend = {
  kind: 'stub',
  modelId: resolveLocalModelId(modelDir, LOCAL_DIMENSIONS) ?? 'stub:512',
  dimensions: LOCAL_DIMENSIONS,
  models: { note: '离线替身，不是真实模型' },
  embed: async (texts) => texts.map(stubVector),
  rerank: async (query, documents, topK) => {
    const queryConcepts = conceptsOf(query);
    const hits: RerankScore[] = documents.map((document, index) => {
      const shared = [...queryConcepts].filter((concept) => conceptsOf(document).has(concept)).length;
      return { index, score: shared > 0 ? 0.9 + 0.02 * (shared - 1) : 0.05 };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  },
};

runService({
  stateDir,
  modelDir,
  idleMs,
  backendKind: 'stub',
  hooks: {
    beforeScan: pause('BEFORE_SCAN'),
    beforeStaleSocketRemoval: pause('BEFORE_STALE_UNLINK'),
    afterListen: pause('AFTER_LISTEN'),
  },
  load: async () => {
    // 模拟「加载」要花一点时间，好让并发首启的竞态真的发生
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (loadCounter) appendFileSync(loadCounter, `${process.pid}\n`);
    return backend;
  },
}).then(
  (exit) => process.exit(exit.outcome === 'failed' ? 1 : 0),
  (error: unknown) => {
    process.stderr.write(`替身守护进程异常退出：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
