import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from '../src/core/index.js';
import { LocalRetriever, hybridRecall, type ServiceStatus } from '../src/retriever/index.js';

import { isProcessAlive as isAlive } from '../src/retriever/service.js';
const STUB_DAEMON = fileURLToPath(new URL('./fixtures/retriever/stub-daemon.js', import.meta.url));
const REAL_DAEMON = fileURLToPath(new URL('../src/retriever/daemon.js', import.meta.url));
const ENTRY_URL = new URL('../src/retriever/index.js', import.meta.url).href;
const T0 = '2026-11-27T10:00:00.000Z';

interface Temp {
  root: string;
  stateDir: string;
  modelDir: string;
  loadCounter: string;
  spawnCounter: string;
  socketPath: string;
  lockPath: string;
  logPath: string;
}

/** 替身不读模型文件，但客户端会检查目录结构，所以造一个只有空壳文件的模型目录。 */
function makeFakeModelDir(root: string): string {
  for (const [kind, file] of [['embedding', 'model_int8.onnx'], ['reranker', 'model_quantized.onnx']] as const) {
    const dir = join(root, 'models', kind, 'onnx');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'models', kind, 'tokenizer.json'), '{}');
    writeFileSync(join(root, 'models', kind, 'config.json'), '{}');
    writeFileSync(join(dir, file), 'not a real onnx file');
  }
  return join(root, 'models');
}

async function withTemp(fn: (temp: Temp, store: Store) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'memloom-retriever-proc-'));
  const temp: Temp = {
    root,
    stateDir: join(root, 'state'),
    modelDir: makeFakeModelDir(root),
    loadCounter: join(root, 'loads.log'),
    spawnCounter: join(root, 'spawns.log'),
    socketPath: join(root, 'state', 'retriever.sock'),
    lockPath: join(root, 'state', 'retriever.lock'),
    logPath: join(root, 'state', 'retriever.log'),
  };
  const store = openStore(join(root, 'test.db'));
  try {
    await fn(temp, store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒还没等到`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** 锁目录里此刻的票：pid → 票号 */
function tickets(lockPath: string): Map<number, number> {
  const out = new Map<number, number>();
  if (!existsSync(lockPath)) return out;
  for (const name of readdirSync(lockPath)) {
    const match = /^ticket\.(\d+)$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const info = JSON.parse(readFileSync(join(lockPath, name), 'utf8')) as { ticket: number; pid: number };
    assert.equal(info.pid, pid, '票的正文和文件名必须是同一个 pid');
    out.set(pid, info.ticket);
  }
  return out;
}

function socketIno(path: string): number | null {
  try {
    const stats = lstatSync(path);
    return stats.isSocket() ? stats.ino : null;
  } catch {
    return null;
  }
}

interface ClientResult {
  ok: boolean;
  pid?: number;
  modelId?: string;
  backend?: string;
  dims?: number;
  error?: string;
}

/** 真正独立的客户端进程：每个进程自己 new LocalRetriever，第一次请求就撞在同一个空状态目录上。 */
function runClient(temp: Temp, action: 'status' | 'embed'): Promise<ClientResult> {
  const script = `
    import { LocalRetriever } from ${JSON.stringify(ENTRY_URL)};
    const retriever = new LocalRetriever({
      stateDir: process.env.STATE_DIR, modelDir: process.env.MODEL_DIR, daemonEntry: process.env.DAEMON_ENTRY,
      spawnEnv: { MEMLOOM_TEST_LOAD_COUNTER: process.env.LOAD_COUNTER, MEMLOOM_TEST_SPAWN_COUNTER: process.env.SPAWN_COUNTER }, idleMs: 60000, startupTimeoutMs: 30000,
    });
    try {
      const status = await retriever.warmup();
      ${action === 'embed' ? "const [vector] = await retriever.embed(['软链接目录'], 'document'); if (vector.length !== 512) throw new Error('维度不对');" : ''}
      process.stdout.write(JSON.stringify({ ok: true, pid: status.pid, modelId: status.modelId, backend: status.backend, dims: status.dimensions }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, STATE_DIR: temp.stateDir, MODEL_DIR: temp.modelDir, DAEMON_ENTRY: STUB_DAEMON, LOAD_COUNTER: temp.loadCounter, SPAWN_COUNTER: temp.spawnCounter },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('exit', (code) => {
      try {
        resolve(JSON.parse(out) as ClientResult);
      } catch {
        reject(new Error(`客户端进程输出不是 JSON（退出码 ${code}）：${out}`));
      }
    });
  });
}

/** 直接按剧本拉起一个替身守护进程（不经客户端），记录它什么时候退出、退出码是多少。 */
function startDaemon(temp: Temp, env: Record<string, string> = {}): { child: ChildProcess; pid: number; exited: Promise<{ code: number | null; signal: string | null; at: number }> } {
  const child = spawn(process.execPath, [STUB_DAEMON, temp.stateDir], {
    env: {
      ...process.env,
      MEMLOOM_RETRIEVER_MODEL_DIR: temp.modelDir,
      MEMLOOM_RETRIEVER_IDLE_MS: '60000',
      MEMLOOM_TEST_LOAD_COUNTER: temp.loadCounter,
      MEMLOOM_TEST_SPAWN_COUNTER: temp.spawnCounter,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: string | null; at: number }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now(), ...({ stderr } as object) }));
  });
  return { child, pid: child.pid as number, exited };
}

