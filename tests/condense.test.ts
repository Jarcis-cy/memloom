import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTRACTION_INSTRUCTIONS,
  SPACE_RULE,
  WRITING_EXAMPLES,
  WRITING_RULES,
  captureCorrection,
  condense,
  condenseInstructions,
  openStore,
  PlanError,
  searchExperiences,
  type AddAction,
  type CondenseContext,
  type CondenseModel,
  type CondenseResult,
  type DilemmaAction,
  type DuplicateJudge,
  type ExperienceKind,
  type PlanAction,
  type PrincipleInput,
  type ReplaceAction,
  type Store,
} from '../src/core/index.js';

const T0 = Date.parse('2026-11-27T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const SCOPE = 'personal';

async function withDb(fn: (store: Store, file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'memloom-condense-'));
  const file = join(dir, 'test.db');
  const store = openStore(file);
  try {
    await fn(store, file);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function pending(store: Store, kind: ExperienceKind, summary: string, minutes = 1, scope = SCOPE) {
  return store.addExperience({ scope, kind, summary, evidence: `用户原话：${summary}`, source: 'manual', createdAt: at(minutes) });
}

function principle(store: Store, n: number, minutes = 0, scope = SCOPE, extra: Partial<PrincipleInput> = {}) {
  return store.insertPrinciple({
    scope,
    triggerWhen: `当遇到第 ${n} 种情况的时候`,
    rule: `就按第 ${n} 种办法处理，先确认再动手，不要自作主张。`,
    now: at(minutes),
    ...extra,
  });
}

function mock(plan: PlanAction[] | ((ctx: CondenseContext) => PlanAction[] | Promise<PlanAction[]>)): CondenseModel {
  return {
    id: 'offline-mock',
    async plan(ctx) {
      return typeof plan === 'function' ? plan(ctx) : plan;
    },
  };
}

type Failed = Extract<CondenseResult, { ran: true; ok: false }>;
type Passed = Extract<CondenseResult, { ran: true; ok: true }>;

function expectFail(result: CondenseResult, pattern: RegExp): Failed {
  assert.equal(result.ran, true, JSON.stringify(result));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match((result as Failed).error, pattern);
  return result as Failed;
}

function expectPass(result: CondenseResult): Passed {
  assert.equal(result.ran, true, JSON.stringify(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Passed;
}

const replaceAction = (targetId: number, experienceIds: number[]): ReplaceAction => ({
  action: 'replace',
  target_id: targetId,
  trigger_when: '当你准备删除一个目录时',
  rule: '先 ls -la 看一眼它是不是软链接，确认后再删，不要带尾斜杠。',
  rationale: '用户刚刚纠正了旧做法',
  is_core: false,
  source_experience_ids: experienceIds,
});

const addAction = (triggerWhen: string, rule: string, experienceIds: number[], isCore = false): AddAction => ({
  action: 'add',
  trigger_when: triggerWhen,
  rule,
  rationale: null,
  is_core: isCore,
  source_experience_ids: experienceIds,
});

const dilemmaAction = (experienceIds: number[], related: number[] = []): DilemmaAction => ({
  action: 'dilemma',
  kind: 'iron_rule_collision',
  summary: '用户的新说法和「不许擅自删除任何文件」撞上了',
  option_a: '继续守住铁律，任何文件都不擅自删',
  option_b: '清理临时文件时允许直接全删',
  related_principle_ids: related,
  source_experience_ids: experienceIds,
});

test('闭环：记一条中文经历 → 中文 FTS 找回 → 离线模拟模型出凝结计划并应用 → 关库重开读回原则', async () => {
  await withDb(async (store, file) => {
    store.addIronRule({ scope: SCOPE, content: '没明说怎么处理就不许擅自动手。', now: at(0) });
    const old = store.insertPrinciple({
      scope: SCOPE,
      triggerWhen: '当你准备删除一个目录时',
      rule: '直接 rm -rf 就行，不用先看里面有什么。',
      now: at(0),
    });

    // 采集：用户纠错，立刻记一条 correction 经历
    const captured = captureCorrection(store, {
      scope: SCOPE,
      sessionId: 's1',
      turn: 1,
      message: '不对，删目录之前先 ls -la 看一眼是不是软链接。',
      now: at(5),
    });
    assert.ok('experience' in captured, JSON.stringify(captured));
    assert.equal(captured.experience.kind, 'correction');
    assert.equal(captured.experience.source, 'correction');

    // 召回：只用汉字就能找回（靠「软链接」三字窗口）
    const hits = searchExperiences(store, { scope: SCOPE, query: '删目录之前要先看看是不是软链接吗' });
    assert.deepEqual(hits.map((h) => h.experience.id), [captured.experience.id]);

    // 凝结：模型是注入的离线模拟，一条纠错就够 replace
    const result = await condense({
      store,
      scope: SCOPE,
      model: mock((ctx) => [replaceAction(old.id, ctx.experiences.map((e) => e.id))]),
      reason: captured.condense.reason,
      experienceIds: captured.condense.experienceIds,
      now: () => at(6),
    });
    const passed = expectPass(result);
    assert.deepEqual(passed.actions, [{ action: 'replace', principleId: old.id + 1, supersededId: old.id }]);
    assert.deepEqual(passed.processedExperienceIds, [captured.experience.id]);
    store.close();

    // 关库重开读回（withDb 收尾时再 close 一次是安全的）
    const again = openStore(file);
    try {
      const principles = again.listPrinciples(SCOPE, { status: 'all' });
      assert.equal(principles.length, 2);
      assert.equal(principles[0]!.status, 'superseded');
      assert.match(principles[0]!.retireReason ?? '', /被原则 #2 替代/);
      assert.equal(principles[1]!.status, 'active');
      assert.deepEqual(principles[1]!.parentIds, [old.id]);
      assert.deepEqual(principles[1]!.sourceExperienceIds, [captured.experience.id]);
      assert.equal(again.getExperience(captured.experience.id)?.processedAt, at(6));
      assert.deepEqual(again.listIronRules(SCOPE).map((r) => r.content), ['没明说怎么处理就不许擅自动手。']);
    } finally {
      again.close();
    }
  });
});

test('默认攒够 15 条才跑，一批最多 20 条；手动、纠错、定时入口可以提前跑；没有待处理就什么都不做', async () => {
  await withDb(async (store) => {
    const first = pending(store, 'preference', '用户要求汇报先说结论。');
    assert.deepEqual(await condense({ store, scope: SCOPE, model: mock([]), now: () => at(1) }), {
      ran: false,
      reason: 'below_threshold',
      pendingCount: 1,
      threshold: 15,
    });
    const manual = expectPass(await condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', now: () => at(1) }));
    assert.deepEqual(manual.actions, []);
    assert.equal(store.getExperience(first.id)?.processedAt, at(1), '空计划也算看过，经历标记已处理');
    assert.deepEqual(await condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', now: () => at(2) }), {
      ran: false,
      reason: 'nothing_pending',
      pendingCount: 0,
    });

    for (let i = 0; i < 25; i += 1) pending(store, 'preference', `偏好第 ${i} 条：汇报要说大白话，别绕。`);
    const seen: CondenseContext[] = [];
    expectPass(await condense({ store, scope: SCOPE, model: mock((ctx) => { seen.push(ctx); return []; }), now: () => at(3) }));
    assert.equal(seen[0]!.experiences.length, 15, '默认一批 15 条');
    assert.equal(store.countPendingExperiences(SCOPE), 10);
    // 再攒 15 条：待处理 25 条，超过上限 20；batchSize 给到 50 也只取 20
    for (let i = 25; i < 40; i += 1) pending(store, 'preference', `偏好第 ${i} 条：汇报要说大白话，别绕。`);
    assert.equal(store.countPendingExperiences(SCOPE), 25);
    expectPass(await condense({ store, scope: SCOPE, reason: 'timer', model: mock((ctx) => { seen.push(ctx); return []; }), batchSize: 50, now: () => at(4) }));
    assert.equal(seen[1]!.experiences.length, 20, '自动选取的硬上限是 20：待处理 25 条、batchSize 给 50 也只取 20');
    assert.equal(store.countPendingExperiences(SCOPE), 5);
    const rest = expectPass(await condense({ store, scope: SCOPE, model: mock([]), reason: 'timer', now: () => at(5) }));
    assert.equal(rest.processedExperienceIds.length, 5);
    assert.equal(store.countPendingExperiences(SCOPE), 0);
  });
});

test('一批最多 20 条对显式指定同样生效：21 条直接拒绝，模型没被调用、库里零写入、经历保持待处理；20 条和单条纠错照常走通', async () => {
  await withDb(async (store) => {
    const ids = Array.from({ length: 21 }, (_, i) => pending(store, 'preference', `第 ${i} 条待处理的经历。`).id);
    let modelCalls = 0;
    const counting = mock(() => {
      modelCalls += 1;
      return [];
    });
    await assert.rejects(
      condense({ store, scope: SCOPE, model: counting, reason: 'manual', experienceIds: ids, now: () => at(2) }),
      (error: unknown) => error instanceof PlanError && /一次最多处理 20 条经历，这次指定了 21 条/.test(error.message),
    );
    assert.equal(modelCalls, 0, '超限请求在送模型之前就被拒绝');
    assert.equal(store.countPendingExperiences(SCOPE), 21, '不截断、不丢，全部保持待处理');
    assert.equal(store.listExperiences(SCOPE, { limit: 50 }).every((e) => e.processedAt === null), true);
    assert.deepEqual(store.listPrinciples(SCOPE, { status: 'all' }), []);
    assert.deepEqual(store.listIronRules(SCOPE, { activeOnly: false }), []);
    assert.deepEqual(store.listDilemmas(SCOPE, { status: 'all' }), []);

    // 正好 20 条：走通
    const twenty = expectPass(await condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', experienceIds: ids.slice(0, 20), now: () => at(3) }));
    assert.equal(twenty.processedExperienceIds.length, 20);
    assert.equal(store.countPendingExperiences(SCOPE), 1);

    // 剩下那一条单独送：单条纠错路径同样不受影响
    const one = expectPass(await condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', experienceIds: [ids[20]!], now: () => at(4) }));
    assert.deepEqual(one.processedExperienceIds, [ids[20]]);
    assert.equal(store.countPendingExperiences(SCOPE), 0);
  });
});

test('一级冲突不打扰用户：abstract_merge 上位抽象并记血缘，retire 只标状态和原因，不删也不复活旧项', async () => {
  await withDb(async (store) => {
    const e0 = pending(store, 'pitfall', '以前踩过的坑。');
    store.markExperiencesProcessed([e0.id], at(0));
    const a = principle(store, 1, 0, SCOPE, { sourceExperienceIds: [e0.id] });
    const b = principle(store, 2, 0);
    const c = principle(store, 3, 0);
    const e1 = pending(store, 'pitfall', '删目录前要先看一眼是不是软链接。');
    const e2 = pending(store, 'preference', '汇报要先说结论。');

    const result = expectPass(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(2),
        model: mock([
          {
            action: 'abstract_merge',
            target_ids: [a.id, b.id],
            trigger_when: '当你准备对别人的东西动手之前',
            rule: '先看清楚它到底是什么，再决定怎么做，不要一上来就按最省事的办法处理。',
            rationale: '两条旧原则说的都是先看再动',
            is_core: false,
            source_experience_ids: [e1.id],
          },
          { action: 'retire', target_id: c.id, reason: '这是上一个项目的一次性做法，现在用不上了。' },
        ]),
      }),
    );
    const mergedId = a.id + 3;
    assert.deepEqual(result.actions, [
      { action: 'abstract_merge', principleId: mergedId, mergedIds: [a.id, b.id] },
      { action: 'retire', principleId: c.id },
    ]);
    assert.deepEqual(result.processedExperienceIds, [e1.id, e2.id]);

    const merged = store.getPrinciple(mergedId);
    assert.equal(merged.status, 'active');
    assert.deepEqual(merged.parentIds, [a.id, b.id]);
    assert.deepEqual(merged.sourceExperienceIds, [e0.id, e1.id], '血缘证据继承自被合并的旧原则');
    for (const old of [a, b]) {
      const row = store.getPrinciple(old.id);
      assert.equal(row.status, 'merged');
      assert.equal(row.retireReason, `已上位抽象合并为原则 #${mergedId}`);
      assert.equal(row.rule, old.rule, '旧原则原文不改');
    }
    const retired = store.getPrinciple(c.id);
    assert.equal(retired.status, 'retired');
    assert.equal(retired.retireReason, '这是上一个项目的一次性做法，现在用不上了。');
    assert.equal(store.listPrinciples(SCOPE, { status: 'all' }).length, 4, '软淘汰不删历史');
    assert.deepEqual(store.listPrinciples(SCOPE).map((p) => p.id), [mergedId]);

    // 已退役的原则不能再被别的动作使用
    const e3 = pending(store, 'preference', '又一条经历。');
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(3), model: mock([{ action: 'reinforce', target_id: c.id, rationale: null, source_experience_ids: [e3.id] }]) }),
      /已经是「retired」状态/,
    );
    assert.equal(store.getPrinciple(c.id).status, 'retired', '退役项不复活');
  });
});

test('二级冲突：一条最新的纠错就能 replace 旧原则；旧经历、非纠错经历不能 replace；reinforce 只补证据加强度', async () => {
  await withDb(async (store) => {
    const old = principle(store, 1, 0);
    const ePit = pending(store, 'pitfall', '之前踩过的坑：直接删目录会误删。', 1);

    // 只有踩坑经历，不能 replace
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(2), model: mock([replaceAction(old.id, [ePit.id])]) }),
      /纠错或事实经历作依据/,
    );
    assert.equal(store.getExperience(ePit.id)?.processedAt, null, '计划被拒，经历仍未处理，可以重试');

    // 纠错但发生得比旧原则还早，也不能 replace
    const eOld = pending(store, 'correction', '很早以前的一次纠错。', -30);
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(2), model: mock([replaceAction(old.id, [eOld.id])]) }),
      /纠错或事实经历作依据/,
    );
    assert.equal(store.listPrinciples(SCOPE).length, 1);
    assert.equal(store.getPrinciple(old.id).status, 'active');

    // 用户刚刚的纠错：一条就够
    const captured = captureCorrection(store, { scope: SCOPE, sessionId: 's1', turn: 7, message: '不对，删目录之前要先看是不是软链接。', now: at(30) });
    assert.ok('experience' in captured);
    const result = expectPass(
      await condense({
        store,
        scope: SCOPE,
        model: mock((ctx) => [replaceAction(old.id, ctx.experiences.map((e) => e.id))]),
        reason: captured.condense.reason,
        experienceIds: captured.condense.experienceIds,
        now: () => at(31),
      }),
    );
    const newId = old.id + 1;
    assert.deepEqual(result.actions, [{ action: 'replace', principleId: newId, supersededId: old.id }]);
    assert.equal(store.getPrinciple(old.id).status, 'superseded');
    assert.deepEqual(store.getPrinciple(newId).parentIds, [old.id]);
    assert.deepEqual(store.getPrinciple(newId).sourceExperienceIds, [captured.experience.id]);
    assert.equal(store.getExperience(ePit.id)?.processedAt, null, '没被这次纠错批带上的经历仍待处理');

    // reinforce：强度加上去、证据并进去，原意一个字不改
    const reinforced = expectPass(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(32),
        model: mock([{ action: 'reinforce', target_id: newId, rationale: '又一次印证', source_experience_ids: [ePit.id] }]),
      }),
    );
    assert.deepEqual(reinforced.actions, [{ action: 'reinforce', principleId: newId }]);
    const row = store.getPrinciple(newId);
    assert.equal(row.strength, 1.5);
    assert.deepEqual(row.sourceExperienceIds, [ePit.id, captured.experience.id], '证据按编号升序合并');
    assert.equal(row.rule, '先 ls -la 看一眼它是不是软链接，确认后再删，不要带尾斜杠。');
    assert.equal(store.getExperience(eOld.id)?.processedAt, at(32), '同批其余经历标记已处理');
  });
});

