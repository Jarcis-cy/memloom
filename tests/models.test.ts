import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/core/index.js';
import { HostCore, MemorySessionStore } from '../src/host/index.js';
import {
  acquireDownloadLock,
  AutoRetriever,
  createRetriever,
  DEFAULT_RETRY_BACKOFF_MS,
  hybridRecall,
  LocalRetriever,
  localModelsPresent,
  modelDownloadStatus,
  normalizeEndpoint,
  OFFICIAL_ENDPOINT,
  PINNED_MODELS,
  planModelDownload,
  prepareHostRetriever,
  readDownloadLock,
  readDownloadState,
  resolveLocalModelId,
  resolveLocalModels,
  runModelDownload,
  autoDownloadBlockReason,
} from '../src/retriever/index.js';
import { fakeModelFiles, startFakeHub, type FakeHub } from './fixtures/retriever/fake-hub.js';
import type { PinnedModels } from '../src/retriever/models-manifest.js';

/**
 * 模型下载的离线回环（返工方案 §3.2 第 4 点）：全部只对 127.0.0.1 的替身发请求，不联网。
 * 覆盖：正常下载与摘要校验、坏摘要重下、断点续传、跳转、双进程同锁只下一次、失败进退避且手动可重试、
 * 固定清单 / 地址 / 文件名的硬边界、`memloom models status|download` 真实进程、缺模型时第一轮召回不等网络，
 * 以及同一个活实例从 fts-only 热切换到本地检索（模型内容真的下下来，走真实的共享守护进程替身，不是改状态字符串）。
 */

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const STUB_DAEMON = fileURLToPath(new URL('./fixtures/retriever/stub-daemon.js', import.meta.url));
const EXPECTED_MODEL_ID = 'qwen3-embedding-0.6b@c25a394:int8:512';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'memloom-models-'));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒还没等到：${what}`);
    await sleep(stepMs);
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** 真实命令行进程，硬超时；环境继承测试进程（已经被 offline-preload 关掉自动下载），再叠加显式变量 */
function runCli(args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

function spawnCli(args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      stderr += String(error);
      resolve({ code: 1, stdout, stderr, elapsedMs: Date.now() - started });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function withHub<T>(behaviors: Parameters<typeof startFakeHub>[0]['behaviors'], fn: (hub: FakeHub, root: string) => Promise<T>): Promise<T> {
  const root = temp();
  const hub = await startFakeHub({ fixtureDir: root, behaviors });
  try {
    return await fn(hub, root);
  } finally {
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const stateIs = (stateDir: string, state: string): boolean => readDownloadState(stateDir)?.state === state;

/** 夹具清单里所有文件的总字节数 */
function fixtureTotalBytes(manifest: PinnedModels): number {
  return (['embedding', 'reranker'] as const).flatMap((kind) => Object.values(manifest[kind].files)).reduce((sum, meta) => sum + meta.bytes, 0);
}

test('npm test 的统一离线开关：自动下载默认关着，任何测试派生的子进程都继承它', () => {
  assert.equal(process.env.MEMLOOM_AUTO_DOWNLOAD, '0');
  assert.equal(process.env.MEMLOOM_HF_ENDPOINT, undefined);
  assert.equal(process.env.HF_ENDPOINT, undefined);
});

test('固定清单：两个仓库的 ONNX 都有有效 sha256，默认计划约 1.75 GiB、在 3 GiB 以内；任意文件名和非法镜像地址一律拒绝', async () => {
  for (const kind of ['embedding', 'reranker'] as const) {
    for (const [path, meta] of Object.entries(PINNED_MODELS[kind].files)) {
      if (path.startsWith('onnx/')) assert.match(meta.sha256 ?? '', /^[0-9a-f]{64}$/, `${kind}/${path} 必须有 sha256`);
      else assert.ok(meta.sha256 || meta.gitSha1, `${kind}/${path} 至少有一种摘要`);
    }
  }
  const plan = planModelDownload({ modelDir: '/tmp/memloom-plan-probe', endpoint: OFFICIAL_ENDPOINT });
  assert.equal(plan.files.length, 12);
  assert.equal(plan.models.embedding.file, 'onnx/model_int8.onnx');
  assert.equal(plan.models.reranker.file, 'onnx/model_quantized.onnx');
  assert.ok(plan.totalBytes > 1.7 * 1024 ** 3 && plan.totalBytes < 3 * 1024 ** 3, `默认总量 ${plan.totalBytes} 字节`);
  assert.throws(() => planModelDownload({ modelDir: '/tmp/x', endpoint: OFFICIAL_ENDPOINT, embedding: '../etc/passwd.onnx' }), /只支持这些文件/);
  assert.throws(() => planModelDownload({ modelDir: '/tmp/x', endpoint: OFFICIAL_ENDPOINT, reranker: 'model_fp16.onnx' }), /只支持这些文件/);
  assert.throws(() => normalizeEndpoint('http://example.com'), /只接受 https/);
  assert.throws(() => normalizeEndpoint('https://user:pw@hf-mirror.com'), /账号密码/);
  assert.throws(() => normalizeEndpoint('https://hf-mirror.com/v1'), /不要带路径/);
  assert.equal(normalizeEndpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080', '回环地址允许 http');
  assert.equal(normalizeEndpoint('https://hf-mirror.com/'), 'https://hf-mirror.com');
  assert.throws(() => normalizeEndpoint('ftp://hf-mirror.com'), /只接受 https/);
});

test('对真实源不认任何外部清单：测试清单只在回环地址下生效，拒绝时什么都没建', async () => {
  await assert.rejects(
    runModelDownload({ stateDir: '/tmp/memloom-plan-probe-state', modelDir: '/tmp/memloom-plan-probe', endpoint: OFFICIAL_ENDPOINT, env: { MEMLOOM_TEST_MODEL_MANIFEST: '/nonexistent' } }),
    /只能配合回环地址/,
  );
  assert.equal(existsSync('/tmp/memloom-plan-probe'), false);
  assert.equal(existsSync('/tmp/memloom-plan-probe-state'), false);
});

test('回环正路：12 个文件全部按固定清单校验落盘，模型清单最后才写，modelId 算得出；不带凭据；再跑一次全部跳过、零请求', async () => {
  await withHub({ 'embedding/tokenizer.json': { redirectOnce: true } }, async (hub, root) => {
    const modelDir = join(root, 'models');
    const stateDir = join(root, 'state');
    const result = await runModelDownload({ stateDir, modelDir, endpoint: hub.baseUrl, pinned: hub.manifest, onProgress: () => undefined });
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 12);
    assert.ok(result.files.every((file) => file.status === 'downloaded'));
    assert.equal(result.modelId, EXPECTED_MODEL_ID);
    assert.equal(localModelsPresent(modelDir), true);
    assert.equal(resolveLocalModelId(modelDir), EXPECTED_MODEL_ID);
    const manifest = JSON.parse(readFileSync(join(modelDir, 'embedding', 'memloom-model.json'), 'utf8')) as { repo: string; file: string; endpoint: string; files: Record<string, { bytes: number }> };
    assert.equal(manifest.file, 'onnx/model_int8.onnx');
    assert.equal(manifest.endpoint, hub.baseUrl);
    assert.equal(Object.keys(manifest.files).length, 6);
    assert.ok(existsSync(join(modelDir, 'manifest.json')), '总清单也在');
    const record = readDownloadState(stateDir);
    assert.ok(record && record.state === 'ready' && record.modelDir === modelDir && record.totalBytes === result.alreadyPresent + result.downloadedBytes);
    assert.ok(existsSync(join(stateDir, 'model-download.log')));
    // 请求形态：只打固定路径，Range 只在续传时出现，没有 Authorization，带自己的 User-Agent
    assert.equal(hub.requests.length, 12 + 1, '12 个文件 + 1 次 302');
    assert.ok(hub.requests.every((request) => request.authorization === null), '不带任何凭据');
    assert.ok(hub.requests.every((request) => request.userAgent?.startsWith('memloom/')));
    assert.ok(hub.requests.some((request) => request.url.startsWith('/redirected/')), '跟着 302 走过');
    assert.ok(hub.requests.every((request) => /\/resolve\/[0-9a-f]{40}\//.test(request.url)), 'revision 是完整提交哈希');
    // 再跑一次：全部已有且校验通过，不再发请求
    const again = await runModelDownload({ stateDir, modelDir, endpoint: hub.baseUrl, pinned: hub.manifest });
    assert.ok(again.files.every((file) => file.status === 'present'));
    assert.equal(again.downloadedBytes, 0);
    assert.equal(hub.requests.length, 13);
    assert.equal(readDownloadLock(modelDir), null, '锁已释放');
  });
});

test('坏摘要重下：第一次给同样长度但摘要不对的字节 → 删掉重下，第二次对上才落盘；镜像自己报什么都不算数', async () => {
  await withHub({ 'embedding/onnx/model_int8.onnx': { corruptFirst: true } }, async (hub, root) => {
    const result = await runModelDownload({ stateDir: join(root, 'state'), modelDir: join(root, 'models'), endpoint: hub.baseUrl, pinned: hub.manifest });
    assert.equal(result.files.find((file) => file.path === 'onnx/model_int8.onnx')?.status, 'downloaded');
    assert.equal(hub.served['embedding/onnx/model_int8.onnx'], 2, '坏一次、重下一次');
    const bytes = readFileSync(join(root, 'models', 'embedding', 'onnx', 'model_int8.onnx'));
    assert.deepEqual(bytes, fakeModelFiles()['embedding']['onnx/model_int8.onnx'], '最后落盘的是对的字节');
    assert.equal(existsSync(join(root, 'models', 'embedding', 'onnx', 'model_int8.onnx.part')), false);
  });
});

test('断点续传：第一次发一半就断 → .part 留着，紧接着带 Range 续传，校验通过才算完；服务端不认 Range 时从头重下', async () => {
  await withHub({ 'reranker/onnx/model_quantized.onnx': { cutFirst: 30_000 }, 'embedding/onnx/model_int8.onnx': { ignoreRange: true } }, async (hub, root) => {
    const result = await runModelDownload({ stateDir: join(root, 'state'), modelDir: join(root, 'models'), endpoint: hub.baseUrl, pinned: hub.manifest });
    assert.equal(result.files.find((file) => file.path === 'onnx/model_quantized.onnx')?.status, 'resumed');
    const rerankerRequests = hub.requests.filter((request) => request.url.endsWith('/onnx/model_quantized.onnx'));
    assert.equal(rerankerRequests.length, 2);
    assert.equal(rerankerRequests[0]?.range, null);
    assert.equal(rerankerRequests[1]?.range, `bytes=30000-`);
    assert.equal(result.downloadedBytes, result.files.reduce((sum, file) => sum + file.bytes, 0), '断掉的那 30000 字节也算收过的字节；续传只补剩下的，不重下整份');
    assert.equal(existsSync(join(root, 'models', 'reranker', 'onnx', 'model_quantized.onnx.part')), false, '续传完成后 .part 改名成正式文件');
  });
});

test('双进程同锁只下一次：两个 `memloom models download` 同时往同一个目录下，一个赢、另一个如实退出不抢', async () => {
  await withHub({ 'embedding/onnx/model_int8.onnx': { delayMs: 1_500 } }, async (hub, root) => {
    const env = { MEMLOOM_TEST_MODEL_MANIFEST: hub.manifestPath };
    const args = ['models', 'download', '--mirror', hub.baseUrl, '--out', join(root, 'models'), '--state-dir', join(root, 'state')];
    const [a, b] = await Promise.all([spawnCli(args, env), spawnCli(args, env)]);
    const [winner, loser] = a.code === 0 ? [a, b] : [b, a];
    assert.equal(winner.code, 0, winner.stderr);
    assert.equal(loser.code, 1);
    assert.match(loser.stderr, /另一个下载进程（pid=\d+）正在往同一个模型目录下载，不抢/);
    assert.equal(hub.served['embedding/onnx/model_int8.onnx'], 1, '大文件只完整下了一次');
    assert.match(winner.stdout + loser.stdout, /下载完成|已在后台/);
    assert.equal(stateIs(join(root, 'state'), 'ready'), true);
  });
});

test('失败进退避：镜像回 503 → failed + 中文原因 + 30 分钟退避，自动触发不再拉；手动下载不受退避限制', async () => {
  await withHub({ 'embedding/onnx/model_int8.onnx': { failTimes: 1 } }, async (hub, root) => {
    const modelDir = join(root, 'models');
    const stateDir = join(root, 'state');
    await assert.rejects(runModelDownload({ stateDir, modelDir, endpoint: hub.baseUrl, pinned: hub.manifest, retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS }), /HTTP 503/);
    const record = readDownloadState(stateDir);
    assert.ok(record && record.state === 'failed');
    assert.match(record?.error ?? '', /HTTP 503/);
    const until = Date.parse(record?.retryAfter ?? '');
    assert.ok(until - Date.now() > 29 * 60 * 1000 && until - Date.now() <= 30 * 60 * 1000, '退避到 30 分钟后');
    const block = autoDownloadBlockReason({ modelDir, stateDir });
    assert.ok(block && block.kind === 'backoff' && /手动运行 memloom models download 不受这个限制/.test(block.reason));
    const status = modelDownloadStatus({ modelDir, stateDir, env: {}, autoDownload: true });
    assert.equal(status.download.state, 'failed');
    assert.equal(status.download.in_backoff, true);
    assert.equal(status.download.running, false);
    assert.equal(existsSync(join(modelDir, 'embedding', 'memloom-model.json')), false, '没就绪就不写清单');
    // 手动再来：锁已释放、退避不拦，这次成功
    const manual = await runModelDownload({ stateDir, modelDir, endpoint: hub.baseUrl, pinned: hub.manifest });
    assert.equal(manual.modelId, EXPECTED_MODEL_ID);
    assert.equal(stateIs(stateDir, 'ready'), true);
    assert.equal(autoDownloadBlockReason({ modelDir, stateDir }), null);
  });
});

const MODELS_MODULE = new URL('../src/retriever/models.js', import.meta.url).href;

/** 独立的竞争者进程：按剧本在选票 / 出票的窗口里停住，拿到锁就进临界区（写 cs-<角色>），等父进程放行再释放 */
function runContender(modelDir: string, role: 'A' | 'T' | 'X' | 'P' | 'Q', flagDir: string): Promise<Record<string, unknown> & { code?: number }> {
  const script = `
    import { existsSync, writeFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { acquireDownloadLock, readDownloadLock } from ${JSON.stringify(MODELS_MODULE)};
    const [modelDir, role, flagDir] = process.argv.slice(1);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (file) => { for (let i = 0; i < 1500 && !existsSync(file); i += 1) await sleep(20); };
    const hooks = role === 'A'
      ? { afterMarker: async () => { writeFileSync(join(flagDir, 'a-marker'), String(process.pid)); await waitFor(join(flagDir, 'go-a')); } }
      : role === 'T'
        ? { afterTicket: async () => { writeFileSync(join(flagDir, 't-ticket'), String(process.pid)); await waitFor(join(flagDir, 'go-t')); } }
        : {};
    let out;
    try {
      const result = await acquireDownloadLock(modelDir, hooks);
      if (result.kind === 'acquired') {
        writeFileSync(join(flagDir, 'cs-' + role), JSON.stringify({ pid: process.pid, lock: readDownloadLock(modelDir) }));
        await waitFor(join(flagDir, 'release-' + role));
        result.release();
        out = { kind: 'acquired', pid: result.mine.pid, ticket: result.mine.ticket, released: true, dir: readdirSync(join(modelDir, '.download.lock')) };
      } else out = result;
    } catch (error) {
      out = { kind: 'error', error: String(error && error.message ? error.message : error) };
    }
    process.stdout.write(JSON.stringify(out) + '\\n');
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, modelDir, role, flagDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ kind: 'spawn-error', error: String(error) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        resolve({ ...(JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>), code: code ?? -1 });
      } catch {
        resolve({ kind: 'bad-output', stdout, stderr, code: code ?? -1 });
      }
    });
  });
}

