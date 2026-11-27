import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FTS_TRIGGER_NAMES,
  buildQueryPlan,
  openStore,
  searchExperiences,
  searchPrinciples,
  type Store,
} from '../src/core/index.js';

const T0 = '2026-11-27T10:00:00.000Z';

async function withTempDb(fn: (store: Store, file: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'memloom-store-'));
  const file = join(dir, 'test.db');
  const store = openStore(file);
  try {
    await fn(store, file);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sampleExperiences(store: Store): void {
  store.addExperience({ scope: 'personal', kind: 'pitfall', summary: '删除软链接目录时不要带尾斜杠，会顺着链接误删目标目录', evidence: '用户说：不要带尾斜杠', source: 'manual', createdAt: T0 });
  store.addExperience({ scope: 'personal', kind: 'pitfall', summary: '遇到 ENOENT 报错先检查路径是不是软链接', evidence: null, source: 'manual', createdAt: T0 });
  store.addExperience({ scope: 'personal', kind: 'preference', summary: '改完代码先执行 npm run build，否则跑的是旧产物', evidence: null, source: 'manual', createdAt: T0 });
  store.addExperience({ scope: 'personal', kind: 'preference', summary: '用户要求汇报先说结论，再说细节', evidence: null, source: 'manual', createdAt: T0 });
}

test('真实文件库：WAL、外键、四张核心表、FTS5 trigram 外部内容表和三个同步触发器都在', async () => {
  await withTempDb((store, file) => {
    assert.equal(store.pragma('journal_mode'), 'wal');
    assert.equal(store.pragma('foreign_keys'), 1);

    // 另开一个 SQLite 连接看磁盘上的真实结构，不走业务接口
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const objects = raw
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name IN ('iron_rules', 'experiences', 'principles', 'dilemmas', 'experiences_fts') OR type = 'trigger' ORDER BY name")
        .all() as Array<{ type: string; name: string; sql: string }>;
      for (const table of ['iron_rules', 'experiences', 'principles', 'dilemmas']) {
        assert.ok(objects.some((o) => o.type === 'table' && o.name === table), `缺表 ${table}`);
      }
      const fts = objects.find((o) => o.name === 'experiences_fts');
      assert.ok(fts, '缺 experiences_fts');
      assert.ok(fts.sql.includes("tokenize = 'trigram'"), '经历全文索引必须用 trigram 分词');
      assert.ok(fts.sql.includes("content = 'experiences'"), '经历全文索引必须是外部内容表');
      for (const trigger of FTS_TRIGGER_NAMES) {
        assert.ok(objects.some((o) => o.type === 'trigger' && o.name === trigger), `缺触发器 ${trigger}`);
      }
      const columns = (name: string) =>
        (raw.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(columns('experiences'), [
        'id', 'scope', 'kind', 'summary', 'evidence', 'source', 'source_session', 'embedding', 'embedding_model',
        'occurred_at', 'created_at', 'processed_at', 'hit_count', 'last_hit_at',
      ]);
      assert.deepEqual(columns('principles'), [
        'id', 'scope', 'trigger_when', 'rule', 'rationale', 'status', 'is_core', 'parent_ids', 'source_experience_ids',
        'embedding', 'embedding_model', 'strength', 'applied_count', 'violated_count', 'retire_reason',
        'created_at', 'updated_at', 'last_used_at',
      ]);
      assert.deepEqual(columns('dilemmas'), [
        'id', 'scope', 'kind', 'summary', 'option_a', 'option_b', 'related_principle_ids', 'source_experience_ids',
        'status', 'resolution', 'surfaced_count', 'created_at', 'resolved_at',
      ]);
      assert.deepEqual(columns('iron_rules'), ['id', 'scope', 'content', 'active', 'created_at', 'updated_at']);
    } finally {
      raw.close();
    }
  });
});

test('中文只用汉字就能找回：三字窗口走 FTS，两字短词走 LIKE，技术词整词保护，无关查询不硬凑', async () => {
  await withTempDb((store) => {
    sampleExperiences(store);

    // 查询切分：连续汉字串取三字窗口；不足三字的汉字走 LIKE；英文命令整词加引号
    const plan = buildQueryPlan('怎么删软链接的目录 npm');
    const han = plan.segments.find((s) => s.kind === 'han');
    assert.equal(han?.text, '怎么删软链接的目录');
    assert.deepEqual(han?.phrases, ['怎么删', '么删软', '删软链', '软链接', '链接的', '接的目', '的目录']);
    assert.ok(plan.ftsExpr?.includes('"软链接"'));
    assert.ok(plan.ftsExpr?.includes('"npm"'), '三字符以上的英文词整词进 FTS');
    assert.deepEqual(plan.likeTerms, []);
    assert.equal(buildQueryPlan('软链').ftsExpr, null);
    assert.deepEqual(buildQueryPlan('软链').likeTerms, ['软链']);
    assert.equal(buildQueryPlan('ENOENT 报错').ftsExpr, '"ENOENT"');
    assert.deepEqual(buildQueryPlan('ENOENT 报错').likeTerms, ['报错']);

    // 三字窗口：换一种说法也能靠「软链接」找回两条相关经历，排在前面的分数更高
    const soft = searchExperiences(store, { scope: 'personal', query: '怎么删软链接的目录' });
    assert.deepEqual(new Set(soft.map((h) => h.experience.id)), new Set([1, 2]));
    assert.ok(soft[0]!.score >= soft[1]!.score);

    // 两字短词：LIKE 兜底
    const short = searchExperiences(store, { scope: 'personal', query: '目录 软链' });
    assert.deepEqual(new Set(short.map((h) => h.experience.id)), new Set([1, 2]));

    // 技术词：大小写不敏感、整词不漏
    const tech = searchExperiences(store, { scope: 'personal', query: '报错 enoent' });
    assert.deepEqual(tech.map((h) => h.experience.id), [2]);
    const command = searchExperiences(store, { scope: 'personal', query: 'npm run build' });
    assert.deepEqual(command.map((h) => h.experience.id), [3]);
    assert.equal(command[0]!.score, 1);

    // 反例：没有的字面不硬凑（「符号链接」不是「软链接」，M1 没有语义向量）
    assert.deepEqual(searchExperiences(store, { scope: 'personal', query: '符号链接是什么' }), []);
    assert.deepEqual(searchExperiences(store, { scope: 'personal', query: '今天天气怎么样' }), []);
    assert.deepEqual(searchExperiences(store, { scope: 'personal', query: '!!!' }), []);
  });
});

test('FTS 三个触发器：另开 SQLite 做维护 UPDATE / DELETE 后索引同步；业务侧的元数据更新不动正文和索引', async () => {
  await withTempDb((store, file) => {
    sampleExperiences(store);

    // 业务接口只能改元数据
    store.markExperiencesProcessed([2], T0);
    store.recordExperienceHit(2, T0);
    const row = store.getExperience(2)!;
    assert.equal(row.summary, '遇到 ENOENT 报错先检查路径是不是软链接');
    assert.equal(row.hitCount, 1);
    assert.equal(row.processedAt, T0);
    assert.deepEqual(searchExperiences(store, { scope: 'personal', query: 'ENOENT' }).map((h) => h.experience.id), [2]);

    // 维护路径：第二个连接改正文，UPDATE 触发器把旧词删掉、新词补上
    const maintenance = new DatabaseSync(file);
    try {
      maintenance.exec('PRAGMA busy_timeout = 5000');
      maintenance.prepare('UPDATE experiences SET summary = ? WHERE id = ?').run('改成：先看是不是符号链接再动手', 2);
      assert.deepEqual(searchExperiences(store, { scope: 'personal', query: 'ENOENT' }), []);
      assert.deepEqual(searchExperiences(store, { scope: 'personal', query: '符号链接' }).map((h) => h.experience.id), [2]);

      // DELETE 触发器：删掉后索引里也不再有
      maintenance.prepare('DELETE FROM experiences WHERE id = ?').run(4);
      assert.deepEqual(searchExperiences(store, { scope: 'personal', query: '汇报先说结论' }), []);
      assert.deepEqual(searchExperiences(store, { scope: 'personal', query: '软链接' }).map((h) => h.experience.id), [1]);
      const check = maintenance.prepare("INSERT INTO experiences_fts(experiences_fts, rank) VALUES('integrity-check', 1)").get();
      assert.equal(check, undefined);
    } finally {
      maintenance.close();
    }
  });
});

test('同一个库按作用域隔离：经历、原则、分歧、铁律各归各，检索和列表不串读', async () => {
  await withTempDb((store) => {
    store.addExperience({ scope: 'personal', kind: 'fact', summary: '个人电脑上默认用 Node 24 跑所有脚本', source: 'manual', createdAt: T0 });
    store.addExperience({ scope: 'project:demo', kind: 'fact', summary: 'demo 项目默认用 Node 24 跑所有脚本', source: 'manual', createdAt: T0 });
    store.addExperience({ scope: 'role:reviewer', kind: 'fact', summary: '评审角色默认用 Node 24 跑所有脚本', source: 'manual', createdAt: T0 });
    store.insertPrinciple({ scope: 'project:demo', triggerWhen: '当你准备提交 demo 项目时', rule: '先跑 npm test 再提交。', now: T0 });
    store.addIronRule({ scope: 'role:reviewer', content: '评审时不许改别人的代码。', now: T0 });
    store.insertDilemma({ scope: 'project:demo', kind: 'value_conflict', summary: '到底要不要先跑测试', optionA: '要', optionB: '不要', now: T0 });

    assert.deepEqual(searchExperiences(store, { scope: 'personal', query: 'Node 24 跑脚本' }).map((h) => h.experience.id), [1]);
    assert.deepEqual(searchExperiences(store, { scope: 'project:demo', query: 'Node 24 跑脚本' }).map((h) => h.experience.id), [2]);
    assert.deepEqual(searchExperiences(store, { scope: 'role:reviewer', query: 'Node 24 跑脚本' }).map((h) => h.experience.id), [3]);
    assert.deepEqual(store.listPrinciples('personal'), []);
    assert.equal(store.listPrinciples('project:demo').length, 1);
    assert.deepEqual(store.listIronRules('personal'), []);
    assert.equal(store.listIronRules('role:reviewer').length, 1);
    assert.deepEqual(store.listDilemmas('personal'), []);
    assert.equal(store.listDilemmas('project:demo').length, 1);
    assert.equal(store.countPendingExperiences('project:demo'), 1);
  });
});

test('经历正文只追加：没有修改入口，非法作用域和空总结直接拒绝', async () => {
  await withTempDb((store) => {
    assert.throws(() => store.addExperience({ scope: 'team', kind: 'fact', summary: '随便写一句', source: 'manual' }), /作用域写法不正确/);
    assert.throws(() => store.addExperience({ scope: 'personal', kind: 'fact', summary: '   ', source: 'manual' }), /不能为空/);
    assert.throws(() => store.addExperience({ scope: 'personal', kind: 'nope' as never, summary: '随便写一句', source: 'manual' }));
    assert.throws(() => openStore(''), /显式给出文件路径/);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store)) as string[];
    assert.equal(methods.some((m) => /updateExperience|deleteExperience|editExperience/i.test(m)), false);
  });
});