test('三级冲突只进分歧队列：撞铁律或前后方向矛盾时登记 dilemma，原则和铁律一字不改，也不重复登记', async () => {
  await withDb(async (store) => {
    const rule = store.addIronRule({ scope: SCOPE, content: '不许擅自删除任何文件。', now: at(0) });
    const p = principle(store, 1, 0);
    const e = pending(store, 'fact', '用户说清理临时文件时可以直接全删。');

    // 一边说要用户拍板，一边又想顺手淘汰同一条原则：拒
    expectFail(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(2),
        model: mock([dilemmaAction([e.id], [p.id]), { action: 'retire', target_id: p.id, reason: '想顺手淘汰。' }]),
      }),
      /需要用户拍板的分歧/,
    );

    const seen: CondenseContext[] = [];
    const result = expectPass(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(2), model: mock((ctx) => { seen.push(ctx); return [dilemmaAction([e.id], [p.id])]; }) }),
    );
    assert.deepEqual(result.actions, [{ action: 'dilemma', dilemmaId: 1 }]);
    assert.deepEqual(seen[0]!.ironRules, [{ id: rule.id, content: '不许擅自删除任何文件。' }], '铁律只读地给模型看');
    assert.equal(seen[0]!.capacity.nearLimit, false);

    const dilemmas = store.listDilemmas(SCOPE);
    assert.equal(dilemmas.length, 1);
    assert.equal(dilemmas[0]!.kind, 'iron_rule_collision');
    assert.deepEqual(dilemmas[0]!.relatedPrincipleIds, [p.id]);
    assert.deepEqual(dilemmas[0]!.sourceExperienceIds, [e.id]);
    assert.equal(dilemmas[0]!.status, 'open');
    assert.equal(store.getPrinciple(p.id).status, 'active');
    assert.equal(store.getPrinciple(p.id).rule, p.rule);
    assert.deepEqual(store.listIronRules(SCOPE, { activeOnly: false }).map((r) => [r.id, r.content, r.active]), [[rule.id, '不许擅自删除任何文件。', true]]);
    assert.equal(store.getExperience(e.id)?.processedAt, at(2));

    // 同样的分歧再登记一次：拒
    const e2 = pending(store, 'fact', '用户又说了一遍可以全删。');
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(3), model: mock([dilemmaAction([e2.id], [p.id])]) }),
      /已经登记过/,
    );

    // 前后说法矛盾：value_conflict 也只入队
    expectPass(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(3),
        model: mock([{ ...dilemmaAction([e2.id], [p.id]), kind: 'value_conflict', summary: '用户上个月说要少问多做，现在又要求每步都先问。' }]),
      }),
    );
    assert.deepEqual(store.listDilemmas(SCOPE).map((d) => d.kind), ['iron_rule_collision', 'value_conflict']);
    assert.equal(store.listPrinciples(SCOPE).length, 1);
  });
});

