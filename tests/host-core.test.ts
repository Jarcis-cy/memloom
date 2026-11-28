import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/core/index.js';
import { FtsOnlyRetriever } from '../src/retriever/index.js';
import type { Retriever, RerankHit } from '../src/retriever/types.js';
import { HostCore, MemorySessionStore, stripInjections, shouldHint, toolFailed } from '../src/host/index.js';
import type { ConversationMessage, CondenseModel, ExtractionModel } from '../src/core/types.js';
import type { BackgroundEntry, HostConfig, HostEvent, HostResponse, SessionStore } from '../src/host/types.js';

/**
 * 宿主无关核心的多轮事件（临时 SQLite + 临时 home + 注入的离线模型与假检索器；不联网、不碰真实 ~/.memloom、不加载模型）：
 * 静态两轮一致 → 中文提醒一条 / 一条空 → 工具错 → 即时中文纠错 → 后台复盘 / 抢救；再加预算超时、无模型、分歧通知。
 */

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'memloom-host-core-'));
}

/** 假检索器：向量全 0（不产生向量候选），精排分由调用方按「查询 × 文档」给；可以人为拖慢。 */
function fakeRetriever(score: (query: string, doc: string) => number, delayMs = 0): Retriever {
  return {
    modelId: 'fake-embed:512',
    dimensions: 512,
    embed: async (texts) => texts.map(() => new Float32Array(512)),
    rerank: async (query, documents) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const hits: RerankHit[] = documents
        .map((text, index) => ({ index, score: score(query, text) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score);
      return hits;
    },
    health: async () => ({ ok: true, mode: 'local-onnx', detail: '测试替身' }),
  };
}

/** 中文改述 → 高分的离线语义替身：查询讲「快捷方式 / 删目录」而文档讲「软链接」才算相关；报错码靠字面补位找回。 */
function semanticScore(query: string, doc: string): number {
  const q = query.toLowerCase();
  const d = doc.toLowerCase();
  const aboutDelete = /删/.test(q) && /目录|文件夹|folder/.test(q);
  if (aboutDelete && /软链接|symlink/.test(d)) return 0.93;
  if (/enoent/.test(q) && /enoent/.test(d)) return 0.97;
  return 0.02;
}

const CONDENSE_ADD: CondenseModel = {
  id: 'condense-stub',
  plan: (ctx) =>
    Promise.resolve([
      {
        action: 'add',
        trigger_when: '当你想改动用户项目里的文件的时候',
        rule: '没有明说怎么处理就不许擅自动手，先问清楚',
        rationale: '用户刚刚纠正了自作主张的做法',
        is_core: false,
        source_experience_ids: [ctx.experiences[0]?.id as number],
      },
    ]),
};

function extractionStub(seen: ConversationMessage[][], calls: { count: number }): ExtractionModel {
  return {
    id: 'extract-stub',
    extract: async (input) => {
      calls.count += 1;
      seen.push([...input.messages]);
      const joined = input.messages.map((m) => m.text).join('\n');
      if (!joined.includes('软链接')) return [];
      return [{ kind: 'pitfall', summary: '用户删除目录前会先确认它是不是软链接，避免顺着链接误删目标。', evidence: '软链接' }];
    },
  };
}

function seed(dbPath: string): void {
  const store = openStore(dbPath);
  store.addIronRule({ scope: 'personal', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: '2026-01-01T00:00:00.000Z' });
  store.insertPrinciple({ scope: 'personal', triggerWhen: '当你向用户汇报进展的时候', rule: '先说结论，再用大白话展开，不要先铺背景。', isCore: true, now: '2026-01-01T00:00:00.000Z' });
  store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf，防止顺着链接误删目标目录', isCore: false, now: '2026-01-01T00:00:00.000Z' });
  store.addExperience({ scope: 'personal', kind: 'pitfall', summary: '构建报 ENOENT 时先看路径里的目录是不是被软链到别处，再检查权限。', evidence: 'ENOENT: no such file or directory', source: 'manual', createdAt: '2026-01-02T00:00:00.000Z' });
  store.close();
}

function config(home: string, extra: Partial<HostConfig> = {}): HostConfig {
  return {
    home,
    dbPath: join(home, 'personal.db'),
    scope: 'personal',
    projectDir: null,
    projectId: null,
    roleName: null,
    stateDir: home,
    llm: null,
    warmupOnStart: false,
    sessionStore: new MemorySessionStore(),
    ...extra,
  };
}

async function cleanup(root: string, ...cores: Array<HostCore | null>) {
  for (const core of cores) {
    if (!core) continue;
    await core.settle();
    core.close();
  }
  rmSync(root, { recursive: true, force: true });
}

const DELETE_QUERY = '递归删文件夹的时候把快捷方式指到的那份也删了，怎么办';

test('静态区两轮逐字节一致、只含铁律 + 核心 + 工具说明且 ≤ 3000；新会话才重算；无关消息静默', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const core = new HostCore(config(root), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    const start = await core.handle({ type: 'session_start', sessionId: 's1' });
    const block = start.staticBlock ?? '';
    assert.ok(block.length > 0 && block.length <= 3000, `静态区 ${block.length} 字`);
    assert.match(block, /^<memloom-standing>\n<iron-rules>/);
    assert.match(block, /没有明说怎么处理就不许擅自动手/);
    assert.match(block, /先说结论/);
    assert.match(block, /memloom recall/);
    assert.doesNotMatch(block, /软链接/, '非常驻核心原则不进静态区');
    assert.equal(start.dilemmaNotice, '');
    assert.deepEqual(start.background, []);

    // 库里又加了一条铁律，同一会话仍原字节；新会话才重算
    const other = openStore(join(root, 'personal.db'));
    other.addIronRule({ scope: 'personal', content: '后来才加的铁律，不应该出现在这场会话里。', now: '2026-02-01T00:00:00.000Z' });
    other.close();
    const turn = await core.handle({ type: 'user_message', sessionId: 's1', text: '帮我看一下这个构建为什么这么慢，有没有缓存没命中' });
    assert.equal(turn.staticBlock, undefined, '静态区只在 session_start 出现');
    const again = await core.handle({ type: 'session_start', sessionId: 's1', resume: true });
    assert.equal(again.staticBlock, block, '同一会话第二次 session_start 原字节返回');
    const fresh = await core.handle({ type: 'session_start', sessionId: 's2' });
    assert.match(fresh.staticBlock ?? '', /后来才加的铁律/, '新会话才重算');
    assert.notEqual(fresh.staticBlock, block);

    // 无关的中文长句：检索做了但没有过线项 → 静默，提醒为空
    assert.equal(turn.hint, '');
    assert.equal(turn.hintState, 'silent');
    assert.match(turn.hintReason ?? '', /没找到候选|没到 0\.72/);
  } finally {
    await cleanup(root, core);
  }
});

