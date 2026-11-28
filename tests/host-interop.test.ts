import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/core/index.js';
import { CRAFT_END, CRAFT_START, CRAFT_HARD_LIMIT, countCraft, HostCore, MemorySessionStore, projectCraft, refreshBrief, resolveHostConfig, trustedCrewCli } from '../src/host/index.js';
import { DetachedJobRunner, jobEnv, jobSpec } from '../src/host/background.js';
import type { JobConfig } from '../src/host/types.js';
import type { CondenseModel, ExtractionModel } from '../src/core/types.js';

/**
 * 和 agent-crew 的真实联动（只用临时项目 + 临时 home；agent-crew 仓只读调用，不改它、不装它）：
 * 建队 → 项目 / 角色会话记忆 → CRAFT 单向投影（保留手写）→ brief 刷新保留人工区 → check 通过 → 打包不带 .mind.db → 个人库隔离；
 * 另有通用子进程入口（--event / --job）的真实进程用例，后台模型走回环替身。
 */

// 真实 agent-crew 的 CLI：先看 MEMLOOM_TEST_CREW_CLI；没给就按本文件的编译产物位置找同级克隆（<父目录>/agent-crew/scripts/crew.mjs）。
// 都没有就跳过那条用例。不猜 cwd，不写任何本机路径。
const CREW_SIBLING = [
  fileURLToPath(new URL('../../../agent-crew/scripts/crew.mjs', import.meta.url)), // 从 dist/tests/ 往上三层：memloom 的同级目录
  fileURLToPath(new URL('../../agent-crew/scripts/crew.mjs', import.meta.url)), // 直接从源码 tests/ 跑的时候
].find((candidate) => existsSync(candidate));
const CREW = process.env.MEMLOOM_TEST_CREW_CLI ?? CREW_SIBLING ?? '';
const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const HOOK = fileURLToPath(new URL('../src/host/hook-cli.js', import.meta.url));
const BACKGROUND = fileURLToPath(new URL('../src/host/background.js', import.meta.url));
const hasCrew = existsSync(CREW);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'memloom-host-interop-'));
}

function runNode(args: string[], env: Record<string, string>, cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8', cwd }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

function crew(args: string[]): Promise<Run> {
  return runNode([CREW, ...args], {});
}

function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  // 只给 memloom 自己的变量：不带真实环境里的后台模型 / 检索配置，也不带凭据
  return { MEMLOOM_HOME: home, ...extra };
}

const FTS = { modelId: 'fts-only', dimensions: 0, embed: async () => { throw new Error('fts'); }, rerank: async () => { throw new Error('fts'); }, health: async () => ({ ok: false, mode: 'fts-only' as const }) };

const CONDENSE_ADD: CondenseModel = {
  id: 'condense-stub',
  plan: (ctx) =>
    Promise.resolve([
      {
        action: 'add',
        trigger_when: '当你想改动用户项目里的文件的时候',
        rule: '没有明说怎么处理就不许擅自动手，先问清楚再改',
        rationale: null,
        is_core: false,
        source_experience_ids: [ctx.experiences[0]?.id as number],
      },
    ]),
};

const NEVER_EXTRACT: ExtractionModel = { id: 'never', extract: async () => [] };

function makeTeamProject(root: string): string {
  const project = join(root, 'proj');
  mkdirSync(project, { recursive: true });
  return project;
}

function fakeTeam(project: string, roles: string[] = []): void {
  mkdirSync(join(project, '.team', 'roles'), { recursive: true });
  writeFileSync(join(project, '.team', 'manifest.json'), `${JSON.stringify({ schema_version: 1, project_id: 'fake-proj-1', project_name: '假项目', domain: 'custom', created_at: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`);
  for (const role of roles) {
    mkdirSync(join(project, '.team', 'roles', role), { recursive: true });
    writeFileSync(join(project, '.team', 'roles', role, 'ROLE.md'), `# ${role}\n`);
  }
}