test('模型输出一律当数据：白名单外的动作、多余字段、英文法条、批外证据、失效或不存在的目标、跨作用域目标全部拒绝，库里零变化', async () => {
  await withDb(async (store) => {
    const p1 = principle(store, 1, 0);
    const other = principle(store, 2, 0, 'project:demo');
    const merged = principle(store, 3, 0);
    store.setPrincipleStatus(merged.id, 'merged', { retireReason: '已经合并了', now: at(0) });
    const e = pending(store, 'preference', '汇报要先说结论。');
    const before = store.listPrinciples(SCOPE, { status: 'all' }).map((p) => [p.id, p.status, p.rule]);

    const badPlans: Array<[unknown, RegExp]> = [
      [[{ action: 'iron_rule', content: '偷偷加一条铁律' }], /不在白名单里.*模型不能碰铁律/],
      [[{ action: 'add', trigger_when: '当你要写铁律的时候', rule: '随便往铁律里加一条。', scope: 'project:demo', source_experience_ids: [e.id] }], /多了不允许的字段「scope」/],
      [[{ action: 'add', trigger_when: 'When you delete a directory', rule: 'Explicitly establish required file modes and ownership including temporary files.', source_experience_ids: [e.id] }], /自然中文/],
      [[{ action: 'add', trigger_when: '当你准备删目录的时候', rule: '先看一眼它是不是软链接。', source_experience_ids: [999] }], /不在本批里的经历：999/],
      [[{ action: 'add', trigger_when: '当你准备删目录的时候', rule: '先看一眼它是不是软链接。', source_experience_ids: [] }], /要给 1 到 20 个编号/],
      [[{ action: 'reinforce', target_id: 999, rationale: null, source_experience_ids: [e.id] }], /目标原则 #999 不存在/],
      [[{ action: 'retire', target_id: merged.id, reason: '再淘汰一次。' }], /已经是「merged」状态/],
      [[{ action: 'retire', target_id: other.id, reason: '想动别的项目的原则。' }], /不属于当前作用域/],
      [[{ action: 'retire', target_id: p1.id }], /缺字段「reason」/],
      [[{ action: 'dilemma', kind: 'value_conflict', summary: '两个选项一样', option_a: '留着', option_b: '留着', source_experience_ids: [e.id] }], /两个选项一模一样/],
      [[{ action: 'add', trigger_when: '当你要汇报进展的时候', rule: '先说结论再说细节，不要绕圈子。', is_core: 'yes', source_experience_ids: [e.id] }], /只能是 true 或 false/],
      ['not an array', /不是动作数组/],
      [[{ action: 'add', trigger_when: '短', rule: '先说结论。', source_experience_ids: [e.id] }], /长度要在 4 到 200/],
    ];
    for (const [plan, pattern] of badPlans) {
      expectFail(await condense({ store, scope: SCOPE, model: mock(plan as PlanAction[]), reason: 'manual', now: () => at(2) }), pattern);
    }
    assert.deepEqual(store.listPrinciples(SCOPE, { status: 'all' }).map((p) => [p.id, p.status, p.rule]), before);
    assert.equal(store.getExperience(e.id)?.processedAt, null);
    assert.deepEqual(store.listIronRules(SCOPE, { activeOnly: false }), []);
    assert.deepEqual(store.listDilemmas(SCOPE), []);
    assert.equal(store.listPrinciples('project:demo')[0]!.status, 'active');

    // 模型自己抛错也不落库
    const failing: CondenseModel = { id: 'broken', async plan() { throw new Error('模型掉线了'); } };
    expectFail(await condense({ store, scope: SCOPE, model: failing, reason: 'manual', now: () => at(2) }), /没有给出计划：模型掉线了/);
    assert.equal(store.getExperience(e.id)?.processedAt, null);

    // 换成好计划就成功
    const good = expectPass(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(3),
        model: mock([addAction('当你要汇报工作进展的时候', '先把结论用一句话说清楚，再按重要程度展开细节，不要倒着讲。', [e.id])]),
      }),
    );
    assert.deepEqual(good.actions, [{ action: 'add', principleId: 4 }]);
    assert.equal(store.getPrinciple(4)!.rationale, null);
    assert.equal(store.getPrinciple(4)!.isCore, false);
  });
});