test('中文提醒：改述命中一条；寒暄 / 斜杠为空；同会话不重复；强纠错允许再提醒', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const core = new HostCore(config(root), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const hit = await core.handle({ type: 'user_message', sessionId: 's1', text: DELETE_QUERY });
    assert.equal(hit.hintState, 'hinted', hit.hintReason);
    assert.match(hit.hint, /^<memory-hint>\n/);
    assert.match(hit.hint, /\n<\/memory-hint>$/);
    assert.ok(hit.hint.length <= 400, `提醒 ${hit.hint.length} 字`);
    assert.match(hit.hint, /\[P\d+\] 先检查它是不是软链接/);
    assert.equal(hit.hint.split('\n').filter((line) => line.startsWith('- ')).length, 1, '只有一条');

    const greet = await core.handle({ type: 'user_message', sessionId: 's1', text: '你好你好' });
    assert.equal(greet.hint, '');
    assert.equal(greet.hintState, 'skipped');
    const slash = await core.handle({ type: 'user_message', sessionId: 's1', text: `/compact ${DELETE_QUERY}` });
    assert.equal(slash.hint, '');
    assert.equal(slash.hintState, 'skipped');
    assert.equal(shouldHint(`/compact ${DELETE_QUERY}`).ok, false);

    const repeat = await core.handle({ type: 'user_message', sessionId: 's1', text: '递归删文件夹的时候快捷方式那份也被删了' });
    assert.equal(repeat.hint, '', '本会话已经提醒过的条目不再出现');
    assert.equal(repeat.hintState, 'empty');

    const re = await core.handle({ type: 'user_message', sessionId: 's1', text: `不对，你又递归删目录的时候把快捷方式指到的那份一起删了` });
    assert.equal(re.correction.captured, true, '强纠错立刻入库');
    assert.equal(re.hintState, 'hinted', '再次明确违背时允许重复提醒');
    assert.match(re.hint, /软链接/);
  } finally {
    await cleanup(root, core);
  }
});