test('五个独立客户端首次并发：只拉起一个服务、只加载一次、大家连到同一个进程', async () => {
  await withTemp(async (temp) => {
    const clients = await Promise.all([0, 1, 2, 3, 4].map((index) => runClient(temp, index % 2 === 0 ? 'embed' : 'status')));
    for (const client of clients) assert.ok(client.ok, `客户端失败：${client.error ?? ''}`);
    const pids = new Set(clients.map((client) => client.pid));
    assert.equal(pids.size, 1, `五个客户端必须连到同一个服务进程，实际 ${[...pids].join(',')}`);
    const pid = pids.values().next().value as number;
    assert.notEqual(pid, process.pid, '服务必须是另一个进程，不是测试进程自己');
    assert.ok(isAlive(pid));
    for (const client of clients) {
      assert.equal(client.backend, 'stub');
      assert.match(client.modelId ?? '', /^qwen3-embedding-0\.6b@unknown:int8:512$/, '模型身份由模型目录算出，客户端和服务必须一致');
    }

    const loads = lines(temp.loadCounter);
    assert.equal(loads.length, 1, `后端只能被加载一次，实际 ${loads.length} 次`);
    assert.equal(Number(loads[0]), pid);
    // 等输家都退出后，锁目录里只剩赢家自己的一张票，没有残留的选择牌
    await waitUntil(() => {
      const alive = [...tickets(temp.lockPath).keys()].filter((other) => other !== pid);
      return alive.length === 0 || alive.every((other) => !isAlive(other));
    }, 10_000);
    const left = tickets(temp.lockPath);
    assert.deepEqual([...left.keys()], [pid], '锁目录里只剩赢家的票');
    assert.ok(readdirSync(temp.lockPath).every((name) => /^ticket\./.test(name)), '不残留选择牌');
    const log = readFileSync(temp.logPath, 'utf8');
    assert.equal(count(log, '票号最小，独占成功'), 1, `只有一个进程独占成功；日志：\n${log}`);
    assert.equal(count(log, '模型加载完成'), 1);
    const losers = count(log, '本进程不加载模型，直接退出');
    console.log(`    诊断：拉起 ${lines(temp.spawnCounter).length} 个守护进程，输掉竞争不加载就退出的 ${losers} 个，独占成功 1 个`);
    assert.ok(losers >= 1, '五个客户端同时起跑，至少会有一个守护进程输掉竞争');

    // 状态目录 0700、socket 0600：只有当前用户能连
    assert.equal(statSync(temp.stateDir).mode & 0o077, 0, '状态目录不能对其他用户开放');
    assert.equal(statSync(temp.socketPath).mode & 0o077, 0, 'socket 不能让其他用户连');

    const service = new LocalRetriever({ stateDir: temp.stateDir, modelDir: temp.modelDir, daemonEntry: STUB_DAEMON });
    const before = await service.status();
    assert.ok(before && before.pid === pid);
    assert.equal((await service.health()).mode, 'local-onnx');
    assert.equal((await service.stop('测试收尾')).stopped, true, 'stop 之后服务必须退出');
    assert.equal(isAlive(pid), false);
    assert.equal(existsSync(temp.socketPath), false, '退出时清掉自己绑定的 socket');
    assert.deepEqual(readdirSync(temp.lockPath), [], '退出时清掉自己的票，锁目录空了');
    assert.equal(await service.status(), null, 'status 只探测，不会把服务再拉起来');
    assert.equal(existsSync(temp.socketPath), false);
  });
});