test('坏输出不会只成功前半批：第二个动作失败，第一个动作一起回滚，经历仍未处理、铁律不变', async () => {
  await withDb(async (store) => {
    store.addIronRule({ scope: SCOPE, content: '不许擅自 push。', now: at(0) });
    const e = pending(store, 'preference', '汇报要先说结论。');
    const result = expectFail(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(2),
        model: mock([addAction('当你要汇报工作进展的时候', '先把结论用一句话说清楚，再按重要程度展开细节，不要倒着讲。', [e.id]), { action: 'reinforce', target_id: 999, rationale: null, source_experience_ids: [e.id] }]),
      }),
      /目标原则 #999 不存在/,
    );
    assert.equal(result.modelId, 'offline-mock');
    assert.deepEqual(store.listPrinciples(SCOPE, { status: 'all' }), []);
    assert.equal(store.getExperience(e.id)?.processedAt, null);
    assert.deepEqual(store.listIronRules(SCOPE).map((r) => r.content), ['不许擅自 push。']);
  });
});

test('已被别的处理消费的同批输入和失效目标都会被挡住；别的作用域的经历不能拿来当这一批', async () => {
  await withDb(async (store) => {
    const e = pending(store, 'preference', '汇报要先说结论。');
    expectPass(await condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', now: () => at(2) }));
    await assert.rejects(
      condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', experienceIds: [e.id], now: () => at(3) }),
      /已经处理过的：1/,
    );
    await assert.rejects(
      condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', experienceIds: [424242], now: () => at(3) }),
      /指定的经历不存在/,
    );
    const foreign = pending(store, 'preference', '别的项目的经历。', 1, 'project:demo');
    await assert.rejects(
      condense({ store, scope: SCOPE, model: mock([]), reason: 'manual', experienceIds: [foreign.id], now: () => at(3) }),
      /不在当前作用域/,
    );
    assert.equal(store.getExperience(foreign.id)?.processedAt, null);

    // 模型出计划期间，别的处理抢先把这条经历消费了：落库前复核，整体拒绝
    const racing = pending(store, 'preference', '被抢先处理的经历。');
    const racy: CondenseModel = {
      id: 'racy',
      async plan() {
        store.markExperiencesProcessed([racing.id], at(9));
        return [];
      },
    };
    expectFail(await condense({ store, scope: SCOPE, model: racy, reason: 'manual', now: () => at(10) }), /已经被别的凝结处理过了/);
  });
});

test('去重：字面几乎一样确定性拦截；真实中文同义句交给注入的语义判断，说重复就拒、说不重复就放行', async () => {
  await withDb(async (store) => {
    const existing = store.insertPrinciple({
      scope: SCOPE,
      triggerWhen: '当你准备删除一个目录的时候',
      rule: '删除目录前先检查它是不是软链接，不要带尾斜杠直接删。',
      now: at(0),
    });
    const e1 = pending(store, 'preference', '用户又说了一遍删目录的事。');

    // 字面几乎一样：不用任何模型也能拦
    expectFail(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(2),
        model: mock([addAction('当你准备删除一个目录时', '删除目录前先检查它是不是软链接，别带尾斜杠直接删。', [e1.id])]),
      }),
      /字面几乎一样/,
    );

    // 真实同义句：字面查重放过，语义判断说重复
    const synonym = addAction('删目录之前', '先看看目标是不是符号链接，是的话别直接删。', []);
    const judge = (verdict: number | null, expectedRule: string, expectedPool: number[]): DuplicateJudge => ({
      id: `judge-${String(verdict)}`,
      async findDuplicate(candidate, pool) {
        assert.equal(candidate.rule, expectedRule, '语义判断拿到的是新原则原文');
        assert.deepEqual(pool.map((p) => p.id), expectedPool, '语义判断只和不属于本次目标的原则比');
        return verdict;
      },
    });
    const synonymRule = '先看看目标是不是符号链接，是的话别直接删。';
    const e2 = pending(store, 'preference', '又一次提到删目录。');
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(3), judge: judge(existing.id, synonymRule, [existing.id]), model: mock([{ ...synonym, source_experience_ids: [e2.id] }]) }),
      /语义查重判断新原则和已有的原则 #1 说的是同一件事/,
    );
    assert.equal(store.getExperience(e2.id)?.processedAt, null);

    // 同一句同义话，语义判断说不重复：放行（正例）
    const e3 = pending(store, 'preference', '第三次提到删目录。');
    expectPass(await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(4), judge: judge(null, synonymRule, [existing.id]), model: mock([{ ...synonym, source_experience_ids: [e3.id] }]) }));
    assert.equal(store.listPrinciples(SCOPE).length, 2);

    // 判断返回了不在可比较范围里的编号：判定不可信，拒绝
    const e4 = pending(store, 'preference', '第四次提到周报。');
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(5), judge: judge(424242, '先把结论排在最上面，再列细节。', [existing.id, 2]), model: mock([{ ...addAction('写周报之前', '先把结论排在最上面，再列细节。', [e4.id]) }]) }),
      /不在可比较的原则里/,
    );

    // 同一批里两条一样的新原则：拒
    const e5 = pending(store, 'preference', '第五次提到删目录。');
    expectFail(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(6),
        model: mock([
          addAction('当你要发周报的时候', '先把本周结论写成一排在最上面，再列细节。', [e5.id]),
          addAction('当你要发周报时', '先把本周结论写成一排在最上面，再列出细节。', [e5.id]),
        ]),
      }),
      /两条新原则说的是同一件事/,
    );
  });
});

