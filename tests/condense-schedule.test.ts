import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/index.js';
import { condense } from '../src/core/condense.js';
import type { CondenseModel } from '../src/core/types.js';

/**
 * 接自动调度之前必须补的两例（M1 已复现的边界），只用临时内存库 + 离线模型：
 * 1）两个互不相连的调用在同一作用域上各自拿模型出计划，事务外查重看到的「现有原则」已过期 → 事务内复核字面去重；
 * 2）旧经历在后台排到很晚才凝出原则时，比那条经历新的真实纠错不能按原则的写入时间被拒。
 */

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

test('并发去重快照：同一作用域两个调用都拿旧快照出 add，只落一条，另一条经历保持待处理', async () => {
  const store = openStore(':memory:');
  try {
    const first = store.addExperience({ scope: 'personal', kind: 'correction', summary: '用户纠正了直接删目录的做法，要先看是不是软链接', evidence: '不对，先看是不是软链接', source: 'correction', createdAt: T0, occurredAt: T0 });
    const second = store.addExperience({ scope: 'personal', kind: 'correction', summary: '用户再次纠正：删目录之前先 ls -la，不要直接 rm -rf', evidence: '又直接删了，不对', source: 'correction', createdAt: T1, occurredAt: T1 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: CondenseModel = {
      id: 'dup-stub',
      plan: async (ctx) => {
        await gate; // 两个调用都先读完「现有原则」（此时都是空的），再一起放行
        return [
          {
            action: 'add',
            trigger_when: '当你准备删除一个目录的时候',
            rule: '先 ls -la 看一眼它是不是软链接，确认后再删，不要直接 rm -rf',
            rationale: null,
            is_core: false,
            source_experience_ids: [ctx.experiences[0]?.id as number],
          },
        ];
      },
    };
    const a = condense({ store, scope: 'personal', model, reason: 'manual', experienceIds: [first.id], now: () => T2 });
    const b = condense({ store, scope: 'personal', model, reason: 'manual', experienceIds: [second.id], now: () => T2 });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ran, true);
    assert.equal(rb.ran, true);
    if (!ra.ran || !rb.ran) return;
    assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, `恰好一个成功：${JSON.stringify([ra.ok, rb.ok])}`);
    const failed = ra.ok ? rb : ra;
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.match(failed.error, /字面几乎一样/);
    assert.equal(store.listPrinciples('personal').length, 1, '只落了一条原则');
    const pending = store.listPendingExperiences('personal', 10).map((e) => e.id);
    assert.deepEqual(pending, [ra.ok ? second.id : first.id], '失败那批经历保持待处理，可以重试');
  } finally {
    store.close();
  }
});

test('新旧证据基准：旧经历晚凝出的原则，比那条经历新的纠错可以 replace（不按原则写入时间拒）', async () => {
  const store = openStore(':memory:');
  try {
    const old = store.addExperience({ scope: 'personal', kind: 'preference', summary: '用户以前说删目录直接 rm -rf 就行', evidence: '直接删就行', source: 'review', createdAt: T0, occurredAt: T0 });
    const adder: CondenseModel = {
      id: 'add-stub',
      plan: (ctx) => Promise.resolve([{ action: 'add', trigger_when: '当你准备删除一个目录的时候', rule: '直接 rm -rf 就行，不用先检查', rationale: null, is_core: false, source_experience_ids: [ctx.experiences[0]?.id as number] }]),
    };
    const created = await condense({ store, scope: 'personal', model: adder, reason: 'manual', experienceIds: [old.id], now: () => T2 });
    assert.equal(created.ran && created.ok, true, '旧经历在 T2 才凝出原则');
    if (!(created.ran && created.ok)) return;
    const principleId = (created.actions[0]?.action === 'add' ? created.actions[0].principleId : 0);
    assert.equal(store.getPrinciple(principleId).createdAt, T2);

    // 纠错发生在 T0 之后、T2 之前：按「原则写入时间」会被拒，按「依据经历的发生时间」应当允许
    const correction = store.addExperience({ scope: 'personal', kind: 'correction', summary: '用户纠正：删目录之前必须先看是不是软链接', evidence: '不对，先看是不是软链接', source: 'correction', createdAt: T1, occurredAt: T1 });
    const replacer: CondenseModel = {
      id: 'replace-stub',
      plan: (ctx) =>
        Promise.resolve([
          { action: 'replace', target_id: principleId, trigger_when: '当你准备删除一个目录的时候', rule: '先 ls -la 看一眼它是不是软链接，确认后再删', rationale: '用户最新的纠错', is_core: false, source_experience_ids: [ctx.experiences[0]?.id as number] },
        ]),
    };
    const replaced = await condense({ store, scope: 'personal', model: replacer, reason: 'correction', experienceIds: [correction.id], now: () => T2 });
    assert.equal(replaced.ran && replaced.ok, true, replaced.ran && !replaced.ok ? replaced.error : '');
    assert.equal(store.getPrinciple(principleId).status, 'superseded');
    assert.equal(store.listPrinciples('personal').length, 1);
  } finally {
    store.close();
  }
});

test('新旧证据基准：比依据经历还旧的纠错仍然不能 replace', async () => {
  const store = openStore(':memory:');
  try {
    const base = store.addExperience({ scope: 'personal', kind: 'fact', summary: '项目构建命令是 make build', evidence: 'make build', source: 'review', createdAt: T1, occurredAt: T1 });
    const adder: CondenseModel = { id: 'add-stub', plan: (ctx) => Promise.resolve([{ action: 'add', trigger_when: '当你准备构建这个项目的时候', rule: '用 make build', rationale: null, is_core: false, source_experience_ids: [ctx.experiences[0]?.id as number] }]) };
    const created = await condense({ store, scope: 'personal', model: adder, reason: 'manual', experienceIds: [base.id], now: () => T2 });
    if (!(created.ran && created.ok)) throw new Error(created.ran ? created.error : 'no run');
    const principleId = (created.actions[0]?.action === 'add' ? created.actions[0].principleId : 0);
    const older = store.addExperience({ scope: 'personal', kind: 'correction', summary: '用户更早以前说过用 npm run build', evidence: 'npm run build', source: 'import', createdAt: T0, occurredAt: T0 });
    const replacer: CondenseModel = { id: 'replace-stub', plan: (ctx) => Promise.resolve([{ action: 'replace', target_id: principleId, trigger_when: '当你准备构建这个项目的时候', rule: '用 npm run build', rationale: null, is_core: false, source_experience_ids: [ctx.experiences[0]?.id as number] }]) };
    const result = await condense({ store, scope: 'personal', model: replacer, reason: 'correction', experienceIds: [older.id], now: () => T2 });
    assert.equal(result.ran && result.ok, false);
    if (result.ran && !result.ok) assert.match(result.error, /更新的纠错或事实经历/);
    assert.equal(store.getPrinciple(principleId).status, 'active');
  } finally {
    store.close();
  }
});