const lockEntries = (modelDir: string): string[] => readdirSync(join(modelDir, '.download.lock')).sort();

test('锁：面包店锁目录，活锁不抢、死 owner 的唯一命名残文件被接管、旧普通文件草稿 / 活持有者 / 符号链接各有交代，释放后消失', async () => {
  const root = temp();
  try {
    const modelDir = join(root, 'models');
    const first = await acquireDownloadLock(modelDir);
    assert.equal(first.kind, 'acquired', JSON.stringify(first));
    assert.equal(first.kind === 'acquired' && first.mine.ticket, 1);
    assert.equal(readDownloadLock(modelDir)?.pid, process.pid, '拿到锁之后锁目录里指向的就是本进程');
    assert.deepEqual(lockEntries(modelDir), [`ticket.${process.pid}`], '只剩自己的票，选择牌已撤');
    assert.equal(existsSync(join(modelDir, '.download.lock', `choosing.${process.pid}`)), false);
    // 活锁在手上时跑下载：不抢、不写状态
    await assert.rejects(runModelDownload({ stateDir: join(root, 'state'), modelDir, endpoint: 'http://127.0.0.1:9', pinned: null, env: {} }), /不抢/);
    assert.equal(existsSync(join(root, 'state', 'model-download.json')), false);
    if (first.kind === 'acquired') first.release();
    assert.equal(readDownloadLock(modelDir), null, '释放后锁不再指向任何人');

    // 死 owner 的票和选择牌：读锁时不算活着；下次抢锁时按唯一文件名清掉，不去碰任何活着的标记
    const dir = join(modelDir, '.download.lock');
    writeFileSync(join(dir, 'ticket.2147483646'), JSON.stringify({ ticket: 1, pid: 2147483646, startedAt: 'x', entry: 'main.js', modelDir }));
    writeFileSync(join(dir, 'choosing.2147483645'), JSON.stringify({ ticket: 0, pid: 2147483645, startedAt: 'x', entry: 'main.js', modelDir }));
    assert.equal(readDownloadLock(modelDir), null, '死 pid 的票不算活着');
    const third = await acquireDownloadLock(modelDir);
    assert.equal(third.kind, 'acquired');
    assert.equal(existsSync(join(dir, 'ticket.2147483646')), false, '死 owner 的票被清掉');
    assert.equal(existsSync(join(dir, 'choosing.2147483645')), false);
    if (third.kind === 'acquired') third.release();

    // 旧实现留下的 0 字节普通文件（没发布完的草稿）：当残锁处理，unlink 后建目录
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(join(modelDir, '.download.lock'), '');
    const fourth = await acquireDownloadLock(modelDir);
    assert.equal(fourth.kind, 'acquired');
    assert.equal(statSync(join(modelDir, '.download.lock')).isDirectory(), true);
    if (fourth.kind === 'acquired') fourth.release();

    // 旧实现留下的普通文件，但拥有者还活着（命令行里带 main.js 的进程）：当它持有，不抢
    rmSync(dir, { recursive: true, force: true });
    const dummy = spawn(process.execPath, ['-e', '/* main.js */ setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await waitFor('占位的旧版持有者起来', () => dummy.pid !== undefined, 5_000, 10);
    const dummyPid = dummy.pid as number;
    try {
      writeFileSync(join(modelDir, '.download.lock'), JSON.stringify({ pid: dummyPid, startedAt: 'x', entry: 'main.js', modelDir }));
      assert.equal(readDownloadLock(modelDir)?.pid, dummyPid);
      const held = await acquireDownloadLock(modelDir);
      assert.equal(held.kind, 'held');
      assert.equal(held.kind === 'held' && held.holder.pid, dummyPid);
      assert.equal(existsSync(join(modelDir, '.download.lock')), true, '活着的新旧持有者的文件都没被删');
    } finally {
      dummy.kill('SIGKILL');
      await new Promise<void>((resolve) => dummy.once('exit', () => resolve()));
    }
    await waitFor('占位进程退出后判死', () => !readDownloadLock(modelDir), 5_000, 20);
    const fifth = await acquireDownloadLock(modelDir);
    assert.equal(fifth.kind, 'acquired', '旧持有者退出后接管');
    if (fifth.kind === 'acquired') fifth.release();

    // 符号链接占着锁路径：拒绝，且不删它
    rmSync(dir, { recursive: true, force: true });
    symlinkSync('/nonexistent/target', join(modelDir, '.download.lock'));
    await assert.rejects(acquireDownloadLock(modelDir), /符号链接/);
    assert.equal(lstatSync(join(modelDir, '.download.lock')).isSymbolicLink(), true, '没动别人的符号链接');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('定向双进程竞选（发布窗口）：A 停在选择牌之后、出票之前，B 先到也得等 A 选完；最后只有一个临界区，锁指向胜者', async () => {
  const root = temp();
  try {
    const modelDir = join(root, 'models');
    mkdirSync(modelDir, { recursive: true });
    const flagDir = join(root, 'flags');
    mkdirSync(flagDir, { recursive: true });
    const a = runContender(modelDir, 'A', flagDir);
    await waitFor('A 发布选择牌', () => existsSync(join(flagDir, 'a-marker')), 10_000, 20);
    const pidA = Number(readFileSync(join(flagDir, 'a-marker'), 'utf8'));
    assert.deepEqual(lockEntries(modelDir), [`choosing.${pidA}`], '只有 A 的选择牌，还没有任何票');
    assert.equal(readDownloadLock(modelDir), null, '还在选票的人不算持有者');
    const b = runContender(modelDir, 'X', flagDir);
    await waitFor('B 也进入竞选', () => lockEntries(modelDir).some((name) => !name.endsWith(String(pidA))), 10_000, 10);
    writeFileSync(join(flagDir, 'go-a'), '1');
    await waitFor('有人进了临界区', () => existsSync(join(flagDir, 'cs-A')) || existsSync(join(flagDir, 'cs-X')), 15_000, 20);
    const winner = existsSync(join(flagDir, 'cs-A')) ? 'A' : 'X';
    const critical = JSON.parse(readFileSync(join(flagDir, `cs-${winner}`), 'utf8')) as { pid: number; lock: { pid: number } | null };
    assert.equal(critical.lock?.pid, critical.pid, '成功时锁目录里指向的就是临界区里的那个进程');
    writeFileSync(join(flagDir, `release-${winner}`), '1');
    const [ra, rb] = await Promise.all([a, b]);
    const kinds = [ra.kind, rb.kind].sort();
    assert.deepEqual(kinds, ['acquired', 'held'], JSON.stringify([ra, rb]));
    assert.equal(existsSync(join(flagDir, 'cs-A')) && existsSync(join(flagDir, 'cs-X')), false, '只有一个人进了临界区');
    assert.equal(readDownloadLock(modelDir), null, '释放后不再指向任何人');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('定向双进程竞选（出票窗口）：T 已出票停在扫描之前，后来的 B 票号更大立刻退出不下载；T 醒来后独占，锁仍指向 T', async () => {
  const root = temp();
  try {
    const modelDir = join(root, 'models');
    mkdirSync(modelDir, { recursive: true });
    const flagDir = join(root, 'flags');
    mkdirSync(flagDir, { recursive: true });
    const t = runContender(modelDir, 'T', flagDir);
    await waitFor('T 出票', () => existsSync(join(flagDir, 't-ticket')), 10_000, 20);
    const pidT = Number(readFileSync(join(flagDir, 't-ticket'), 'utf8'));
    assert.equal(readDownloadLock(modelDir)?.pid, pidT, '票已发布，就算持有者（哪怕它还没开始扫描）');
    const b = await runContender(modelDir, 'X', flagDir);
    assert.equal(b.kind, 'held', JSON.stringify(b));
    assert.equal(b.holder !== undefined && (b.holder as { pid: number }).pid, pidT, 'B 看到的持有者就是 T');
    assert.equal(existsSync(join(flagDir, 'cs-X')), false, 'B 没进临界区');
    writeFileSync(join(flagDir, 'go-t'), '1');
    await waitFor('T 进临界区', () => existsSync(join(flagDir, 'cs-T')), 10_000, 20);
    const critical = JSON.parse(readFileSync(join(flagDir, 'cs-T'), 'utf8')) as { pid: number; lock: { pid: number; ticket: number } | null };
    assert.equal(critical.pid, pidT);
    assert.equal(critical.lock?.pid, pidT);
    assert.equal(critical.lock?.ticket, 1, '较晚来的 B 不会拿到比 T 更小的票');
    writeFileSync(join(flagDir, 'release-T'), '1');
    const rt = await t;
    assert.equal(rt.kind, 'acquired');
    assert.equal(readDownloadLock(modelDir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同进程互斥：同一个模型目录（含等价路径写法）两个请求并发，第一释放前只有一个 acquired、另一个 busy；已持有再来给 held；旧 release 重复调用清不掉新主人；竞选早期失败后能重试', async () => {
  const root = temp();
  try {
    const modelDir = join(root, 'models');
    // 复现父台给的脚本：两个请求并发，路径写法不同（./ 和尾斜杠）但指向同一个目录
    const [a, b] = await Promise.all([acquireDownloadLock(modelDir), acquireDownloadLock(`${join(root, '.', 'models')}/`)]);
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ['acquired', 'busy'], JSON.stringify([a, b]));
    const acquired = a.kind === 'acquired' ? a : (b.kind === 'acquired' ? b : null);
    const busy = a.kind === 'busy' ? a : b;
    assert.ok(acquired, '恰有一个拿到');
    assert.match(busy.kind === 'busy' ? busy.note : '', /本进程.*不重复抢/);
    assert.equal(acquired.mine.ticket, 1);
    assert.equal(readDownloadLock(modelDir)?.pid, process.pid, '锁目录里只有本进程的一张票');
    assert.deepEqual(readdirSync(join(modelDir, '.download.lock')), [`ticket.${process.pid}`], '第一次的选择牌 / 票没被第二个请求动过');
    // 已持有再来：held，回执指向同一张票
    const again = await acquireDownloadLock(modelDir);
    assert.equal(again.kind, 'held');
    assert.equal(again.kind === 'held' && again.holder.ticket, acquired.mine.ticket);
    // 释放后能再拿；旧 release 再调一次不会清掉新主人的票和入场记录
    acquired.release();
    assert.equal(readDownloadLock(modelDir), null);
    const second = await acquireDownloadLock(modelDir);
    assert.equal(second.kind, 'acquired');
    acquired.release();
    assert.equal(readDownloadLock(modelDir)?.pid, process.pid, '旧 release 没清掉新主人');
    assert.equal((await acquireDownloadLock(modelDir)).kind, 'held', '新主人仍然持着');
    second.release();
    assert.equal(readDownloadLock(modelDir), null);
    // 竞选早期失败（锁路径被符号链接占着）：入场记录必须自己清掉，换掉符号链接后能重试
    rmSync(join(modelDir, '.download.lock'), { recursive: true, force: true });
    symlinkSync('/nonexistent/target', join(modelDir, '.download.lock'));
    await assert.rejects(acquireDownloadLock(modelDir), /符号链接/);
    unlinkSync(join(modelDir, '.download.lock'));
    const retried = await acquireDownloadLock(modelDir);
    assert.equal(retried.kind, 'acquired', '失败后退场干净，可以重试');
    retried.release();
    // 其它目录不受影响：同时可以各拿各的
    const other = join(root, 'other-models');
    const x = await acquireDownloadLock(modelDir);
    const y = await acquireDownloadLock(other);
    assert.equal(x.kind, 'acquired');
    assert.equal(y.kind, 'acquired');
    if (x.kind === 'acquired') x.release();
    if (y.kind === 'acquired') y.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('定向双进程竞选（已有死 owner）：两个角色不同的进程同时争一个带着死票和死选择牌的目录，输家明确返回 held / busy 之后主进程才放赢家；真双持会红', async () => {
  const root = temp();
  try {
    const modelDir = join(root, 'models');
    const dir = join(modelDir, '.download.lock');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'ticket.2147483646'), JSON.stringify({ ticket: 1, pid: 2147483646, startedAt: 'x', entry: 'main.js', modelDir }));
    writeFileSync(join(dir, 'choosing.2147483645'), JSON.stringify({ ticket: 0, pid: 2147483645, startedAt: 'x', entry: 'main.js', modelDir }));
    const flagDir = join(root, 'flags');
    mkdirSync(flagDir, { recursive: true });
    const returned: Record<string, Record<string, unknown> | null> = { P: null, Q: null };
    const track = (role: 'P' | 'Q', promise: Promise<Record<string, unknown> & { code?: number }>) =>
      promise.then((result) => {
        returned[role] = result;
        return result;
      });
    const p = track('P', runContender(modelDir, 'P', flagDir));
    const q = track('Q', runContender(modelDir, 'Q', flagDir));
    // 等到：有人明确返回（必然是输家：赢家在临界区里等放行），或者两个临界区文件都出现（真双持）
    await waitFor(
      '输家明确返回或双临界区',
      () => returned.P !== null || returned.Q !== null || (existsSync(join(flagDir, 'cs-P')) && existsSync(join(flagDir, 'cs-Q'))),
      15_000,
      20,
    );
    assert.equal(existsSync(join(flagDir, 'cs-P')) && existsSync(join(flagDir, 'cs-Q')), false, '双临界区：两个进程都以为自己拿到了锁');
    const loserRole = returned.P !== null ? 'P' : 'Q';
    const winnerRole = loserRole === 'P' ? 'Q' : 'P';
    const loser = returned[loserRole] as Record<string, unknown>;
    assert.ok(loser.kind === 'held' || loser.kind === 'busy', `先返回的必须是输家，实际 ${JSON.stringify(loser)}`);
    assert.equal(returned[winnerRole], null, '赢家还在临界区里等放行');
    assert.equal(existsSync(join(flagDir, `cs-${loserRole}`)), false, '输家没进临界区');
    await waitFor('赢家进了临界区', () => existsSync(join(flagDir, `cs-${winnerRole}`)), 15_000, 20);
    const critical = JSON.parse(readFileSync(join(flagDir, `cs-${winnerRole}`), 'utf8')) as { pid: number; lock: { pid: number } | null };
    assert.equal(critical.lock?.pid, critical.pid, '成功时锁目录里指向的就是临界区里的那个进程');
    assert.equal(existsSync(join(dir, 'ticket.2147483646')), false, '死票被清掉');
    assert.equal(existsSync(join(dir, 'choosing.2147483645')), false);
    writeFileSync(join(flagDir, `release-${winnerRole}`), '1');
    const [rp, rq] = await Promise.all([p, q]);
    const winner = winnerRole === 'P' ? rp : rq;
    assert.equal(winner.kind, 'acquired');
    assert.equal(winner.pid, critical.pid);
    assert.equal(readDownloadLock(modelDir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('硬上限数的是累计收到的字节：坏摘要重下的那份、服务端不认 Range 重发的那段、中途断掉的那段都算；到上限停止且不再重试，落盘不超过上限', async () => {
  // 1) 上限正好等于整份：第一次给了坏摘要（整份字节收了却作废），重下到一半累计就超了 → 停，不再有第三次请求
  await withHub({ 'embedding/onnx/model_int8.onnx': { corruptFirst: true } }, async (hub, root) => {
    const total = fixtureTotalBytes(hub.manifest);
    const lines: string[] = [];
    await assert.rejects(
      runModelDownload({ stateDir: join(root, 'state'), modelDir: join(root, 'models'), endpoint: hub.baseUrl, pinned: hub.manifest, maxTotalBytes: total, onLine: (line) => lines.push(line) }),
      /总下载量超过上限.*不再重试/s,
    );
    assert.equal(hub.served['embedding/onnx/model_int8.onnx'], 2, '坏一次 + 重下一次，到上限就停，没有第三次');
    // 坏摘要多收的那一份把累计顶过头：向量模型（在前面）已经落盘，超限发生在精排模型的第一个字节上，它不会落成正式文件、也不再请求
    assert.equal(existsSync(join(root, 'models', 'embedding', 'onnx', 'model_int8.onnx')), true, '超限之前已经校验通过的文件照常保留');
    assert.equal(existsSync(join(root, 'models', 'reranker', 'onnx', 'model_quantized.onnx')), false, '超限那一刻在下的文件不会落成正式文件');
    assert.equal(hub.served['reranker/onnx/model_quantized.onnx'], 1, '超限之后不再请求');
    const record = readDownloadState(join(root, 'state'));
    assert.equal(record?.state, 'failed');
    assert.match(record?.error ?? '', /总下载量超过上限/);
    const part = join(root, 'models', 'embedding', 'onnx', 'model_int8.onnx.part');
    if (existsSync(part)) assert.ok(statSync(part).size <= total, '落盘的字节不超过上限');
  });
  // 2) 服务端不认 Range：已有的 30000 字节 .part 会再收一遍，这段重复字节计入累计
  const reranker = fakeModelFiles()['reranker']['onnx/model_quantized.onnx'] as Buffer;
  await withHub({ 'reranker/onnx/model_quantized.onnx': { ignoreRange: true } }, async (hub, root) => {
    const modelDir = join(root, 'models');
    mkdirSync(join(modelDir, 'reranker', 'onnx'), { recursive: true });
    writeFileSync(join(modelDir, 'reranker', 'onnx', 'model_quantized.onnx.part'), reranker.subarray(0, 30_000));
    const total = fixtureTotalBytes(hub.manifest);
    const lines: string[] = [];
    const ok = await runModelDownload({ stateDir: join(root, 'state'), modelDir, endpoint: hub.baseUrl, pinned: hub.manifest, maxTotalBytes: total, onLine: (line) => lines.push(line) });
    assert.equal(ok.downloadedBytes, total, '整份都算收过（包括已经在本地的那 30000 又收了一遍）');
    assert.ok(lines.some((line) => /不支持续传.*已有的 30000 字节会再收一遍/.test(line)));
    assert.equal(hub.requests.filter((request) => request.url.endsWith('/onnx/model_quantized.onnx') && request.range === 'bytes=30000-').length, 1, '先按续传要了');
  });
  // 3) 坏摘要（多收 65536）+ 中途断掉（断前 30000 字节已收）：累计 = 整份 + 65536（坏摘要多收的那份；断掉的 30000 和续传的剩余合起来还是整份），上限比它少 1 字节 → 续传的最后一块超限停止，不再有第三次
  await withHub({ 'embedding/onnx/model_int8.onnx': { corruptFirst: true }, 'reranker/onnx/model_quantized.onnx': { cutFirst: 30_000 } }, async (hub, root) => {
    const total = fixtureTotalBytes(hub.manifest);
    const onnx = fakeModelFiles()['embedding']['onnx/model_int8.onnx']?.byteLength ?? 0;
    const tight = await runModelDownload({ stateDir: join(root, 'state'), modelDir: join(root, 'models'), endpoint: hub.baseUrl, pinned: hub.manifest, maxTotalBytes: total + onnx - 1 }).catch((error: Error) => error);
    assert.ok(tight instanceof Error && /总下载量超过上限.*不再重试/s.test(tight.message), String(tight));
    assert.equal(hub.served['reranker/onnx/model_quantized.onnx'], 2, '断 + 续传到一半超限，没有第三次');
    assert.equal(existsSync(join(root, 'models', 'reranker', 'onnx', 'model_quantized.onnx')), false);
  });
  // 4) 同样的剧本，上限正好等于累计就成功；累计数把坏摘要那份和断掉的那段都算进去了
  await withHub({ 'embedding/onnx/model_int8.onnx': { corruptFirst: true }, 'reranker/onnx/model_quantized.onnx': { cutFirst: 30_000 } }, async (hub, root) => {
    const total = fixtureTotalBytes(hub.manifest);
    const onnx = fakeModelFiles()['embedding']['onnx/model_int8.onnx']?.byteLength ?? 0;
    const ok = await runModelDownload({ stateDir: join(root, 'state'), modelDir: join(root, 'models'), endpoint: hub.baseUrl, pinned: hub.manifest, maxTotalBytes: total + onnx });
    assert.equal(ok.modelId, EXPECTED_MODEL_ID);
    assert.equal(ok.downloadedBytes, total + onnx, '坏摘要多收的整份 + 其它全部文件，断掉的和续传的合起来只算一份，全算进累计');
  });
});

test('进度不重复计：已存在的文件只在开头算一次，结束时 downloadedBytes 正好等于固定清单总量', async () => {
  await withHub({}, async (hub, root) => {
    const modelDir = join(root, 'models');
    // 精排模型整个预先摆好（校验能过），向量模型从零下
    const reranker = fakeModelFiles()['reranker'];
    for (const [path, content] of Object.entries(reranker)) {
      mkdirSync(dirname(join(modelDir, 'reranker', path)), { recursive: true });
      writeFileSync(join(modelDir, 'reranker', path), content);
    }
    const events: number[] = [];
    await runModelDownload({ stateDir: join(root, 'state'), modelDir, endpoint: hub.baseUrl, pinned: hub.manifest, onProgress: (progress) => events.push(progress.downloadedBytes) });
    const total = fixtureTotalBytes(hub.manifest);
    assert.equal(Math.max(...events), total, '进度最高到总量，不会把已有的再算一遍');
    assert.equal(readDownloadState(join(root, 'state'))?.downloadedBytes, total);
  });
});

test('发布门槛：另一模型现成、本模型文件刚落盘但清单未写时不切（不同状态目录也一样），发布后同一实例热切到带 revision 的 modelId', async () => {
  await withHub({}, async (hub, root) => {
    const modelDir = join(root, 'models');
    const reranker = fakeModelFiles()['reranker'];
    for (const [path, content] of Object.entries(reranker)) {
      mkdirSync(dirname(join(modelDir, 'reranker', path)), { recursive: true });
      writeFileSync(join(modelDir, 'reranker', path), content);
    }
    const store = openStore(join(root, 's.db'));
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf', now: '2026-01-01T00:00:00.000Z' });
    const gate: { release: () => void; reached: () => void } = { release: () => undefined, reached: () => undefined };
    const paused = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      gate.reached = resolve;
    });
    try {
      const run = runModelDownload({
        stateDir: join(root, 'state'),
        modelDir,
        endpoint: hub.baseUrl,
        pinned: hub.manifest,
        hooks: {
          beforeModelManifest: async (kind) => {
            if (kind !== 'embedding') return;
            gate.reached();
            await paused;
          },
        },
      });
      await reached;
      // 向量模型的 6 个文件此刻都已落盘、精排模型本来就齐：按文件看已经「全齐」，只差清单；门槛必须挡住
      for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'onnx/model_int8.onnx']) {
        assert.equal(existsSync(join(modelDir, 'embedding', name)), true, name);
      }
      assert.equal(existsSync(join(modelDir, 'embedding', 'memloom-model.json')), false, '这就是那个窗口：文件齐了、清单没写');
      assert.equal(localModelsPresent(modelDir), false, '门槛关着：不当作就绪');
      assert.equal(resolveLocalModelId(modelDir), null);
      assert.throws(() => resolveLocalModels(modelDir), /下载中/);
      const same = new AutoRetriever({ stateDir: join(root, 'state'), modelDir, local: { daemonEntry: STUB_DAEMON, idleMs: 60_000 } });
      const other = new AutoRetriever({ stateDir: join(root, 'other-state'), modelDir, local: { daemonEntry: STUB_DAEMON, idleMs: 60_000 } });
      assert.equal(same.dimensions, 0);
      assert.equal(other.dimensions, 0, '同一个模型目录换一个状态目录看，也一样不早熟');
      assert.equal(prepareHostRetriever(same).retriever instanceof LocalRetriever, false);
      gate.release();
      const result = await run;
      assert.equal(result.modelId, EXPECTED_MODEL_ID);
      const rootManifest = JSON.parse(readFileSync(join(modelDir, 'manifest.json'), 'utf8')) as { state: string };
      assert.equal(rootManifest.state, 'ready');
      // 同一个实例：发布之后才懒创建本地客户端，modelId 带 revision，不会把 @unknown 缓存住
      const prepared = prepareHostRetriever(same);
      assert.ok(prepared.retriever instanceof LocalRetriever);
      assert.equal(same.modelId, EXPECTED_MODEL_ID);
      assert.equal(other.modelId, EXPECTED_MODEL_ID);
      const recalled = await hybridRecall({ store, scope: 'personal', query: '递归删文件夹的时候把软链接指向的那份也删了，怎么办', retriever: same, limit: 5 });
      assert.equal(recalled.mode.reranked, true, `发布后经过替身守护进程的精排：${JSON.stringify(recalled.mode)}`);
      assert.doesNotMatch(JSON.stringify(recalled.mode), /mismatch|unknown/);
      await (prepared.retriever as LocalRetriever).stop('测试结束');
      await sleep(300);
    } finally {
      gate.release();
      store.close();
    }
  });
});

test('真实进程：models download --json / models status 如实读回；非法地址和文件名退出 1；--background 立刻返回并在后台下完', async () => {
  await withHub({}, async (hub, root) => {
    const env = { MEMLOOM_TEST_MODEL_MANIFEST: hub.manifestPath };
    const stateDir = join(root, 'state');
    const modelDir = join(root, 'models');
    const badMirror = await runCli(['models', 'download', '--mirror', 'http://example.com', '--out', modelDir, '--state-dir', stateDir], env);
    assert.equal(badMirror.code, 1);
    assert.match(badMirror.stderr, /只接受 https/);
    const badFile = await runCli(['models', 'download', '--mirror', hub.baseUrl, '--out', modelDir, '--state-dir', stateDir, '--embedding', '../x.onnx'], env);
    assert.equal(badFile.code, 1);
    assert.match(badFile.stderr, /只支持这些文件/);
    // 测试清单对非回环地址不生效（换成 https 的假源也只能在联网时才失败，这里先证明它被拒绝在地址检查之前）
    const real = await runCli(['models', 'download', '--mirror', 'https://127.0.0.1:9', '--out', modelDir, '--state-dir', stateDir, '--json'], env);
    assert.equal(real.code, 1);
    assert.match(real.stderr, /只能配合回环地址|连不上下载源/);

    const download = await runCli(['models', 'download', '--mirror', hub.baseUrl, '--out', modelDir, '--state-dir', stateDir, '--json'], env);
    assert.equal(download.code, 0, download.stderr);
    const parsed = JSON.parse(download.stdout) as { background: boolean; model_id: string; files: Array<{ status: string }>; downloaded_bytes: number };
    assert.equal(parsed.background, false);
    assert.equal(parsed.model_id, EXPECTED_MODEL_ID);
    assert.equal(parsed.files.length, 12);

    // 文字版回执里的「这次实际下载」要跟着 downloaded_bytes 走（曾经错读成 camelCase 打出 NaN）
    const textDownload = await runCli(['models', 'download', '--mirror', hub.baseUrl, '--out', join(root, 'models-text'), '--state-dir', join(root, 'state-text')], env);
    assert.equal(textDownload.code, 0, textDownload.stderr);
    assert.match(textDownload.stdout, /这次实际下载 \d+\.\d MiB/);
    assert.doesNotMatch(textDownload.stdout + textDownload.stderr, /NaN/);
    const statusJson = await runCli(['models', 'status', '--out', modelDir, '--state-dir', stateDir, '--json'], env);
    assert.equal(statusJson.code, 0, statusJson.stderr);
    const status = JSON.parse(statusJson.stdout) as { ready: boolean; model_id: string; download: { state: string; running: boolean }; endpoint: string };
    assert.equal(status.ready, true);
    assert.equal(status.model_id, EXPECTED_MODEL_ID);
    assert.equal(status.download.state, 'ready');
    assert.equal(status.download.running, false);
    assert.equal(status.endpoint, 'https://huggingface.co');
    const text = await runCli(['models', 'status', '--out', modelDir, '--state-dir', stateDir], env);
    assert.match(text.stdout, /向量模型 embedding：已就绪（onnx\/model_int8\.onnx）/);
    assert.match(text.stdout, /精排模型 reranker：已就绪/);
    assert.match(text.stdout, /当前 modelId：qwen3-embedding-0\.6b@c25a394:int8:512/);
    assert.match(text.stdout, /后台下载：两个模型都已就绪/);
    const doctor = await runCli(['--db', join(root, 'a.db'), '--state-dir', stateDir, 'doctor'], { ...env, MEMLOOM_MODEL_DIR: modelDir });
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, /本地模型：目录 .*；向量模型 已就绪（onnx\/model_int8\.onnx）；精排模型 已就绪/);
    assert.match(doctor.stdout, /后台下载：两个模型都已就绪/);

    // --background：立刻退出，下载在脱离的子进程里做完
    const bg = await runCli(['models', 'download', '--mirror', hub.baseUrl, '--out', join(root, 'models-bg'), '--state-dir', join(root, 'state-bg'), '--background'], env);
    assert.equal(bg.code, 0, bg.stderr);
    assert.match(bg.stdout, /已在后台开始下载（pid=\d+）/);
    assert.ok(bg.elapsedMs < 5_000, '前台不等网络');
    await waitFor('后台下载就绪', () => stateIs(join(root, 'state-bg'), 'ready'), 30_000);
    assert.equal(localModelsPresent(join(root, 'models-bg')), true);
  });
});

test('缺模型时的第一轮召回不等网络：立即字面检索并拉起后台下载，下完 status 如实报告就绪；MEMLOOM_AUTO_DOWNLOAD=0 时零请求、不建任何状态', async () => {
  await withHub({ 'embedding/onnx/model_int8.onnx': { delayMs: 2_500 } }, async (hub, root) => {
    const env = { MEMLOOM_TEST_MODEL_MANIFEST: hub.manifestPath };
    // 关着自动下载（npm test 的默认环境）：召回、体检、状态都只读，替身一个请求都收不到，也不建目录
    const quietDb = join(root, 'quiet.db');
    await runCli(['--db', quietDb, '--state-dir', join(root, 'quiet-state'), 'capture', '--kind', 'pitfall', '--summary', '删目录之前先看一眼是不是软链接。'], { ...env, MEMLOOM_HF_ENDPOINT: hub.baseUrl });
    const quietRecall = await runCli(['--db', quietDb, '--state-dir', join(root, 'quiet-state'), 'recall', '软链接'], { ...env, MEMLOOM_HF_ENDPOINT: hub.baseUrl });
    assert.equal(quietRecall.code, 0, quietRecall.stderr);
    assert.match(quietRecall.stdout, /fts-only.*没经过模型精排/s);
    const quietDoctor = await runCli(['--db', quietDb, '--state-dir', join(root, 'quiet-state'), 'doctor'], { ...env, MEMLOOM_HF_ENDPOINT: hub.baseUrl });
    assert.match(quietDoctor.stdout, /自动下载：关闭/);
    assert.equal(hub.requests.length, 0, '关着自动下载时零请求');
    assert.equal(existsSync(join(root, 'quiet-state', 'model-download.json')), false);
    assert.equal(existsSync(join(root, 'quiet-state')), false, '关着自动下载时连状态目录都不建');

    // 打开自动下载：第一轮召回 2 秒内就回（替身拖着 2.5 秒不给字节），字面结果照常，后台把模型下完
    const db = join(root, 'a.db');
    const stateDir = join(root, 'state');
    const on = { ...env, MEMLOOM_HF_ENDPOINT: hub.baseUrl, MEMLOOM_AUTO_DOWNLOAD: '1' };
    await runCli(['--db', db, '--state-dir', stateDir, 'capture', '--kind', 'pitfall', '--summary', '删目录之前先看一眼是不是软链接。'], on);
    const started = Date.now();
    const recall = await runCli(['--db', db, '--state-dir', stateDir, 'recall', '软链接'], on);
    assert.equal(recall.code, 0, recall.stderr);
    assert.ok(Date.now() - started < 2_500, `第一轮召回不该等回环通过（用了 ${Date.now() - started} 毫秒）`);
    assert.match(recall.stdout, /fts-only.*lexical-only.*没经过模型精排/s);
    assert.match(recall.stdout, /\[E1\]/, '字面结果照常给');
    await waitFor('后台下载进程写下状态文件', () => existsSync(join(stateDir, 'model-download.json')), 10_000, 50);
    const during = await runCli(['models', 'status', '--state-dir', stateDir, '--json'], on);
    const duringStatus = JSON.parse(during.stdout) as { download: { state: string; running: boolean; pid: number | null } };
    assert.ok(['downloading', 'ready'].includes(duringStatus.download.state), JSON.stringify(duringStatus.download));
    if (duringStatus.download.state === 'downloading') {
      assert.equal(duringStatus.download.running, true);
      assert.ok(typeof duringStatus.download.pid === 'number');
    }
    await waitFor('后台下载就绪', () => stateIs(stateDir, 'ready'), 30_000);
    const after = JSON.parse((await runCli(['models', 'status', '--state-dir', stateDir, '--json'], on)).stdout) as { ready: boolean; model_id: string };
    assert.equal(after.ready, true);
    assert.equal(after.model_id, EXPECTED_MODEL_ID);
    assert.equal(localModelsPresent(join(stateDir, 'models')), true, '默认就下到 <状态目录>/models');
    const again = await runCli(['--db', db, '--state-dir', stateDir, 'recall', '软链接', '--json'], on);
    const parsedAgain = JSON.parse(again.stdout) as { mode: { retriever: string; vectorReason: string | null } };
    // 模型文件齐了，召回会切到本地共享服务；这里没有真实 ONNX 运行时，服务起不来时如实说，不冒充
    assert.ok(parsedAgain.mode.retriever === 'local-onnx' || parsedAgain.mode.retriever === 'fts-only');
  });
});

test('同一个活实例热切换：fts-only → 拉起后台下载 → 下完懒创建共享本地客户端，维度 / modelId 跟真实 delegate，召回真的经过替身精排', async () => {
  await withHub({ 'reranker/onnx/model_quantized.onnx': { delayMs: 800 } }, async (hub, root) => {
    process.env.MEMLOOM_TEST_MODEL_MANIFEST = hub.manifestPath;
    const stateDir = join(root, 'state');
    const modelDir = join(root, 'models');
    const store = openStore(join(root, 's.db'));
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf', now: '2026-01-01T00:00:00.000Z' });
    try {
      const retriever = createRetriever({
        mode: 'auto',
        stateDir,
        modelDir,
        mirror: hub.baseUrl,
        autoDownload: true,
        local: { daemonEntry: STUB_DAEMON, idleMs: 60_000, startupTimeoutMs: 30_000, spawnEnv: { MEMLOOM_TEST_SPAWN_COUNTER: join(root, 'spawns.log') } },
      });
      assert.ok(retriever instanceof AutoRetriever);
      assert.equal(retriever.dimensions, 0, '缺模型时没有维度，存量向量不会被拿来比');
      assert.equal((await retriever.health()).mode, 'fts-only');
      const first = await hybridRecall({ store, scope: 'personal', query: '删除目录的时候把快捷方式指向的那份也删了怎么办', retriever, limit: 5 });
      assert.equal(first.mode.retriever, 'fts-only');
      assert.equal(first.mode.stage, 'lexical-only');
      assert.equal(first.mode.reranked, false, '字面分不冒充精排分');
      assert.equal(first.mode.vectorReason, '检索器没有固定维度，存量向量不能比');
      assert.ok(first.items.length > 0 && first.items.every((item) => !item.reranked));
      await waitFor('后台下载进程真的向替身发了请求', () => hub.requests.length > 0, 15_000, 50);
      await waitFor('后台下载就绪', () => stateIs(stateDir, 'ready'), 30_000);
      // 同一个实例：模型齐了才懒创建本地客户端，连的是真实的共享守护进程替身
      const prepared = prepareHostRetriever(retriever);
      assert.ok(prepared.retriever instanceof LocalRetriever, '切到了 LocalRetriever');
      assert.equal(prepared.download, null, '已经就绪，不再拉起下载');
      assert.equal(retriever.dimensions, 512);
      assert.equal(retriever.modelId, EXPECTED_MODEL_ID);
      assert.equal(prepared.retriever.modelId, retriever.modelId, '对外身份和真实 delegate 一致');
      const [vector] = await retriever.embed(['软链接目录'], 'document');
      assert.equal(vector?.length, 512);
      const second = await hybridRecall({ store, scope: 'personal', query: '删除目录的时候把快捷方式指向的那份也删了怎么办', retriever, limit: 5 });
      assert.equal(second.mode.retriever, 'local-onnx');
      assert.equal(second.mode.reranked, true, '经过替身守护进程的精排');
      assert.equal(second.mode.stage, 'full');
      assert.equal((await retriever.health()).mode, 'local-onnx');
      // 再造一个新实例（同一个状态目录）：复用已经在跑的共享服务，不再拉起第二个
      const another = new AutoRetriever({ stateDir, modelDir, local: { daemonEntry: STUB_DAEMON, idleMs: 60_000, spawnEnv: { MEMLOOM_TEST_SPAWN_COUNTER: join(root, 'spawns.log') } } });
      assert.equal(another.modelId, EXPECTED_MODEL_ID);
      const [again] = await another.embed(['软链接目录'], 'document');
      assert.equal(again?.length, 512);
      await (prepared.retriever as LocalRetriever).stop('测试结束');
      await sleep(300);
    } finally {
      delete process.env.MEMLOOM_TEST_MODEL_MANIFEST;
      store.close();
    }
  });
});

test('宿主核心：session_start 显式预检登记 model-download（spawned），提醒先静默；下完之后同一会话的提醒真的走本地精排', async () => {
  await withHub({}, async (hub, root) => {
    process.env.MEMLOOM_TEST_MODEL_MANIFEST = hub.manifestPath;
    const dbPath = join(root, 'personal.db');
    const store = openStore(dbPath);
    store.addIronRule({ scope: 'personal', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: '2026-01-01T00:00:00.000Z' });
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf，防止顺着链接误删目标目录', now: '2026-01-01T00:00:00.000Z' });
    store.close();
    const core = new HostCore(
      {
        home: root,
        dbPath,
        scope: 'personal',
        projectDir: null,
        projectId: null,
        roleName: null,
        stateDir: root,
        llm: null,
        warmupOnStart: false,
        sessionStore: new MemorySessionStore(),
        hint: { budgetMs: 20_000 },
        retrieverConfig: { mode: 'auto', stateDir: root, modelDir: join(root, 'models'), mirror: hub.baseUrl, autoDownload: true, local: { daemonEntry: STUB_DAEMON, idleMs: 60_000, startupTimeoutMs: 30_000 } },
      },
      { jobMode: 'inline' },
    );
    try {
      const start = await core.handle({ type: 'session_start', sessionId: 's1' });
      const entry = start.background.find((item) => item.kind === 'model-download');
      assert.ok(entry, 'session_start 登记了后台下载');
      assert.equal(entry.state, 'spawned');
      assert.match(entry.reason ?? '', /正在后台下载/);
      const first = await core.handle({ type: 'user_message', sessionId: 's1', text: '删除目录的时候把快捷方式指向的那份也删了怎么办' });
      assert.equal(first.hint, '', '缺模型时没有语义能力，提醒保持安静');
      assert.equal(first.hintState, 'silent');
      assert.match(first.hintReason ?? '', /fts-only/);
      await waitFor('后台下载就绪', () => stateIs(root, 'ready'), 30_000);
      const second = await core.handle({ type: 'user_message', sessionId: 's1', text: '递归删文件夹的时候把软链接指向的那份也删了，怎么办' });
      assert.equal(second.hintState, 'hinted', `下完之后提醒应当命中：${JSON.stringify({ state: second.hintState, reason: second.hintReason, log: core.recentLog() })}`);
      assert.match(second.hint, /\[P1\] 先检查它是不是软链接/);
      assert.ok(core.recentLog().some((line) => /检索切换到本地语义模式/.test(line)), '热切换有日志可查');
    } finally {
      await core.settle();
      core.close();
      delete process.env.MEMLOOM_TEST_MODEL_MANIFEST;
    }
  });
});