function longPrinciple(store: Store, n: number, triggerWhen: string, rule: string, isCore = false) {
  return store.insertPrinciple({ scope: SCOPE, triggerWhen, rule, isCore, now: at(0) });
}

const pad = (text: string, length: number) => text.repeat(Math.ceil(length / text.length)).slice(0, length);

test('容量：近 80% 只许先腾空间再新增；字数硬上限和常驻核心 ≤8 直接拒绝；角色域按 30 / 40 条算', async () => {
  await withDb(async (store) => {
    // 个人域软上限 100：80 条开始算接近上限
    for (let i = 0; i < 80; i += 1) longPrinciple(store, i, `当遇到第 ${i} 种情况的时候`, `就按第 ${i} 种办法处理，先确认再动手。`);
    assert.equal(store.capacity(SCOPE).nearLimit, true);
    const e1 = pending(store, 'preference', '汇报要先说结论。');
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(2), model: mock([addAction('当你要汇报工作进展的时候', '先把结论用一句话说清楚，再按重要程度展开细节，不要倒着讲。', [e1.id])]) }),
      /已接近上限（80\/100 条/,
    );
    assert.equal(store.getExperience(e1.id)?.processedAt, null);
    const e2 = pending(store, 'preference', '再来一条经历。');
    const withRetire = expectPass(
      await condense({
        store,
        scope: SCOPE,
        reason: 'manual',
        now: () => at(3),
        model: mock([addAction('当你要汇报工作进展的时候', '先把结论用一句话说清楚，再按重要程度展开细节，不要倒着讲。', [e2.id]), { action: 'retire', target_id: 1, reason: '第 1 种情况早就不再出现了。' }]),
      }),
    );
    assert.equal(withRetire.actions.length, 2);
    assert.equal(store.capacity(SCOPE).activeCount, 80);
    assert.equal(store.capacity(SCOPE).coreCount, 0);
  });

  await withDb(async (store) => {
    // 字数硬上限 25,000：条数没到 80%，但一次 replace 把总字数顶过线，整体回滚
    for (let i = 0; i < 31; i += 1) longPrinciple(store, i, pad(`当遇到第 ${i} 种情况的时候，`, 200), pad(`就按第 ${i} 种办法处理，先确认再动手。`, 600));
    const short = longPrinciple(store, 99, '当你要发周报的时候', '先写结论。');
    assert.equal(store.capacity(SCOPE).activeCount, 32);
    assert.equal(store.capacity(SCOPE).nearLimit, true);
    const e = pending(store, 'correction', '周报要先写结论再列细节，每项都展开说清楚。');
    const result = await condense({
      store,
      scope: SCOPE,
      reason: 'manual',
      now: () => at(2),
      model: mock([{ ...replaceAction(short.id, [e.id]), trigger_when: pad('当你要写周报的时候，', 200), rule: pad('周报先写结论，再把每一项细节展开说清楚，不要省略。', 600) }]),
    });
    expectFail(result, /超过硬上限 25000 字/);
    assert.equal(store.getPrinciple(short.id).status, 'active');
    assert.equal(store.listPrinciples(SCOPE).length, 32);
    assert.equal(store.getExperience(e.id)?.processedAt, null);
  });

  await withDb(async (store) => {
    // 常驻核心最多 8 条
    for (let i = 0; i < 8; i += 1) longPrinciple(store, i, `当遇到第 ${i} 种情况的时候`, `就按第 ${i} 种办法处理。`, true);
    const e = pending(store, 'preference', '汇报要先说结论。');
    expectFail(
      await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(2), model: mock([addAction('当你要汇报工作进展的时候', '先把结论用一句话说清楚，再按重要程度展开细节，不要倒着讲。', [e.id], true)]) }),
      /常驻核心原则会到 9 条/,
    );
    expectPass(await condense({ store, scope: SCOPE, reason: 'manual', now: () => at(3), model: mock([addAction('当你要汇报工作进展的时候', '先把结论用一句话说清楚，再按重要程度展开细节，不要倒着讲。', [e.id])]) }));
    assert.equal(store.capacity(SCOPE).coreCount, 8);
  });

  await withDb(async (store) => {
    // 角色域软上限 30：24 条就是 80%
    for (let i = 0; i < 24; i += 1) principle(store, i, 0, 'role:reviewer');
    assert.equal(store.capacity('role:reviewer').nearLimit, true);
    const e = pending(store, 'preference', '评审意见要先说结论。', 1, 'role:reviewer');
    expectFail(
      await condense({ store, scope: 'role:reviewer', reason: 'manual', now: () => at(2), model: mock([addAction('当你要写评审意见的时候', '先把最重要的结论写在最前面，再逐条说明理由。', [e.id])]) }),
      /已接近上限（24\/30 条/,
    );
  });
});

