import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createSilentSocket, type AddressInfo, type Socket } from 'node:net';
import { openStore } from '../src/core/index.js';

/**
 * 真实进程的命令行端到端（临时库 + 临时 home，绝不碰 ~/.memloom、不联网、不调外部模型）：
 * capture → recall → export → 另一个库 import → recall；铁律与分歧的人工入口；后台模型走回环 OpenAI 兼容端点；
 * daemon status / stop 对真实进程骨架（离线替身）如实报告。
 */

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const STUB_DAEMON = fileURLToPath(new URL('./fixtures/retriever/stub-daemon.js', import.meta.url));
const REAL_HOME = join(homedir(), '.memloom');
const realHomeBefore = existsSync(REAL_HOME);

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'memloom-cli-'));
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Running {
  status: { state: string; pid: number; identity: string; modelId: string; note: string };
}

function home(): { root: string; env: Record<string, string> } {
  const root = temp();
  return { root, env: { MEMLOOM_HOME: root } };
}

test('真实进程正路：capture → recall → export → 另一个临时库 import → recall；重复导入不重复；无模型如实说；doctor 不碰真实 home', async () => {
  const { root, env } = home();
  try {
    const a = join(root, 'a.db');
    const b = join(root, 'b.db');
    const captured = await run(['--db', a, 'capture', '--kind', 'correction', '--summary', '删目录之前先 ls -la 看一眼是不是软链接，确认后再删。', '--evidence', '不对，先看看是不是软链接'], env);
    assert.equal(captured.code, 0, captured.stderr);
    assert.match(captured.stdout, /已记下经历 #1/);
    const detected = await run(['--db', a, 'capture', '--message', '不对，不要带尾斜杠直接 rm -rf。', '--session', 's1', '--turn', '3'], env);
    assert.equal(detected.code, 0, detected.stderr);
    assert.match(detected.stdout, /用户纠正了助手/);
    const quiet = await run(['--db', a, 'capture', '--message', '今天天气不错。', '--session', 's1', '--turn', '4'], env);
    assert.equal(quiet.code, 0);
    assert.match(quiet.stdout, /没有检测到纠错信号/);
    const rule = await run(['--db', a, 'iron-rules', 'add', '没有明说怎么处理就不许擅自动手改用户的项目文件。'], env);
    assert.equal(rule.code, 0, rule.stderr);

    const recalled = await run(['--db', a, 'recall', '软链接'], env);
    assert.equal(recalled.code, 0, recalled.stderr);
    assert.match(recalled.stdout, /\[E1\]/);
    assert.match(recalled.stdout, /fts-only.*没经过模型精排/s);

    const archive = join(root, 'personal.tar.gz');
    const exported = await run(['--db', a, 'export', '--out', archive, '--json'], env);
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).counts.experiences, 2);
    assert.equal(existsSync(archive), true);

    const imported = await run(['--db', b, 'import', archive], env);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /经历：新增 2/);
    assert.match(imported.stdout, /向量没有建：当前没有可用的向量模型/);
    const recalledB = await run(['--db', b, 'recall', '软链接', '--json'], env);
    assert.equal(recalledB.code, 0, recalledB.stderr);
    const parsedB = JSON.parse(recalledB.stdout) as { items: Array<{ type: string; summary: string }> };
    assert.equal(parsedB.items[0]?.summary, '删目录之前先 ls -la 看一眼是不是软链接，确认后再删。');
    const again = await run(['--db', b, 'import', archive, '--json'], env);
    assert.equal(again.code, 0);
    const report = JSON.parse(again.stdout) as { iron_rules: { added: number }; principles: { added: number }; experiences: { added: number; skipped: number } };
    assert.deepEqual([report.iron_rules.added, report.principles.added, report.experiences.added], [0, 0, 0]);
    assert.equal(report.experiences.skipped, 2);

    const noModel = await run(['--db', a, 'concresce'], env);
    assert.equal(noModel.code, 2, noModel.stderr);
    assert.match(noModel.stderr, /没有配置后台模型，这次凝结没有执行/);
    const doctor = await run(['--db', b, 'doctor'], env);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, /quick_check=ok/);
    assert.match(doctor.stdout, /检索：fts-only（不可用/);
    assert.match(doctor.stdout, /后台模型：未配置：concresce 会明确拒绝执行/);
    assert.equal(existsSync(REAL_HOME), realHomeBefore, '真实 ~/.memloom 没有被创建');
    assert.equal(existsSync(join(root, 'readable', 'personal', 'PRINCIPLES.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('人工入口：iron-rules add / list / disable；dilemmas 只在用户明确选择 + 肯定标志后执行，不跨作用域、不二次执行', async () => {
  const { root, env } = home();
  try {
    const db = join(root, 'p.db');
    assert.equal((await run(['--db', db, 'iron-rules', 'add', '太短'], env)).code, 1);
    assert.equal((await run(['--db', db, 'iron-rules', 'add', '没有明说怎么处理就不许擅自动手改用户的项目文件。'], env)).code, 0);
    assert.equal((await run(['--db', db, 'iron-rules', 'add', '周末不处理工作消息。'], env)).code, 0);
    const list = await run(['--db', db, 'iron-rules', 'list'], env);
    assert.match(list.stdout, /#1 没有明说/);
    assert.equal((await run(['--db', db, 'iron-rules', 'disable', '2'], env)).code, 0);
    assert.match((await run(['--db', db, 'iron-rules', 'list'], env)).stdout, /#2（已停用）周末不处理工作消息。/);
    assert.equal((await run(['--db', db, 'iron-rules', 'disable', '99'], env)).code, 1);

    // 用库接口摆一条分歧：原则 #1 生效，分歧 #1 关联它
    const store = openStore(db);
    store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备删除一个目录的时候', rule: '直接 rm -rf 就行', now: '2026-11-27T10:00:00.000Z' });
    store.insertDilemma({ scope: 'personal', kind: 'iron_rule_collision', summary: '新经历说可以直接删目录，但铁律要求先确认', optionA: '保留现有原则：删目录前先确认', optionB: '采用新规则：直接删', relatedPrincipleIds: [1], sourceExperienceIds: [], now: '2026-11-27T10:00:00.000Z' });
    store.insertDilemma({ scope: 'personal', kind: 'value_conflict', summary: '周末要不要处理工作消息', optionA: '周末不处理', optionB: '周末也处理', now: '2026-11-27T10:00:00.000Z' });
    store.close();
    const open = await run(['--db', db, 'dilemmas', 'list'], env);
    assert.match(open.stdout, /待拍板 2 条/);

    const noConfirm = await run(['--db', db, 'dilemmas', 'resolve', '1', '--choice', 'B', '--target', '1', '--trigger', '当你准备删除一个目录的时候', '--rule', '先 ls -la 看一眼是不是软链接，确认后再删'], env);
    assert.equal(noConfirm.code, 1);
    assert.match(noConfirm.stderr, /肯定操作标志/);
    const wrongConfirm = await run(['--db', db, 'dilemmas', 'resolve', '1', '--choice', 'B', '--confirm', '2'], env);
    assert.equal(wrongConfirm.code, 1);
    const freeText = await run(['--db', db, 'dilemmas', 'resolve', '1', '--choice', 'B', '--confirm', '1', '--target', '1', '--trigger', '随便', '--rule', '随便写一句'], env);
    assert.equal(freeText.code, 1);
    assert.match(freeText.stderr, /逐字段|长度/);
    const chooseB = await run(['--db', db, 'dilemmas', 'resolve', '1', '--choice', 'B', '--confirm', '1', '--target', '1', '--trigger', '当你准备删除一个目录的时候', '--rule', '先 ls -la 看一眼是不是软链接，确认后再删，不要带尾斜杠', '--rationale', '用户亲口纠正过'], env);
    assert.equal(chooseB.code, 0, chooseB.stderr);
    assert.match(chooseB.stdout, /新原则 #2/);
    assert.match(chooseB.stdout, /被接替的旧原则 #1/);
    const again = await run(['--db', db, 'dilemmas', 'resolve', '1', '--choice', 'A', '--confirm', '1'], env);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /不重复执行/);
    const chooseA = await run(['--db', db, 'dilemmas', 'resolve', '2', '--choice', 'A', '--confirm', '2'], env);
    assert.equal(chooseA.code, 0, chooseA.stderr);
    assert.match(chooseA.stdout, /选 A 不改原则/);
    const all = await run(['--db', db, 'dilemmas', 'list', '--all'], env);
    assert.match(all.stdout, /待拍板 0 条/);
    assert.match(all.stdout, /#1 \[resolved\]/);

    const crossScope = await run(['--db', db, 'dilemmas', 'list', '--scope', 'project:x'], env);
    assert.equal(crossScope.code, 1);
    assert.match(crossScope.stderr, /只能用 personal/);
    const badUsage = await run(['--db', db, 'daemon'], env);
    assert.equal(badUsage.code, 1);
    assert.match((await run(['--help'], env)).stdout, /import <文件\.tar\.gz>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Seen { auth: string | undefined; model: string | undefined; system: string | undefined; user: string | undefined }

function startLoopback(seen: Seen): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
      seen.auth = request.headers.authorization;
      seen.model = parsed.model;
      seen.system = parsed.messages[0]?.content;
      seen.user = parsed.messages[1]?.content;
      const content =
        parsed.model === 'good-model'
          ? '好的，这是计划：\n```json\n[{"action":"add","trigger_when":"当你准备删除一个目录的时候","rule":"先 ls -la 看一眼是不是软链接，确认后再删，不要带尾斜杠","rationale":"用户亲口纠正","is_core":false,"source_experience_ids":[1]}]\n```'
          : '我觉得不需要做什么（这不是 JSON）';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

test('后台模型走回环 OpenAI 兼容端点：中文提示词原样送达、凭据只在 Authorization 头、坏计划不落库、配置不完整直接报错', async () => {
  const { root, env } = home();
  const seen: Seen = { auth: undefined, model: undefined, system: undefined, user: undefined };
  const loop = await startLoopback(seen);
  try {
    const db = join(root, 'llm.db');
    await run(['--db', db, 'capture', '--kind', 'correction', '--summary', '删目录之前先 ls -la 看一眼是不是软链接，确认后再删。'], env);
    const partial = await run(['--db', db, 'concresce'], { ...env, MEMLOOM_LLM_MODEL: 'good-model' });
    assert.equal(partial.code, 1);
    assert.match(partial.stderr, /配置不完整/);

    const bad = await run(['--db', db, 'concresce'], { ...env, MEMLOOM_LLM_BASE_URL: `http://127.0.0.1:${loop.port}/v1/`, MEMLOOM_LLM_MODEL: 'bad-model', MEMLOOM_LLM_API_KEY: 'test-key-123456' });
    assert.equal(bad.code, 1, bad.stderr);
    assert.match(bad.stderr, /凝结没有落库/);

    const good = await run(['--db', db, 'concresce'], { ...env, MEMLOOM_LLM_BASE_URL: `http://127.0.0.1:${loop.port}/v1/`, MEMLOOM_LLM_MODEL: 'good-model', MEMLOOM_LLM_API_KEY: 'test-key-123456' });
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /凝结完成（模型 openai-compatible:127.0.0.1:\d+:good-model/);
    assert.match(good.stdout, /add → 原则 #1/);
    assert.equal(seen.auth, 'Bearer test-key-123456');
    assert.match(seen.system ?? '', /省空间靠上位抽象合并与淘汰旧项，绝不靠压缩语序/);
    const payload = JSON.parse(seen.user ?? '{}') as { 待处理经历: unknown[]; 置顶铁律: unknown[] };
    assert.equal(payload.待处理经历.length, 1);
    const recalled = await run(['--db', db, 'recall', '软链接'], env);
    assert.match(recalled.stdout, /\[P1\]/);
    const doctor = await run(['--db', db, 'doctor'], { ...env, MEMLOOM_LLM_BASE_URL: `http://127.0.0.1:${loop.port}/v1`, MEMLOOM_LLM_MODEL: 'good-model', MEMLOOM_LLM_API_KEY: 'test-key-123456' });
    assert.match(doctor.stdout, /后台模型：已配置 → 127\.0\.0\.1:\d+（模型 good-model，带凭据）/);
    assert.ok(!doctor.stdout.includes('test-key-123456'), '凭据不出现在任何输出里');
    const nothing = await run(['--db', db, 'concresce'], { ...env, MEMLOOM_LLM_BASE_URL: `http://127.0.0.1:${loop.port}/v1`, MEMLOOM_LLM_MODEL: 'good-model' });
    assert.equal(nothing.code, 0);
    assert.match(nothing.stdout, /没有待处理的经历/);
  } finally {
    loop.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon status / stop：socket 活着但不回话如实说「正在启动或正忙」且不停；真服务（离线替身）只停自己的；停完如实说没运行', async () => {
  const { root, env } = home();
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = { ...env, MEMLOOM_STATE_DIR: stateDir };
  const sockets = new Set<Socket>();
  // 一个只连不回的 socket：模拟「服务正在加载、事件循环被占住」时连得上但不回话
  const silent = createSilentSocket((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  try {
    assert.match((await run(['daemon', 'status'], state)).stdout, /没有在运行/);
    await new Promise<void>((resolve) => silent.listen(join(stateDir, 'retriever.sock'), resolve));
    const busy = await run(['daemon', 'status', '--json'], state);
    assert.equal(busy.code, 0, busy.stderr);
    assert.equal((JSON.parse(busy.stdout) as { status: { state: string } }).status.state, 'starting-or-busy');
    const refused = await run(['daemon', 'stop'], state);
    assert.equal(refused.code, 0);
    assert.match(refused.stdout, /正在启动或正忙.*不停/);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    rmSync(join(stateDir, 'retriever.sock'), { force: true });
    assert.match((await run(['daemon', 'status'], state)).stdout, /没有在运行/);

    const modelDir = join(root, 'models');
    const child = spawn(process.execPath, [STUB_DAEMON, stateDir], {
      env: { ...process.env, MEMLOOM_RETRIEVER_MODEL_DIR: modelDir, MEMLOOM_RETRIEVER_IDLE_MS: '60000' },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    let running: Running | undefined;
    for (let i = 0; i < 60 && running === undefined; i += 1) {
      const status = await run(['daemon', 'status', '--json'], state);
      const parsed = JSON.parse(status.stdout) as Running;
      if (parsed?.status.state === 'running') running = parsed;
      else await sleep(200);
    }
    assert.ok(running, '替身服务应当起来并回应 status');
    assert.equal(running.status.identity, 'memloom-retriever');
    assert.equal(typeof running.status.modelId, 'string');
    assert.match(running.status.note, /模型已就绪|正在加载模型/, '替身的「加载」要 300 毫秒，抓到哪个状态都如实');
    assert.ok(Number.isInteger(running.status.pid) && running.status.pid !== process.pid);
    const stopped = await run(['daemon', 'stop'], state);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /已经退出/);
    const after = JSON.parse((await run(['daemon', 'status', '--json'], state)).stdout) as { status: { state: string } };
    assert.equal(after.status.state, 'stopped');
    assert.match((await run(['daemon', 'stop'], state)).stdout, /没有在运行，不需要停/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('限修 B1/B2 真实进程：重复总结采集 → 导出 → 导入成功且二次零新增；半配置 API 在落库前拒绝；快照写不了时回执先说已落库', async () => {
  const { root, env } = home();
  try {
    const a = join(root, 'a.db');
    const b = join(root, 'b.db');
    assert.equal((await run(['--db', a, 'capture', '--kind', 'correction', '--summary', '删目录之前先看一眼是不是软链接。', '--evidence', '不对，先看'], env)).code, 0);
    assert.equal((await run(['--db', a, 'capture', '--kind', 'preference', '--summary', '删目录之前先看一眼是不是软链接。', '--evidence', '以后都这样'], env)).code, 0);
    const archive = join(root, 'dup.tar.gz');
    assert.equal((await run(['--db', a, 'export', '--out', archive], env)).code, 0);
    const first = await run(['--db', b, 'import', archive], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /经历：新增 2/);
    const second = await run(['--db', b, 'import', archive, '--json'], env);
    assert.equal(second.code, 0, second.stderr);
    const report = JSON.parse(second.stdout) as { committed: boolean; post_failures: number; experiences: { added: number; skipped: number }; iron_rules: { added: number } };
    assert.equal(report.committed, true);
    assert.equal(report.post_failures, 0);
    assert.deepEqual([report.experiences.added, report.experiences.skipped, report.iron_rules.added], [0, 2, 0]);

    // 只给了 API 地址、没给模型名：以前是落库后才在重建向量时出错；现在必须在落库前拒绝
    const c = join(root, 'c.db');
    const half = await run(['--db', c, 'import', archive], { ...env, MEMLOOM_API_BASE_URL: 'http://127.0.0.1:9/v1' });
    assert.equal(half.code, 1);
    assert.match(half.stderr, /导入前的配置检查没过，什么都没写/);
    assert.equal(existsSync(c), false, '库文件都没建');

    // 真实的后置失败：可读快照的位置被一个同名目录占着 → 数据库已提交，回执分开说明并给重试办法
    const home2 = temp();
    mkdirSync(join(home2, 'readable', 'personal', 'PRINCIPLES.md'), { recursive: true });
    const d = join(home2, 'd.db');
    const partial = await run(['--db', d, 'import', archive], { ...env, MEMLOOM_HOME: home2 });
    assert.equal(partial.code, 1, '部分失败用非零表示');
    assert.match(partial.stdout, /经历：新增 2/, '已提交的计数照常交付');
    assert.match(partial.stdout, /数据库已提交.*不是回滚.*有 1 处后置步骤没完成/);
    assert.match(partial.stdout, /可读快照没刷新：.*重试：/);
    assert.doesNotMatch(partial.stdout, /可读快照已刷新/);
    const recalled = await run(['--db', d, 'recall', '软链接'], { ...env, MEMLOOM_HOME: home2 });
    assert.match(recalled.stdout, /\[E1\]/, '记忆确实已经落库');
    rmSync(home2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