test('铁律只有显式人工入口：新增、停用、重新启用，列表按作用域和生效状态过滤', async () => {
  await withTempDb((store) => {
    const rule = store.addIronRule({ scope: 'personal', content: '  没明说怎么处理就不许擅自动手。 ', now: T0 });
    assert.equal(rule.content, '没明说怎么处理就不许擅自动手。');
    assert.equal(rule.active, true);
    assert.throws(() => store.addIronRule({ scope: 'personal', content: '   ', now: T0 }), /不能为空/);
    const disabled = store.setIronRuleActive(rule.id, false, T0);
    assert.equal(disabled.active, false);
    assert.deepEqual(store.listIronRules('personal'), []);
    assert.equal(store.listIronRules('personal', { activeOnly: false }).length, 1);
    assert.equal(store.setIronRuleActive(rule.id, true, T0).active, true);
    assert.equal(store.listIronRules('personal').length, 1);
    assert.throws(() => store.setIronRuleActive(999, false, T0), /找不到/);
  });
});

test('原则字面召回：只找生效原则，退役后不再出现；容量报告按作用域档位算', async () => {
  await withTempDb((store) => {
    const active = store.insertPrinciple({ scope: 'role:reviewer', triggerWhen: '当你准备删除一个目录时', rule: '先 ls -la 看一眼它是不是软链接，确认后再删。', now: T0 });
    const stale = store.insertPrinciple({ scope: 'role:reviewer', triggerWhen: '当你写评审意见时', rule: '先夸再批，语气要委婉。', now: T0 });
    const hits = searchPrinciples(store, { scope: 'role:reviewer', query: '删除目录 软链接' });
    assert.deepEqual(hits.map((h) => h.principle.id), [active.id]);
    store.setPrincipleStatus(stale.id, 'retired', { retireReason: '用户说现在不用这套了', now: T0 });
    assert.deepEqual(searchPrinciples(store, { scope: 'role:reviewer', query: '评审意见 委婉' }), []);
    const retired = store.getPrinciple(stale.id);
    assert.equal(retired.status, 'retired');
    assert.equal(retired.retireReason, '用户说现在不用这套了');
    assert.equal(store.listPrinciples('role:reviewer', { status: 'all' }).length, 2);

    const capacity = store.capacity('role:reviewer');
    assert.equal(capacity.activeCount, 1);
    assert.equal(capacity.hardCount, 40);
    assert.equal(capacity.maxCore, 8);
    assert.equal(capacity.nearLimit, false);
    assert.equal(store.capacity('personal').hardCount, 120);
  });
});

test('事务：中途出错整体回滚，库里不留半截结果', async () => {
  await withTempDb((store) => {
    assert.throws(() =>
      store.transaction(() => {
        store.addIronRule({ scope: 'personal', content: '这条不该留下', now: T0 });
        throw new Error('模拟中途失败');
      }),
    );
    assert.deepEqual(store.listIronRules('personal', { activeOnly: false }), []);
    assert.throws(() => store.transaction(() => store.transaction(() => undefined)), /不能在事务里再开事务/);
  });
});

test(':memory: 也能开（测试和一次性场景用），不上 WAL 但外键照开', async () => {
  const store = openStore(':memory:');
  try {
    assert.equal(store.pragma('journal_mode'), 'memory');
    assert.equal(store.pragma('foreign_keys'), 1);
    store.addExperience({ scope: 'personal', kind: 'fact', summary: '临时库里的中文经历也能被找到', source: 'manual', createdAt: T0 });
    assert.equal(searchExperiences(store, { scope: 'personal', query: '中文经历' }).length, 1);
  } finally {
    store.close();
  }
});