test('工具失败（真正非零或 isError）才触发提醒；成功的工具调用只计数', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const core = new HostCore(config(root), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const ok = await core.handle({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', exitCode: 0, output: 'ENOENT 这段文字虽然出现但退出码是 0' });
    assert.equal(ok.hint, '');
    assert.equal(ok.hintState, 'off');
    const fail = await core.handle({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', exitCode: 1, output: "npm ERR! enoent ENOENT: no such file or directory, open '/srv/app/config.yaml'" });
    assert.equal(fail.hintState, 'hinted', fail.hintReason);
    assert.match(fail.hint, /\[E\d+\] 构建报 ENOENT/);
    assert.equal(toolFailed({ type: 'tool_result', sessionId: 'x', toolName: 'B', isError: true }), true);
    assert.equal(toolFailed({ type: 'tool_result', sessionId: 'x', toolName: 'B', exitCode: 0 }), false);
  } finally {
    await cleanup(root, core);
  }
});

test('纠错即时入库 → 后台凝结；第 10 轮用户消息触发复盘抽取（去掉 memloom 自己的注入）；关会话没有新消息就不抢救', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const seen: ConversationMessage[][] = [];
  const calls = { count: 0 };
  const core = new HostCore(config(root, { extractionModel: extractionStub(seen, calls), condenseModel: CONDENSE_ADD }), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const correction = await core.handle({ type: 'user_message', sessionId: 's1', text: '不对，不要自作主张改我的项目文件。' });
    assert.equal(correction.correction.captured, true);
    const correctionId = correction.correction.experienceId as number;
    assert.ok(correctionId > 0);
    assert.deepEqual(correction.background.map((b) => [b.kind, b.state]), [['correction', 'queued']]);
    // 纠错已入库（不等后台）
    let store = openStore(join(root, 'personal.db'));
    assert.equal(store.listExperiences('personal', { limit: 10 }).some((e) => e.id === correctionId && e.kind === 'correction'), true);
    store.close();
    await core.settle();
    store = openStore(join(root, 'personal.db'));
    assert.equal(store.listPrinciples('personal').some((p) => p.rule.includes('不许擅自动手')), true, '后台把纠错凝结成了原则');
    assert.equal(store.listPendingExperiences('personal', 10).some((e) => e.id === correctionId), false, '纠错那条已凝结处理');
    store.close();

    // 再 9 轮普通消息（第 1 轮带着上一轮的提醒块、助手回复也带注入，宿主原样回传）→ 第 10 轮用户消息触发复盘；第 11 轮不再触发
    const kinds: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const user = await core.handle({
        type: 'user_message',
        sessionId: 's1',
        text: i === 0 ? `删目录前要先看是不是软链接\n<memory-hint>\n与当前情况高度相关的历史提醒：\n- [P3] 先检查它是不是软链接\n</memory-hint>` : `第 ${i + 2} 轮：继续改构建脚本`,
      });
      kinds.push(...user.background.map((b) => b.kind));
      await core.handle({ type: 'assistant_message', sessionId: 's1', text: `第 ${i + 2} 轮回复<memory-hint>\n- [P3] 不该被记住\n</memory-hint>` });
    }
    assert.deepEqual(kinds, ['review'], '第 10 轮用户消息触发一次复盘');
    await core.settle();
    assert.ok(calls.count >= 1, `抽取模型被调用 ${calls.count} 次`);
    for (const messages of seen) {
      for (const message of messages) assert.doesNotMatch(message.text, /memory-hint/, '送给后台的对话里没有 memloom 自己的注入');
    }
    assert.equal(stripInjections('前面<memory-hint>\n- x\n</memory-hint>后面'), '前面后面');
    store = openStore(join(root, 'personal.db'));
    assert.equal(store.listExperiences('personal', { limit: 20 }).some((e) => e.source === 'review' && e.summary.includes('软链接')), true, '复盘抽取出一条经历');
    store.close();

    const eleventh = await core.handle({ type: 'user_message', sessionId: 's1', text: '第十一轮：顺便说一下软链接的事' });
    assert.deepEqual(eleventh.background, []);
    const end = await core.handle({ type: 'session_end', sessionId: 's1' });
    // 第 11 轮那一句还没交过抽取：关会话抢救一次，只采集不凝结
    assert.deepEqual(end.background.map((b) => b.kind), ['flush']);
    await core.settle();
    store = openStore(join(root, 'personal.db'));
    // 抢救确实跑了，但同一条经历复盘时已经记过：不重复记
    assert.equal(store.listExperiences('personal', { limit: 50 }).filter((e) => e.summary.includes('软链接')).length, 1, '抢救没有把同一条经历再记一遍');
    store.close();
    assert.ok(core.recentLog().some((line) => line.includes('后台 flush：完成')), core.recentLog().join('\n'));
  } finally {
    await cleanup(root, core);
  }
});

test('没有配置后台模型：纠错照样入库，后台登记 skipped，抽取模型一次都不调用（不外发）；fts-only 静默', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  let called = 0;
  const core = new HostCore(config(root, { llm: null }), { retriever: new FtsOnlyRetriever(), jobMode: 'inline' });
  core.config.extractionModel = { id: 'never', extract: async () => { called += 1; return []; } };
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const r = await core.handle({ type: 'user_message', sessionId: 's1', text: '不对，不要自作主张改我的项目文件。' });
    assert.equal(r.correction.captured, true);
    assert.deepEqual(r.background, [{ kind: 'correction', state: 'skipped', reason: '没有配置后台模型（MEMLOOM_LLM_BASE_URL / MEMLOOM_LLM_MODEL），什么都没发' }]);
    assert.equal(r.hintState, 'silent', 'fts-only 检索器：提醒保持安静，不拿字面分冒充');
    assert.equal(called, 0);
    await core.settle();
  } finally {
    await cleanup(root, core);
  }
});