test('闲置退出：没有在途请求闲置到点就退出（pid 消失、文件清掉），下一次请求能重新拉起', async () => {
  await withTemp(async (temp) => {
    const retriever = new LocalRetriever({
      stateDir: temp.stateDir,
      modelDir: temp.modelDir,
      daemonEntry: STUB_DAEMON,
      idleMs: 1200,
      spawnEnv: { MEMLOOM_TEST_LOAD_COUNTER: temp.loadCounter },
    });
    const first = await retriever.warmup();
    assert.equal(first.idleMs, 1200);
    const firstPid = first.pid;
    await waitUntil(() => !isAlive(firstPid), 10_000);
    assert.equal(existsSync(temp.socketPath), false);
    assert.deepEqual(readdirSync(temp.lockPath), [], '闲置退出时清掉自己的票');
    const log = readFileSync(temp.logPath, 'utf8');
    assert.match(log, /完全闲置 \d+ 秒且没有在途请求/);
    assert.match(log, /退出：idle/);

    const second = await retriever.warmup();
    assert.notEqual(second.pid, firstPid, '重新拉起的是新进程');
    assert.equal(second.backend, 'stub');

    // 模拟服务被强杀（只杀我们自己刚起的这个进程）：票和 socket 文件残留，下一次请求照样能起一个新的
    process.kill(second.pid, 'SIGKILL');
    await waitUntil(() => !isAlive(second.pid), 5_000);
    assert.ok(existsSync(temp.socketPath), '被强杀后 socket 文件还在');
    assert.ok(tickets(temp.lockPath).has(second.pid), '被强杀后它的票还在（新进程会按「拥有者已死」清掉）');
    const [vector] = await retriever.embed(['符号链接'], 'query');
    assert.equal(vector?.length, 512);
    assert.ok(Math.abs(Math.hypot(...(vector ?? [])) - 1) < 1e-4, '向量是 L2 归一化的');
    const third = (await retriever.status()) as ServiceStatus;
    assert.notEqual(third.pid, second.pid);
    const after = readFileSync(temp.logPath, 'utf8');
    assert.match(after, /清掉已退出进程 pid=\d+ 留下的 ticket/);
    assert.match(after, /清掉上次崩溃留下的 socket 文件/);
    const stopped = await retriever.stop('清理');
    assert.equal(stopped.stopped, true);
    assert.equal(existsSync(temp.socketPath), false);
  });
});

test('可控调度：票号小的竞争者停在扫描前，后来者只等待、不删它的票，它绑定后也不会被顶掉', async () => {
  await withTemp(async (temp) => {
    // A 先起，拿到 1 号票后停在扫描前 1500 毫秒
    const a = startDaemon(temp, { MEMLOOM_TEST_PAUSE_BEFORE_SCAN_MS: '1500' });
    // B 紧跟着起，拿到 2 号票，只能等 A
    await new Promise((resolve) => setTimeout(resolve, 300));
    const b = startDaemon(temp);
    await waitUntil(() => tickets(temp.lockPath).has(b.pid), 5_000);
    // A 还停着：B 活着、没有任何人监听、谁的票都没被删
    assert.ok(isAlive(a.pid) && isAlive(b.pid));
    assert.deepEqual([...tickets(temp.lockPath).keys()].sort(), [a.pid, b.pid].sort(), '两张票都在，谁也没删谁');
    assert.equal(socketIno(temp.socketPath), null, 'A 还没监听');
    assert.equal(lines(temp.loadCounter).length, 0, '没有人加载模型');

    // A 恢复 → 独占 → 监听 → 加载；B 看到socket 活着就退出，且只退自己
    await waitUntil(() => socketIno(temp.socketPath) !== null && lines(temp.loadCounter).length === 1, 10_000);
    const aSocketIno = socketIno(temp.socketPath);
    const bExit = await b.exited;
    assert.equal(bExit.code, 0, `输家应正常退出，实际 ${bExit.code} ${bExit.signal}`);
    assert.equal(lines(temp.loadCounter).length, 1, '只有 A 加载');
    assert.equal(Number(lines(temp.loadCounter)[0]), a.pid);
    await waitUntil(() => !tickets(temp.lockPath).has(b.pid), 3_000);
    assert.equal(tickets(temp.lockPath).get(a.pid), 1, '赢家 A 的票还在');
    assert.equal(socketIno(temp.socketPath), aSocketIno, '赢家 A 的 socket 没被任何人替换或删除');
    assert.ok(isAlive(a.pid));
    const log = readFileSync(temp.logPath, 'utf8');
    assert.equal(count(log, '独占成功'), 1);
    assert.match(log, /排在前面的竞争者已经在服务，本进程不加载模型，直接退出/);

    // 再来一个后来者 C：在役者票号更小，C 不加载、不碰 A 的任何东西
    const c = startDaemon(temp);
    const cExit = await c.exited;
    assert.equal(cExit.code, 0);
    assert.equal(socketIno(temp.socketPath), aSocketIno);
    assert.equal(tickets(temp.lockPath).get(a.pid), 1);
    assert.equal(lines(temp.loadCounter).length, 1);
    assert.ok(isAlive(a.pid), '赢家 A 一直活着');

    // 收尾：A 正常退出，票和 socket 一起清掉
    const service = new LocalRetriever({ stateDir: temp.stateDir, modelDir: temp.modelDir, daemonEntry: STUB_DAEMON });
    assert.equal((await service.stop('收尾')).pid, a.pid);
    await waitUntil(() => !isAlive(a.pid), 8_000);
    assert.equal(existsSync(temp.socketPath), false);
    assert.deepEqual(readdirSync(temp.lockPath), []);
  });
});