test('提示词：凝结与提取都用自然中文，原样带上规格第 6 节的三条铁律、正反例和「省空间靠上位抽象合并与淘汰旧项，绝不靠压缩语序」', () => {
  const condensePrompt = condenseInstructions(8);
  for (const rule of WRITING_RULES) assert.ok(condensePrompt.includes(rule), rule);
  for (const example of WRITING_EXAMPLES) assert.ok(condensePrompt.includes(example), example);
  assert.ok(condensePrompt.includes(SPACE_RULE));
  for (const action of ['add', 'reinforce', 'abstract_merge', 'replace', 'retire', 'dilemma']) {
    assert.ok(condensePrompt.includes(`"${action}"`), action);
  }
  assert.ok(condensePrompt.includes('最多 8 条'));
  assert.ok(condensePrompt.includes('置顶铁律只读'));
  assert.ok(condensePrompt.includes('一条有依据的经历就够'));

  for (const rule of WRITING_RULES) assert.ok(EXTRACTION_INSTRUCTIONS.includes(rule), rule);
  assert.ok(EXTRACTION_INSTRUCTIONS.includes(SPACE_RULE));
  for (const kind of ['correction', 'preference', 'pitfall', 'decision', 'fact']) assert.ok(EXTRACTION_INSTRUCTIONS.includes(kind));
  assert.ok(EXTRACTION_INSTRUCTIONS.includes('逐字摘录'));
  assert.ok(EXTRACTION_INSTRUCTIONS.includes('[]'));
});