test('前台预算：精排拖过预算就 timeout 且提醒为空；残留的召回自己收尾', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const slow = fakeRetriever(semanticScore, 400);
  const core = new HostCore(config(root, { hint: { budgetMs: 80 } }), { retriever: slow, jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const r = await core.handle({ type: 'user_message', sessionId: 's1', text: DELETE_QUERY });
    assert.equal(r.hint, '');
    assert.equal(r.hintState, 'timeout');
    assert.ok((r.elapsedMs.hint ?? 0) < 350, `等了 ${String(r.elapsedMs.hint)} 毫秒`);
    await core.settle();
  } finally {
    await cleanup(root, core);
  }
});

test('分歧轻声通知：未提醒的 open ≥ 3 才提示且同批只一次；撞铁律一条就提示；拍板仍走人工入口', async () => {
  const root = temp();
  let store = openStore(join(root, 'personal.db'));
  store.insertDilemma({ scope: 'personal', kind: 'value_conflict', summary: '汇报要先说结论还是先铺背景', optionA: '先说结论', optionB: '先铺背景', now: '2026-01-01T00:00:00.000Z' });
  store.insertDilemma({ scope: 'personal', kind: 'value_conflict', summary: '提交前要不要跑全量测试', optionA: '跑', optionB: '不跑', now: '2026-01-01T00:00:00.000Z' });
  store.close();
  const core = new HostCore(config(root), { retriever: new FtsOnlyRetriever(), jobMode: 'inline' });
  try {
    const two = await core.handle({ type: 'session_start', sessionId: 'a' });
    assert.equal(two.dilemmaNotice, '', '两条不到阈值');
    store = openStore(join(root, 'personal.db'));
    store.insertDilemma({ scope: 'personal', kind: 'value_conflict', summary: '删目录前要不要先 ls', optionA: '要', optionB: '不要', now: '2026-01-01T00:00:00.000Z' });
    store.close();
    const three = await core.handle({ type: 'session_start', sessionId: 'b' });
    assert.match(three.dilemmaNotice, /顺带一提：记忆系统里目前有 3 处/);
    assert.match(three.dilemmaNotice, /处理记忆分歧/);
    assert.ok(three.dilemmaNotice.length < 400);
    assert.equal((await core.handle({ type: 'session_start', sessionId: 'b', resume: true })).dilemmaNotice, '', '同一会话不再发');
    assert.equal((await core.handle({ type: 'session_start', sessionId: 'c' })).dilemmaNotice, '', '同一批已经提醒过（surfaced_count）');
    store = openStore(join(root, 'personal.db'));
    assert.equal(store.listDilemmas('personal').every((d) => d.surfacedCount === 1), true);
    assert.equal(store.listDilemmas('personal').every((d) => d.status === 'open'), true, '核心不替用户拍板');
    store.insertDilemma({ scope: 'personal', kind: 'iron_rule_collision', summary: '新原则和「不许擅自动手」撞上了', optionA: '保留铁律', optionB: '放开', now: '2026-01-01T00:00:00.000Z' });
    store.close();
    const collision = await core.handle({ type: 'session_start', sessionId: 'd' });
    assert.match(collision.dilemmaNotice, /撞上置顶铁律/);
  } finally {
    await cleanup(root, core);
  }
});