test('作用域只认显式项目与现有角色；个人库不往 Markdown 投影；可信 CLI 路径门槛', async () => {
  const root = temp();
  try {
    const project = makeTeamProject(root);
    fakeTeam(project, ['reviewer']);
    const home = join(root, 'home');
    const projectConfig = resolveHostConfig({ project }, cleanEnv(home));
    assert.equal(projectConfig.scope, 'project:fake-proj-1');
    assert.ok(projectConfig.dbPath.endsWith(join('.team', '.mind.db')));
    const roleConfig = resolveHostConfig({ project, role: 'reviewer' }, cleanEnv(home));
    assert.equal(roleConfig.scope, 'role:reviewer');
    assert.throws(() => resolveHostConfig({ project, role: 'ghost' }, cleanEnv(home)), /没有角色「ghost」/);
    rmSync(join(project, '.team', 'roles', 'reviewer', 'ROLE.md'));
    assert.throws(() => resolveHostConfig({ project, role: 'reviewer' }, cleanEnv(home)), /ROLE.md/);
    assert.throws(() => resolveHostConfig({ project: join(root, 'nope') }, cleanEnv(home)), /项目目录不存在|不是启用了 .team/);

    const personal = resolveHostConfig({}, cleanEnv(home));
    assert.equal(personal.scope, 'personal');
    assert.ok(personal.dbPath.startsWith(home));
    assert.equal(personal.crewCliPath, null);
    assert.equal(personal.warmupOnStart, true);
    assert.equal(resolveHostConfig({}, cleanEnv(home, { MEMLOOM_WARMUP: '0', MEMLOOM_HINT_BUDGET_MS: '250', MEMLOOM_HINT_THRESHOLD: '0.9' })).hint?.budgetMs, 250);
    assert.equal(resolveHostConfig({}, cleanEnv(home, { MEMLOOM_HINT_THRESHOLD: '0.9' })).hint?.threshold, 0.9);

    // 个人作用域没有 CRAFT 投影
    const store = openStore(join(root, 'p.db'));
    assert.throws(() => projectCraft({ projectDir: project, store, scope: 'personal' }), /只有项目 \/ 角色作用域/);
    store.close();
    const cli = await runNode([CLI, '--home', home, '--db', join(root, 'p2.db'), 'craft', 'sync'], cleanEnv(home));
    assert.equal(cli.code, 1);
    assert.match(cli.stderr, /craft sync 只对项目 \/ 角色作用域有意义/);

    // 可信 CLI 路径：相对路径、不存在、链接、非脚本都当没配置
    assert.equal('path' in trustedCrewCli('scripts/crew.mjs') && 'path' in trustedCrewCli('scripts/crew.mjs') ? trustedCrewCli('scripts/crew.mjs').path : null, null);
    assert.equal(trustedCrewCli('/nonexistent/crew.mjs').path, null);
    assert.equal(trustedCrewCli('/tmp').path, null);
    const real = join(root, 'crew.mjs');
    writeFileSync(real, '// stub\n');
    symlinkSync(real, join(root, 'crew-link.mjs'));
    assert.equal(trustedCrewCli(join(root, 'crew-link.mjs')).path, null);
    assert.equal(trustedCrewCli(real).path, real);
    const manual = await refreshBrief({ crewCliPath: null, projectDir: project });
    assert.equal(manual.status, 'manual');
    assert.match(manual.note, /没有配置可信的 agent-crew CLI/);
    assert.match(manual.manual, /crew\.mjs brief --project .* --write/);
    assert.equal(existsSync(join(home, 'personal.db')), false, '只读配置不开个人库');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CRAFT 单向投影：区外字节原样（含行尾）、手写保留、40 条上限少写不截句、链接与不成对标记拒绝', () => {
  const root = temp();
  try {
    const project = makeTeamProject(root);
    fakeTeam(project, ['reviewer']);
    const dbPath = join(root, 'mind.db');
    const store = openStore(dbPath);
    for (let i = 0; i < 5; i += 1) {
      store.insertPrinciple({ scope: 'project:fake-proj-1', triggerWhen: `当你要做第 ${i + 1} 件事的时候`, rule: `先确认第 ${i + 1} 件事的前提再动手，不要跳过检查`, isCore: i === 0, now: '2026-01-01T00:00:00.000Z' });
    }
    // 手写 38 条（CRLF 行尾）→ 只能再写 2 条，少写 3 条并在回执里说明
    const handwritten = Array.from({ length: 38 }, (_, i) => `- 手写第 ${i + 1} 条：保持原样\r\n`).join('');
    const craftPath = join(project, '.team', 'CRAFT.md');
    writeFileSync(craftPath, `# 项目手艺\r\n\r\n${handwritten}`);
    const before = readFileSync(craftPath, 'utf8');
    const report = projectCraft({ projectDir: project, store, scope: 'project:fake-proj-1' });
    assert.equal(report.status, 'ok');
    assert.equal(report.written, 2);
    assert.equal(report.omitted, 3);
    assert.equal(report.handwritten, 38);
    assert.match(report.note ?? '', /少写了 3 条/);
    const after = readFileSync(craftPath, 'utf8');
    assert.ok(after.startsWith(before), '原有字节原样在前');
    assert.equal(countCraft(after), CRAFT_HARD_LIMIT);
    assert.match(after, /- ★ 当你要做第 1 件事的时候：先确认第 1 件事的前提再动手，不要跳过检查\r\n/, '常驻核心排最前');
    assert.ok(after.includes('\r\n') && !after.replace(/\r\n/g, '').includes('\n'), '沿用 CRLF');
    const again = projectCraft({ projectDir: project, store, scope: 'project:fake-proj-1' });
    assert.equal(again.status, 'unchanged', '内容和数据库一致时不改文件');
    // 原则变了只换管理区，区外不动
    store.insertPrinciple({ scope: 'project:fake-proj-1', triggerWhen: '当你要发版的时候', rule: '先跑一遍完整门禁再打标签', isCore: true, now: '2026-02-01T00:00:00.000Z' });
    const changed = projectCraft({ projectDir: project, store, scope: 'project:fake-proj-1' });
    assert.equal(changed.status, 'ok');
    assert.ok(readFileSync(craftPath, 'utf8').startsWith(before));

    // 角色作用域写到 roles/<slug>/CRAFT.md；没有生效原则且文件不存在时不建文件
    assert.equal(projectCraft({ projectDir: project, store, scope: 'role:reviewer' }).status, 'skipped');
    assert.equal(existsSync(join(project, '.team', 'roles', 'reviewer', 'CRAFT.md')), false);
    store.insertPrinciple({ scope: 'role:reviewer', triggerWhen: '当你审查别人的代码的时候', rule: '先看测试再看实现', isCore: false, now: '2026-01-01T00:00:00.000Z' });
    const role = projectCraft({ projectDir: project, store, scope: 'role:reviewer' });
    assert.equal(role.status, 'ok');
    const roleText = readFileSync(join(project, '.team', 'roles', 'reviewer', 'CRAFT.md'), 'utf8');
    assert.match(roleText, /- ★ 当你审查别人的代码的时候：先看测试再看实现/);

    // 标记不成对 → 拒绝，一个字节不写
    writeFileSync(craftPath, `${before}${CRAFT_START}\n- ★ 孤儿\n`);
    const broken = readFileSync(craftPath, 'utf8');
    assert.throws(() => projectCraft({ projectDir: project, store, scope: 'project:fake-proj-1' }), /不成对/);
    assert.equal(readFileSync(craftPath, 'utf8'), broken);
    writeFileSync(craftPath, before);

    // 目标文件是链接 → 拒绝，链接目标不被改
    const outside = join(root, 'outside.md');
    writeFileSync(outside, '别动我\n');
    rmSync(craftPath);
    symlinkSync(outside, craftPath);
    assert.throws(() => projectCraft({ projectDir: project, store, scope: 'project:fake-proj-1' }), /符号链接/);
    assert.equal(readFileSync(outside, 'utf8'), '别动我\n');
    rmSync(craftPath);
    writeFileSync(craftPath, before);

    // 父级 roles 是链接 → 角色投影拒绝
    rmSync(join(project, '.team', 'roles'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(project, '.team', 'roles'));
    mkdirSync(join(root, 'elsewhere', 'reviewer'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'reviewer', 'ROLE.md'), '# x\n');
    assert.throws(() => projectCraft({ projectDir: project, store, scope: 'role:reviewer' }), /符号链接/);
    assert.equal(existsSync(join(root, 'elsewhere', 'reviewer', 'CRAFT.md')), false);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('项目 / 角色会话：纠错进 .team/.mind.db 并凝结后投影 CRAFT；个人库不被建出来', async () => {
  const root = temp();
  const project = makeTeamProject(root);
  fakeTeam(project, ['reviewer']);
  const home = join(root, 'home');
  let cores: HostCore[] = [];
  try {
    const projectConfig = resolveHostConfig({ project }, cleanEnv(home));
    const core = new HostCore({ ...projectConfig, llm: null, warmupOnStart: false, sessionStore: new MemorySessionStore(), extractionModel: NEVER_EXTRACT, condenseModel: CONDENSE_ADD }, { retriever: FTS, jobMode: 'inline' });
    cores.push(core);
    const r = await core.handle({ type: 'user_message', sessionId: 'p1', text: '不对，不要自作主张改我的项目文件。' });
    assert.equal(r.correction.captured, true);
    await core.settle();
    const db = openStore(projectConfig.dbPath);
    assert.equal(db.listExperiences('project:fake-proj-1').length, 1);
    assert.equal(db.listExperiences('personal').length, 0, '项目会话不写 personal');
    assert.equal(db.listPrinciples('project:fake-proj-1').length, 1);
    db.close();
    const craft = readFileSync(join(project, '.team', 'CRAFT.md'), 'utf8');
    assert.ok(craft.includes(CRAFT_START) && craft.includes(CRAFT_END));
    assert.match(craft, /- ★ 当你想改动用户项目里的文件的时候：没有明说怎么处理就不许擅自动手，先问清楚再改/);
    assert.equal(existsSync(join(home, 'personal.db')), false, '个人库独立，项目会话不碰它');

    const roleConfig = resolveHostConfig({ project, role: 'reviewer' }, cleanEnv(home));
    const roleCore = new HostCore({ ...roleConfig, llm: null, warmupOnStart: false, sessionStore: new MemorySessionStore(), extractionModel: NEVER_EXTRACT, condenseModel: CONDENSE_ADD }, { retriever: FTS, jobMode: 'inline' });
    cores.push(roleCore);
    const rr = await roleCore.handle({ type: 'user_message', sessionId: 'r1', text: '不对，不要自作主张改我的项目文件。' });
    assert.equal(rr.scope, 'role:reviewer');
    await roleCore.settle();
    assert.match(readFileSync(join(project, '.team', 'roles', 'reviewer', 'CRAFT.md'), 'utf8'), /- ★ 当你想改动用户项目里的文件的时候/);
    assert.equal(existsSync(join(home, 'personal.db')), false);
  } finally {
    for (const core of cores) core.close();
    cores = [];
    rmSync(root, { recursive: true, force: true });
  }
});

test('通用子进程入口：--event 回一条 HostResponse（永远退出 0）；--job 真实子进程用回环后台端点做抢救抽取；核心默认的脱离任务也落库', async () => {
  const root = temp();
  const home = join(root, 'home');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      requests.push(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify([{ kind: 'pitfall', summary: '用户删除目录前会先确认它是不是软链接，避免顺着链接误删目标。', evidence: '软链接' }]) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    // --event：session_start
    const event = await new Promise<Run>((resolve) => {
      const child = spawn(process.execPath, [HOOK, '--event'], { env: { ...process.env, ...cleanEnv(home) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(JSON.stringify({ type: 'session_start', sessionId: 'cli-s' }));
    });
    assert.equal(event.code, 0);
    const parsed = JSON.parse(event.stdout) as { event: string; scope: string; staticBlock: string; hint: string; hintState: string };
    assert.equal(parsed.event, 'session_start');
    assert.equal(parsed.scope, 'personal');
    assert.equal(parsed.staticBlock, '', '空库：静态区是空串');
    assert.equal(parsed.hint, '');
    const garbage = await new Promise<Run>((resolve) => {
      const child = spawn(process.execPath, [HOOK, '--event'], { env: { ...process.env, ...cleanEnv(home) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr: '' }));
      child.stdin.end('not json');
    });
    assert.equal(garbage.code, 0);
    assert.equal(garbage.stdout, '');
    const usage = await runNode([HOOK], cleanEnv(home));
    assert.equal(usage.code, 0);
    assert.match(usage.stderr, /用法/);

    // --job：抢救抽取走回环端点
    const dbPath = join(root, 'job.db');
    const specPath = join(root, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ job: { kind: 'flush', sessionId: 'job-s', messages: [{ id: 'job-s:1', role: 'user', text: '删目录之前要先看是不是软链接' }] }, config: { home, dbPath, scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir: home, llm: { baseUrl, model: 'mock-m' }, crewCliPath: null } }));
    // 外层环境里即使有别的 MEMLOOM_LLM_API_KEY，--job 也只认子进程专用的 MEMLOOM_JOB_LLM_API_KEY：没有就是没有
    const job = await runNode([HOOK, '--job', specPath], cleanEnv(home, { MEMLOOM_LLM_API_KEY: 'outer-not-used' }));
    assert.equal(job.code, 0);
    assert.match(job.stderr, /memloom job：flush 完成；新增经历 1/);
    assert.equal(existsSync(specPath), false, '任务说明跑完即删');
    const db = openStore(dbPath);
    assert.equal(db.listExperiences('personal')[0]?.source, 'flush');
    db.close();
    assert.equal(requests.length, 1);
    assert.match(requests[0] ?? '', /软链接/, '只把这段对话发给端点');
    assert.doesNotMatch(requests[0] ?? '', /authorization/i, '没有凭据就不带 Authorization');

    // 核心默认（mixed）：关会话的抢救由脱离的短命子进程做，本进程不等
    const coreDb = join(root, 'core.db');
    const core = new HostCore({ home, dbPath: coreDb, scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir: home, llm: { baseUrl, model: 'mock-m' }, warmupOnStart: false, sessionStore: new MemorySessionStore() }, { retriever: FTS });
    await core.handle({ type: 'session_start', sessionId: 'detached-s' });
    await core.handle({ type: 'user_message', sessionId: 'detached-s', text: '第十一轮：删目录之前要先看是不是软链接' });
    const end = await core.handle({ type: 'session_end', sessionId: 'detached-s' });
    core.close();
    assert.deepEqual(end.background.map((b) => [b.kind, b.state]), [['flush', 'spawned']]);
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const probe = openStore(coreDb);
      found = probe.listExperiences('personal').some((e) => e.source === 'flush');
      probe.close();
    }
    assert.equal(found, true, '脱离的子进程把抢救抽取落库了');
    assert.equal(readdirSync(join(home, 'jobs')).length, 0, '任务说明跑完即删');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实 agent-crew：建队 → 项目 / 角色记忆 → CRAFT → brief 保留人工区 → check 通过 → 打包不带 .mind.db', { skip: !hasCrew && `没找到 agent-crew CLI（${CREW || '没给 MEMLOOM_TEST_CREW_CLI，同级目录下也没有 ../agent-crew/scripts/crew.mjs'}）：设 MEMLOOM_TEST_CREW_CLI=<crew.mjs 的绝对路径>，或把 agent-crew 克隆到和 memloom 同级的目录` }, async () => {
  const root = temp();
  try {
    const project = makeTeamProject(root);
    const home = join(root, 'home');
    const init = await crew(['init', '--project', project, '--name', '试用项目', '--with-memloom']);
    assert.equal(init.code, 0, init.stderr);
    assert.match(readFileSync(join(project, '.team', '.gitignore'), 'utf8'), /^\/\.mind\.db\*$/m);
    const role = await crew(['role', 'add', '--project', project, 'reviewer', '--title', '审查员', '--scope', '审查代码']);
    assert.equal(role.code, 0, role.stderr);
    const manifest = JSON.parse(readFileSync(join(project, '.team', 'manifest.json'), 'utf8')) as { project_id: string };
    // 手写项目手艺 + BRIEF 人工区
    writeFileSync(join(project, '.team', 'CRAFT.md'), '# 项目手艺\n\n- 手写：先读需求再读代码\n');
    const briefPath = join(project, '.team', 'BRIEF.md');
    const brief = readFileSync(briefPath, 'utf8');
    assert.match(brief, /<!-- crew:manual:start -->/);
    writeFileSync(briefPath, brief.replace(/(<!-- crew:manual:start -->)[\s\S]*?(<!-- crew:manual:end -->)/, '$1\n\n人工红线：不许动数据库迁移。\n\n$2'));

    const projectConfig = resolveHostConfig({ project }, cleanEnv(home));
    assert.equal(projectConfig.scope, `project:${manifest.project_id}`);
    const core = new HostCore({ ...projectConfig, llm: null, warmupOnStart: false, sessionStore: new MemorySessionStore(), extractionModel: NEVER_EXTRACT, condenseModel: CONDENSE_ADD }, { retriever: FTS, jobMode: 'inline' });
    const db = openStore(projectConfig.dbPath);
    db.insertPrinciple({ scope: projectConfig.scope, triggerWhen: '当你准备跑数据库迁移的时候', rule: '先在临时库上跑一遍，确认可回滚再动正式库', isCore: true, now: '2026-01-01T00:00:00.000Z' });
    db.close();
    try {
      const r = await core.handle({ type: 'user_message', sessionId: 'crew-p', text: '不对，不要自作主张改我的项目文件。' });
      assert.equal(r.correction.captured, true);
      await core.settle();
    } finally {
      core.close();
    }
    const roleConfig = resolveHostConfig({ project, role: 'reviewer' }, cleanEnv(home));
    const roleCore = new HostCore({ ...roleConfig, llm: null, warmupOnStart: false, sessionStore: new MemorySessionStore(), extractionModel: NEVER_EXTRACT, condenseModel: CONDENSE_ADD }, { retriever: FTS, jobMode: 'inline' });
    try {
      await roleCore.handle({ type: 'user_message', sessionId: 'crew-r', text: '不对，不要自作主张改我的项目文件。' });
      await roleCore.settle();
    } finally {
      roleCore.close();
    }
    const craft = readFileSync(join(project, '.team', 'CRAFT.md'), 'utf8');
    assert.match(craft, /- 手写：先读需求再读代码\n/, '手写条目原样保留');
    assert.equal(craft.indexOf('- 手写：先读需求再读代码'), 0 + '# 项目手艺\n\n'.length);
    assert.match(craft, /- ★ 当你准备跑数据库迁移的时候：先在临时库上跑一遍/);
    assert.match(craft, /- ★ 当你想改动用户项目里的文件的时候/);
    assert.match(readFileSync(join(project, '.team', 'roles', 'reviewer', 'CRAFT.md'), 'utf8'), /- ★ 当你想改动用户项目里的文件的时候/);
    assert.equal(existsSync(join(home, 'personal.db')), false, '个人库独立：项目 / 角色会话没有建它');

    // 命令行 craft sync：没配 --brief 不动 BRIEF；配了没有可信路径就提示手动；有可信路径才真的刷新
    const noBrief = await runNode([CLI, '--project', project, 'craft', 'sync'], cleanEnv(home));
    assert.equal(noBrief.code, 0, noBrief.stderr);
    assert.match(noBrief.stdout, /CRAFT（project:/);
    assert.match(noBrief.stdout, /速览：没有加 --brief/);
    const manual = await runNode([CLI, '--project', project, 'craft', 'sync', '--brief'], cleanEnv(home));
    assert.equal(manual.code, 0, manual.stderr);
    assert.match(manual.stdout, /没有配置可信的 agent-crew CLI/);
    const refreshed = await runNode([CLI, '--project', project, 'craft', 'sync', '--brief', '--json'], cleanEnv(home, { MEMLOOM_CREW_CLI: CREW }));
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const report = JSON.parse(refreshed.stdout) as { craft: { status: string; written: number }; brief: { status: string; note: string } };
    assert.equal(report.craft.status, 'unchanged');
    assert.equal(report.brief.status, 'ok', report.brief.note);
    const briefAfter = readFileSync(briefPath, 'utf8');
    assert.match(briefAfter, /人工红线：不许动数据库迁移。/, 'brief --write 保留人工核心区');
    assert.match(briefAfter, /【项目手艺】当你准备跑数据库迁移的时候：先在临时库上跑一遍/);
    assert.match(briefAfter, /【审查员的手艺】当你想改动用户项目里的文件的时候/);

    const check = await crew(['check', '--project', project]);
    assert.equal(check.code, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /CRAFT\.md（项目级）：3 条手艺/    );
    const pkg = join(root, 'pkg.tar.gz');
    const exported = await crew(['export', '--project', project, '--out', pkg]);
    assert.equal(exported.code, 0, exported.stderr);
    const listed = await new Promise<Run>((resolve) => execFile('tar', ['-tzf', pkg], { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr })));
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /\.mind\.db/, '项目包不带 SQLite');
    assert.match(listed.stdout, /CRAFT\.md/);
    assert.match(listed.stdout, /\.gitignore/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('脱离任务的密钥边界：说明文件永远没有凭据、凭据只走子进程环境；真实 detached 正路带 Bearer；入口缺失 / 子进程即退都不残留说明', async () => {
  const root = temp();
  const home = join(root, 'home');
  const FAKE = `fake-key-${randomBytes(8).toString('hex')}`; // 唯一允许出现在输出里的「密钥」就是这个假的
  const auth: string[] = [];
  const bodies: string[] = [];
  const specsAtRequest: number[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      auth.push(String(request.headers.authorization ?? ''));
      specsAtRequest.push(existsSync(join(home, 'jobs')) ? readdirSync(join(home, 'jobs')).length : 0);
      bodies.push(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify([{ kind: 'pitfall', summary: '用户删除目录前会先确认它是不是软链接，避免顺着链接误删目标。', evidence: '软链接' }]) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const jobsDir = join(home, 'jobs');
  const jobFiles = (): string[] => (existsSync(jobsDir) ? readdirSync(jobsDir) : []);
  const config: JobConfig = { home, dbPath: join(root, 'a.db'), scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir: home, llm: { baseUrl, model: 'mock-m' }, crewCliPath: null };
  try {
    // 1) 序列化逐字段挑选 + 子进程环境只带当前配置这一份凭据
    // 类型上没有 apiKey，运行时照样塞进去（宽对象）：证明是逐字段过滤，不是靠类型声明
    const wide = { ...config, llm: { baseUrl, model: 'mock-m', timeoutMs: 5_000, apiKey: FAKE, authorization: `Bearer ${FAKE}` }, extra: FAKE } as JobConfig;
    const spec = JSON.stringify(jobSpec({ kind: 'flush', sessionId: 's', messages: [{ id: 's:1', role: 'user', text: '删目录之前要先看是不是软链接' }] }, wide));
    assert.ok(!spec.includes('apiKey') && !spec.includes(FAKE) && !spec.includes('authorization') && !spec.includes('extra'), '说明里只有端点、模型名、超时和路径');
    assert.deepEqual(Object.keys((JSON.parse(spec) as { config: { llm: Record<string, unknown> } }).config.llm).sort(), ['baseUrl', 'model', 'timeoutMs'], 'llm 只剩端点、模型名、超时');
    const envNone = jobEnv(undefined, { PATH: '/bin', MEMLOOM_LLM_API_KEY: 'outer-secret' });
    assert.equal(envNone.MEMLOOM_LLM_API_KEY, undefined, '外层后台模型的凭据不传给子进程');
    assert.equal(envNone.MEMLOOM_JOB_LLM_API_KEY, '', '明确无凭据');
    assert.equal(envNone.PATH, '/bin');
    assert.equal(jobEnv(FAKE, { PATH: '/bin' }).MEMLOOM_JOB_LLM_API_KEY, FAKE);

    // 2) 真实 detached 正路：回环端点收到 Bearer 假密钥、完成落库；说明执行期间不可见（读完即删），更没有密钥
    const coreDb = join(root, 'core.db');
    const core = new HostCore({ home, dbPath: coreDb, scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir: home, llm: { baseUrl, model: 'mock-m', apiKey: FAKE }, warmupOnStart: false, sessionStore: new MemorySessionStore() }, { retriever: FTS });
    await core.handle({ type: 'session_start', sessionId: 'k1' });
    await core.handle({ type: 'user_message', sessionId: 'k1', text: '删目录之前要先看是不是软链接' });
    const end = await core.handle({ type: 'session_end', sessionId: 'k1' });
    core.close();
    assert.deepEqual(end.background.map((b) => [b.kind, b.state]), [['flush', 'spawned']]);
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const probe = openStore(coreDb);
      found = probe.listExperiences('personal').some((e) => e.source === 'flush');
      probe.close();
    }
    assert.equal(found, true, '脱离子进程完成抢救抽取并落库');
    assert.deepEqual(specsAtRequest, [0], '回环请求到达时任务说明已经删除（子进程读完即删）');
    assert.equal(auth.length, 1, '端点只收到一次请求');
    assert.equal(auth.filter((h) => h === `Bearer ${FAKE}`).length, 1, '有且仅一次带 Bearer 假密钥');
    assert.equal(bodies.length, 1);
    assert.deepEqual(jobFiles(), [], '落库后目录为空');

    // 3) 入口缺失：先判，不写说明
    const missing = new DetachedJobRunner({ ...config, llm: null }, join(root, 'nope', 'hook-cli.js'));
    assert.equal(await missing.submit({ kind: 'flush', sessionId: 's2', messages: [{ id: 's2:1', role: 'user', text: 'x' }] }), 'skipped');
    assert.deepEqual(jobFiles(), []);

    // 4) 入口存在但子进程立刻退出、从不读说明：父进程兜底删掉，不残留
    const bad = join(root, 'exit3.mjs');
    writeFileSync(bad, 'process.exit(3);\n');
    const runner = new DetachedJobRunner({ ...config, llm: null }, bad);
    assert.equal(await runner.submit({ kind: 'flush', sessionId: 's3', messages: [{ id: 's3:1', role: 'user', text: 'x' }] }), 'spawned');
    const until = Date.now() + 8_000;
    while (Date.now() < until && jobFiles().length > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(jobFiles(), [], '子进程没走到读说明就退出，父进程也会清掉它');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('process.execPath 绝不存在：submit 回 skipped、说明清空、宿主进程不受未处理 error 影响（隔离 Node 子进程复现）', async () => {
  const root = temp();
  const repro = join(root, 'repro.mjs');
  // 在一个临时 Node 进程里复现：把它的 process.execPath 指到绝不存在的地方，再提交脱离任务；修不好它会以未处理的 'error' 事件退出
  writeFileSync(
    repro,
    [
      "import { mkdtempSync, readdirSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const { DetachedJobRunner } = await import(pathToFileURL(process.argv[2]).href);",
      "const home = mkdtempSync(join(tmpdir(), 'memloom-host-repro-'));",
      "process.execPath = join(home, 'definitely-missing', 'node');",
      "const logs = [];",
      "const runner = new DetachedJobRunner({ home, dbPath: join(home, 'x.db'), scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir: home, llm: null }, process.argv[3], undefined, process.env, (line) => logs.push(line));",
      "const state = await runner.submit({ kind: 'flush', sessionId: 'b', messages: [{ id: 'b:1', role: 'user', text: '合成话：删目录之前要先看是不是软链接' }] });",
      "await new Promise((resolve) => setTimeout(resolve, 400));",
      "console.log(JSON.stringify({ state, jobs: readdirSync(join(home, 'jobs')), logs }));",
    ].join('\n'),
  );
  try {
    // 入口给一个真实存在、但走不到的文件（execPath 不存在，根本起不了进程）
    const run = await runNode([repro, BACKGROUND, repro], {});
    assert.equal(run.code, 0, `宿主进程应正常退出 0；stderr：${run.stderr}`);
    assert.doesNotMatch(run.stderr, /Unhandled|ENOENT/);
    const report = JSON.parse(run.stdout) as { state: string; jobs: string[]; logs: string[] };
    assert.equal(report.state, 'skipped', '没有真进程就不报 spawned');
    assert.deepEqual(report.jobs, [], '说明已清理');
    assert.equal(report.logs.length, 1, '兜底清理只记一次（同步清理和之后的 error 事件幂等）');
    assert.match(report.logs[0] ?? '', /没有拿到子进程号|子进程出错/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