test('崩溃残留 + 多个恢复者：只有票号最小的那个清残留并加载，另一个不碰它的新 socket', async () => {
  await withTemp(async (temp) => {
    const first = startDaemon(temp);
    await waitUntil(() => socketIno(temp.socketPath) !== null && lines(temp.loadCounter).length === 1, 10_000);
    const staleIno = socketIno(temp.socketPath);
    process.kill(first.pid, 'SIGKILL');
    await first.exited;
    assert.equal(socketIno(temp.socketPath), staleIno, '强杀后 socket 文件残留');

    // R1 先起（票号更小），停在「清残留 socket」之前 1200 毫秒；R2 后起，只能等
    const r1 = startDaemon(temp, { MEMLOOM_TEST_PAUSE_BEFORE_STALE_UNLINK_MS: '1200' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r2 = startDaemon(temp);
    await waitUntil(() => tickets(temp.lockPath).has(r2.pid), 5_000);
    assert.equal(socketIno(temp.socketPath), staleIno, 'R1 停着的时候，残留的 socket 没人动');
    assert.ok(isAlive(r1.pid) && isAlive(r2.pid));
    assert.ok(!tickets(temp.lockPath).has(first.pid), '死者的票已被清掉');

    await waitUntil(() => lines(temp.loadCounter).length === 2, 10_000);
    const r1Ino = socketIno(temp.socketPath);
    assert.notEqual(r1Ino, staleIno, 'R1 清掉残留后绑定了自己的新 socket');
    const r2Exit = await r2.exited;
    assert.equal(r2Exit.code, 0, 'R2 正常退出');
    assert.equal(Number(lines(temp.loadCounter)[1]), r1.pid, '第二个加载的是 R1');
    assert.equal(lines(temp.loadCounter).length, 2, '总共只加载两次（原服务 + R1），R2 没加载');
    assert.equal(socketIno(temp.socketPath), r1Ino, 'R2 退出没有动 R1 的 socket');
    assert.deepEqual([...tickets(temp.lockPath).keys()], [r1.pid], '锁目录里只剩 R1 的票');
    assert.ok(isAlive(r1.pid));
    const retriever = new LocalRetriever({ stateDir: temp.stateDir, modelDir: temp.modelDir, daemonEntry: STUB_DAEMON });
    assert.equal(((await retriever.status()) as ServiceStatus).pid, r1.pid);
    assert.equal((await retriever.stop('收尾')).stopped, true);
    await waitUntil(() => !isAlive(r1.pid), 8_000);
    assert.equal(existsSync(temp.socketPath), false);
  });
});

test('快速崩溃替身：启动阶段异常退出 → 同一调用内很快报不可用、只拉一次、混合召回给出真正的 lexical-only', async () => {
  for (const crash of ['exit', 'kill'] as const) {
    await withTemp(async (temp, store) => {
      store.addExperience({ scope: 'personal', kind: 'pitfall', summary: '遇到 ENOENT 报错先检查路径是不是软链接', source: 'manual', createdAt: T0 });
      const retriever = new LocalRetriever({
        stateDir: temp.stateDir,
        modelDir: temp.modelDir,
        daemonEntry: STUB_DAEMON,
        startupTimeoutMs: 30_000,
        spawnEnv: { MEMLOOM_TEST_CRASH: crash, MEMLOOM_TEST_SPAWN_COUNTER: temp.spawnCounter },
      });
      const started = Date.now();
      await assert.rejects(retriever.warmup(), (error: unknown) => {
        const candidate = error as { code?: string; message: string };
        return candidate.code === 'start_failed' && /启动阶段异常退出/.test(candidate.message) && (crash === 'kill' ? /SIGKILL/.test(candidate.message) : /退出码 7/.test(candidate.message));
      });
      const firstMs = Date.now() - started;
      assert.ok(firstMs < 3_000, `${crash}：真正退出后要马上报，不等 20 秒向量预算，实际 ${firstMs} 毫秒`);
      assert.equal(lines(temp.spawnCounter).length, 1, '只拉起一次');
      assert.ok(!existsSync(temp.socketPath));
      // 短窗口内不再重复拉起
      await assert.rejects(retriever.embed(['x'], 'query'), (error: unknown) => (error as { code?: string }).code === 'start_failed');
      const recallStarted = Date.now();
      const result = await hybridRecall({ store, scope: 'personal', query: 'ENOENT', retriever });
      const recallMs = Date.now() - recallStarted;
      assert.equal(lines(temp.spawnCounter).length, 1, '混合召回也没有再拉起');
      assert.equal(result.mode.stage, 'lexical-only');
      assert.equal(result.mode.reranked, false);
      assert.match(result.mode.vectorReason ?? '', crash === 'kill' ? /SIGKILL/ : /退出码 7/);
      assert.match(result.mode.rerankReason ?? '', /不再等精排/);
      assert.ok(recallMs < 1_500, `${crash}：本地服务已确定不可用，不再花第二份精排预算，实际 ${recallMs} 毫秒`);
      assert.equal(result.items[0]?.experience?.summary.includes('ENOENT'), true);
    });
  }
});

test('本地检索器配置了不支持的维度：明确提示并安全退回，health 不说健康', async () => {
  await withTemp(async (temp) => {
    const retriever = new LocalRetriever({ stateDir: temp.stateDir, modelDir: temp.modelDir, daemonEntry: STUB_DAEMON, dimensions: 256 });
    const health = await retriever.health();
    assert.equal(health.ok, false);
    assert.equal(health.mode, 'fts-only');
    assert.match(health.detail ?? '', /只支持 512 维/);
    await assert.rejects(retriever.embed(['x'], 'query'), (error: unknown) => (error as { code?: string }).code === 'model_missing');
    assert.ok(!existsSync(temp.lockPath), '连锁目录都没建，没有拉起任何进程');
  });
});

test('真实守护进程入口：模型加载失败时客户端快速得到明确错误、30 秒内不再反复拉起，混合召回退回字面', async () => {
  await withTemp(async (temp, store) => {
    store.addExperience({ scope: 'personal', kind: 'pitfall', summary: '遇到 ENOENT 报错先检查路径是不是软链接', source: 'manual', createdAt: T0 });
    const retriever = new LocalRetriever({ stateDir: temp.stateDir, modelDir: temp.modelDir, daemonEntry: REAL_DAEMON, startupTimeoutMs: 20_000 });
    await assert.rejects(retriever.warmup(), (error: unknown) => (error as { code?: string }).code === 'start_failed' && /模型加载失败/.test((error as Error).message));
    assert.ok(existsSync(join(temp.stateDir, 'retriever.last-error')));
    const started = Date.now();
    await assert.rejects(retriever.embed(['x'], 'query'), (error: unknown) => (error as { code?: string }).code === 'start_failed');
    assert.ok(Date.now() - started < 1_000, '刚失败过就不再重新拉起等它');
    const result = await hybridRecall({ store, scope: 'personal', query: 'ENOENT', retriever });
    assert.equal(result.mode.stage, 'lexical-only');
    assert.equal(result.mode.reranked, false);
    assert.match(result.mode.vectorReason ?? '', /起不来/);
    assert.equal(result.items[0]?.experience?.summary.includes('ENOENT'), true);
  });
});

test('缺模型目录：不拉起任何进程，embed 直接不可用，health 如实说 fts-only', async () => {
  await withTemp(async (temp) => {
    const retriever = new LocalRetriever({ stateDir: temp.stateDir, modelDir: join(temp.root, 'nope'), daemonEntry: STUB_DAEMON });
    const health = await retriever.health();
    assert.equal(health.ok, false);
    assert.equal(health.mode, 'fts-only');
    await assert.rejects(retriever.embed(['x'], 'query'), (error: unknown) => (error as { code?: string }).code === 'model_missing');
    assert.equal(existsSync(temp.socketPath), false, '没有拉起任何进程');
    assert.equal(existsSync(temp.lockPath), false);
  });
});