test('会话快照：关进程再开 core、库里加新铁律，同 sessionId 静态区逐字节相同、对话片段已清、提醒游标保留；新 sessionId 读新铁律；同 sessionId 换作用域 / 换库不串', async () => {
  const root = temp();
  const dbPath = join(root, 'personal.db');
  seed(dbPath);
  const a = new HostCore(config(root, { sessionStore: undefined }), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  const first = await a.handle({ type: 'session_start', sessionId: 'resume-me' });
  const hit = await a.handle({ type: 'user_message', sessionId: 'resume-me', text: DELETE_QUERY });
  assert.equal(hit.hintState, 'hinted');
  const end = await a.handle({ type: 'session_end', sessionId: 'resume-me' });
  assert.deepEqual(end.background.map((b) => b.kind), ['flush'], '关会话当场安排抢救，不等网络');
  await a.settle();
  a.close();
  const sessionDir = join(root, 'sessions');
  assert.ok(existsSync(sessionDir));
  assert.equal(statSync(sessionDir).mode & 0o777, 0o700, '会话目录只给当前用户');
  const files = readdirSync(sessionDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1, '关会话后快照仍在（续接用），只是对话片段清掉');
  assert.equal(statSync(join(sessionDir, files[0] as string)).mode & 0o777, 0o600, '快照文件只给当前用户');
  const saved = JSON.parse(readFileSync(join(sessionDir, files[0] as string), 'utf8')) as { messages: unknown[]; staticBlock: string; scope: string; dbPath: string };
  assert.deepEqual(saved.messages, [], '对话片段已清空');
  assert.equal(saved.scope, 'personal');
  assert.equal(saved.dbPath, dbPath);

  // 两个进程之间库里多了一条铁律：续接同一会话仍是原字节；新会话才读到新铁律
  const other = openStore(dbPath);
  other.addIronRule({ scope: 'personal', content: '两条进程之间才加的铁律。', now: '2026-02-01T00:00:00.000Z' });
  other.close();
  const seenAfter: ConversationMessage[][] = [];
  const b = new HostCore(config(root, { sessionStore: undefined, extractionModel: extractionStub(seenAfter, { count: 0 }) }), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    const resumed = await b.handle({ type: 'session_start', sessionId: 'resume-me', resume: true });
    assert.equal(resumed.staticBlock, first.staticBlock, '同 sessionId 续接原字节');
    assert.doesNotMatch(resumed.staticBlock ?? '', /两条进程之间才加的铁律/);
    const again = await b.handle({ type: 'user_message', sessionId: 'resume-me', text: '递归删文件夹的时候快捷方式那份也被删了' });
    assert.equal(again.hint, '', '上个进程提醒过的条目，这个进程不再重复（去重游标保留）');
    assert.equal(again.hintState, 'empty');
    const fresh = await b.handle({ type: 'session_start', sessionId: 'brand-new' });
    assert.match(fresh.staticBlock ?? '', /两条进程之间才加的铁律/, '新会话才取新铁律');
    const endAgain = await b.handle({ type: 'session_end', sessionId: 'resume-me' });
    assert.deepEqual(endAgain.background.map((b) => b.kind), ['flush'], '只抢救续接之后的那一句');
    await b.settle();
    assert.deepEqual(seenAfter.flat().map((m) => m.text), ['递归删文件夹的时候快捷方式那份也被删了'], '关会话前的对话片段没有被脱离任务写回来');
    assert.equal(readdirSync(sessionDir).filter((name) => name.endsWith('.json')).length, 2, '两个会话各一份快照');

    // 同 sessionId、另一个作用域 + 另一个库：各存各的，不借用 personal 的静态字节
    const projectDb = join(root, 'team', '.mind.db');
    const c = new HostCore(config(root, { sessionStore: undefined, dbPath: projectDb, scope: 'project:other' }), { retriever: new FtsOnlyRetriever(), jobMode: 'inline' });
    try {
      const foreign = await c.handle({ type: 'session_start', sessionId: 'resume-me', resume: true });
      assert.equal(foreign.staticBlock, '', '另一个作用域的空库：静态区是空串，没有借用 personal 的快照');
      assert.equal(readdirSync(sessionDir).filter((name) => name.endsWith('.json')).length, 3);
      await c.settle();
    } finally {
      c.close();
    }
  } finally {
    await cleanup(root, b);
  }
});

test('工具结果 skipHint：错误照常记录、计数和触发复盘，但不再等检索、提醒为空', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const slow = fakeRetriever(semanticScore, 300);
  const core = new HostCore(config(root), { retriever: slow, jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const before = await core.handle({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', exitCode: 1, output: "npm ERR! enoent ENOENT: no such file or directory" });
    assert.equal(before.hintState, 'hinted', '默认行为不变：失败就提醒');
    const skipped = await core.handle({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', exitCode: 1, output: "npm ERR! enoent ENOENT: no such file or directory", skipHint: true });
    assert.equal(skipped.hint, '');
    assert.equal(skipped.hintState, 'skipped');
    assert.equal(skipped.elapsedMs.hint, null, '没有等检索');
    assert.ok(skipped.elapsedMs.total < 100, `跳过时不该被 300 毫秒的慢检索拖住（${String(skipped.elapsedMs.total)} 毫秒）`);
    // 错误照样计数：累计到 15 次工具调用仍触发复盘（这里补 13 次，凑够 15）
    let reviewSeen = false;
    for (let i = 0; i < 13; i += 1) {
      const r = await core.handle({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', exitCode: 2, output: 'x', skipHint: true });
      reviewSeen = reviewSeen || r.background.some((b) => b.kind === 'review');
      assert.equal(r.hintState, 'skipped');
    }
    assert.equal(reviewSeen, true, '第 15 次工具调用触发复盘');
  } finally {
    await cleanup(root, core);
  }
});

test('事件校验：缺 sessionId 直接拒绝；不认识的事件类型拒绝；Pi 续会话的 startup 也只是同 sessionId 的 session_start', async () => {
  const root = temp();
  const core = new HostCore(config(root), { retriever: new FtsOnlyRetriever(), jobMode: 'inline' });
  try {
    await assert.rejects(() => core.handle({ type: 'user_message', sessionId: '', text: 'x' }), /sessionId/);
    await assert.rejects(() => core.handle({ type: 'nope', sessionId: 's' } as unknown as HostEvent));
    const first = await core.handle({ type: 'session_start', sessionId: 'pi-session' });
    const startupAgain = await core.handle({ type: 'session_start', sessionId: 'pi-session', resume: false });
    assert.equal(startupAgain.staticBlock, first.staticBlock);
  } finally {
    await cleanup(root, core);
  }
});

/* ---------- 工具计数触发复盘：回执必须在事务边界上就完整（回归：以前这里漏了 await） ---------- */

function copyBackground(result: unknown): BackgroundEntry[] {
  return ((result as HostResponse).background ?? []).map((entry) => ({ ...entry }));
}

/**
 * 包一层的会话存储：每次事务回调一返回（核心还没把状态存回去、锁还没释放）就抓一份回执里 background 的快照，
 * 存回去之后再抓一份。漏 await 时核心是「回调先返回、复盘条目事后才补进同一个对象」：调用者因为微任务顺序碰巧看得到，
 * 但事务边界上的那份快照是空的。
 */
function snapshottingStore(onReturned: BackgroundEntry[][], onReleased: BackgroundEntry[][]): SessionStore {
  const inner = new MemorySessionStore();
  return {
    withSession(sessionId, fn, options) {
      return inner
        .withSession(
          sessionId,
          async (state, fresh) => {
            const result = await fn(state, fresh);
            onReturned.push(copyBackground(result));
            return result;
          },
          options,
        )
        .then((result) => {
          onReleased.push(copyBackground(result));
          return result;
        });
    },
    load: (sessionId) => inner.load(sessionId),
    delete: (sessionId) => inner.delete(sessionId),
  };
}

/** 连续几次成功的 tool_result；记下每次回执回到调用者手上的时刻 */
async function feedTools(core: HostCore, count: number): Promise<Array<{ response: HostResponse; at: number }>> {
  const out: Array<{ response: HostResponse; at: number }> = [];
  for (let i = 1; i <= count; i += 1) {
    const response = await core.handle({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', exitCode: 0, output: `第 ${i} 次成功` });
    out.push({ response, at: Date.now() });
  }
  return out;
}

test('工具调用累计 15 次：第 15 次成功 tool_result 的回执在事务回调返回前就带上复盘条目，前 14 次不提前；只等投递、不等后台跑完', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const returned: BackgroundEntry[][] = [];
  const released: BackgroundEntry[][] = [];
  let calls = 0;
  let extractFinishedAt = Number.POSITIVE_INFINITY;
  const slowExtract: ExtractionModel = {
    id: 'slow-extract',
    // 慢抽取：核心要是等它跑完才回执，回执回到调用者手上的时刻就不会早于它跑完的时刻
    extract: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      extractFinishedAt = Date.now();
      return [];
    },
  };
  const core = new HostCore(config(root, { extractionModel: slowExtract, sessionStore: snapshottingStore(returned, released) }), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const fed = await feedTools(core, 15);
    for (const [index, { response }] of fed.entries()) {
      assert.equal(response.hintState, 'off', '成功的工具调用不触发提醒');
      if (index < 14) assert.deepEqual(response.background, [], `第 ${index + 1} 次不该提前触发复盘`);
    }
    const fifteenth = fed[14]?.response as HostResponse;
    // 调用者拿到的第 15 次回执本身
    assert.deepEqual(fifteenth.background, [{ kind: 'review', state: 'queued' }]);
    // 事务边界上（回调已返回、状态还没存回去）回执就已经完整：以前漏了 await，这里抓到的是空数组
    assert.equal(returned.length, 16, 'session_start + 15 次工具调用各一次事务');
    assert.deepEqual(returned.slice(0, 15), Array.from({ length: 15 }, () => []), '开场和前 14 次：事务返回时都没有复盘条目');
    assert.deepEqual(returned[15], [{ kind: 'review', state: 'queued' }], '第 15 次事务回调返回时，复盘条目已经在回执里');
    assert.deepEqual(released[15], [{ kind: 'review', state: 'queued' }], '状态存回去之后回执仍然完整');
    // 只等投递：抽取模型要 300 毫秒，第 15 次回执在它跑完之前就回到了调用者手上
    assert.ok((fed[14]?.at ?? 0) < extractFinishedAt, `回执在抽取跑完之后才回来（回执 ${String(fed[14]?.at)}，抽取完成 ${String(extractFinishedAt)}）`);
    await core.settle();
    assert.equal(calls, 1, '复盘任务在回执之后照常跑了一次');
  } finally {
    await cleanup(root, core);
  }
});

test('没有配置后台模型：第 15 次工具调用的回执同样在事务返回前就带上 skipped 的复盘条目', async () => {
  const root = temp();
  seed(join(root, 'personal.db'));
  const returned: BackgroundEntry[][] = [];
  const released: BackgroundEntry[][] = [];
  const core = new HostCore(config(root, { sessionStore: snapshottingStore(returned, released) }), { retriever: fakeRetriever(semanticScore), jobMode: 'inline' });
  try {
    await core.handle({ type: 'session_start', sessionId: 's1' });
    const fed = await feedTools(core, 15);
    const expected: BackgroundEntry[] = [{ kind: 'review', state: 'skipped', reason: '没有配置后台模型（MEMLOOM_LLM_BASE_URL / MEMLOOM_LLM_MODEL），什么都没发' }];
    assert.deepEqual(fed[14]?.response.background, expected);
    assert.deepEqual(returned[15], expected, '事务回调返回时 skipped 的复盘条目已经在回执里');
    assert.deepEqual(released[15], expected, '状态存回去之后回执仍然完整');
    assert.ok(returned.slice(0, 15).every((snapshot) => snapshot.length === 0), '前 14 次不提前');
  } finally {
    await cleanup(root, core);
  }
});
