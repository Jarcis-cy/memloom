import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, Store } from '../src/core/store.js';
import type { DuplicateJudge } from '../src/core/types.js';
import { MEMBER, sha256Hex, type ParsedArchive } from '../src/portable/format.js';
import { exportArchive } from '../src/portable/export.js';
import { importArchive, readArchive } from '../src/portable/import.js';
import { gzipBytes, gunzipBytes, packTar, unpackTar } from '../src/portable/tar.js';
import { resolveContext } from '../src/app/context.js';
import { Memloom } from '../src/app/ops.js';

/**
 * 导出 / 导入往返（只用临时文件库和合成中文样本，不碰任何真实记忆）：
 * 字段、状态、血缘、统计不串编号；按内容指纹去重；merge 不覆盖本地较新文本、不改本地铁律；
 * replace 只软退役选定作用域；事务失败整体回滚；读入阶段先校验再写；.team 只带纯文本、不覆写手写文件。
 */

const T0 = '2026-11-27T10:00:00.000Z';
const T1 = '2026-11-27T11:00:00.000Z';
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'memloom-portable-'));
}

function seedSource(store: Store, scope = 'personal'): void {
  store.addIronRule({ scope, content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: T0 });
  const second = store.addIronRule({ scope, content: '周末不处理工作消息。', now: T0 });
  store.setIronRuleActive(second.id, false, T1);
  const e1 = store.addExperience({ scope, kind: 'correction', summary: '删目录之前先 ls -la 看一眼是不是软链接，确认后再删。', evidence: `用户说：我的密钥是 ${SECRET}，另外 npm_TokenABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 也别外传`, source: 'correction', createdAt: T0, occurredAt: T0 });
  const e2 = store.addExperience({ scope, kind: 'preference', summary: '用户要求汇报先说结论，再说细节，不要一上来铺陈过程。', source: 'manual', createdAt: T0, occurredAt: T0 });
  const e3 = store.addExperience({ scope, kind: 'pitfall', summary: '改完代码没跑 npm run build 就测试，结果跑的是旧产物。', source: 'review', createdAt: T1, occurredAt: T1 });
  store.restoreExperienceCounters(e1.id, { hitCount: 4, lastHitAt: T1, processedAt: T0 });
  store.restoreExperienceCounters(e2.id, { hitCount: 0, lastHitAt: null, processedAt: T0 });
  const p1 = store.insertPrinciple({ scope, triggerWhen: '当你准备删除一个目录的时候', rule: '先看看它是不是软链接再删', rationale: '第一次提炼', sourceExperienceIds: [e1.id], now: T0 });
  store.restorePrincipleMeta(p1.id, { rationale: null, status: 'merged', isCore: false, strength: 1, appliedCount: 0, violatedCount: 0, retireReason: '已上位抽象合并为原则 #2', createdAt: T0, updatedAt: T1, lastUsedAt: null });
  const p2 = store.insertPrinciple({ scope, triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf，防止顺着链接误删目标目录', rationale: '两条经历合出来的', isCore: true, parentIds: [p1.id], sourceExperienceIds: [e1.id, e2.id], now: T1 });
  store.restorePrincipleMeta(p2.id, { rationale: null, status: 'active', isCore: true, strength: 1.5, appliedCount: 3, violatedCount: 1, retireReason: null, createdAt: T1, updatedAt: T1, lastUsedAt: T1 });
  const p3 = store.insertPrinciple({ scope, triggerWhen: '当你准备汇报工作结果的时候', rule: '先说结论，再说细节，不要一上来铺陈过程', sourceExperienceIds: [e2.id], now: T1 });
  store.restorePrincipleMeta(p3.id, { rationale: null, status: 'active', isCore: false, strength: 1, appliedCount: 0, violatedCount: 0, retireReason: null, createdAt: T1, updatedAt: T1, lastUsedAt: null });
  const p4 = store.insertPrinciple({ scope, triggerWhen: '当你在旧项目里配置代理的时候', rule: '用旧的代理脚本就行', sourceExperienceIds: [e3.id], now: T1 });
  store.restorePrincipleMeta(p4.id, { rationale: null, status: 'retired', isCore: false, strength: 0.5, appliedCount: 0, violatedCount: 0, retireReason: '旧项目已经不用了', createdAt: T1, updatedAt: T1, lastUsedAt: null });
}

function membersOf(archivePath: string): Map<string, Buffer> {
  return new Map(unpackTar(gunzipBytes(readFileSync(archivePath), 64 * 1024 * 1024)).map((m) => [m.path, Buffer.from(m.data)] as const));
}

/** 改过成员后重新打成包；fixHash 为 false 时刻意留下旧的哈希，用来测哈希校验。 */
function repack(root: string, members: Map<string, Buffer>, name: string): string {
  const out = join(root, name);
  const files = [...members.entries()].map(([path, data]) => ({ path, data, mtime: new Date(T0) }));
  writeFileSync(out, gzipBytes(packTar(files)));
  return out;
}

function withManifest(members: Map<string, Buffer>, edit: (manifest: Record<string, any>) => void): void {
  const manifest = JSON.parse(members.get(MEMBER.manifest)!.toString('utf8')) as Record<string, any>;
  edit(manifest);
  members.set(MEMBER.manifest, Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, 'utf8'));
}

function setMember(members: Map<string, Buffer>, path: string, data: string, fixHash = true): void {
  members.set(path, Buffer.from(data, 'utf8'));
  if (fixHash) withManifest(members, (m) => void (m.sha256[path] = sha256Hex(Buffer.from(data, 'utf8'))));
}

test('导出：成员齐全、manifest 哈希对得上、只有纯文本、记录里的常见凭据被掩蔽并登记', () => {
  const root = temp();
  try {
    const store = openStore(join(root, 'a.db'));
    seedSource(store);
    const out = join(root, 'a.tar.gz');
    const report = exportArchive({ store, scope: 'personal', outPath: out, now: () => T1 });
    assert.equal(report.counts.iron_rules, 2);
    assert.equal(report.counts.principles, 4);
    assert.equal(report.counts.experiences, 3);
    assert.deepEqual(report.members, ['manifest.json', 'iron_rules.json', 'principles.json', 'experiences.jsonl', 'readable/STANDING.md', 'readable/PRINCIPLES.md']);
    const kinds = report.masked.map((m) => `${m.member}:${m.kind}`);
    assert.ok(kinds.includes('experiences.jsonl:OpenAI 风格密钥'), kinds.join(','));
    assert.ok(kinds.includes('experiences.jsonl:npm 令牌'), kinds.join(','));

    const parsed = readArchive(out);
    assert.equal(parsed.experiences.length, 3);
    assert.equal(parsed.principles.length, 4);
    assert.ok(parsed.experiences[0]?.evidence?.includes('[已掩蔽:OpenAI 风格密钥]'));
    assert.ok(!JSON.stringify(parsed).includes(SECRET), '凭据明文不能出现在归档任何地方');
    assert.ok(!JSON.stringify(parsed).includes('npm_TokenABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'npm 令牌明文不能出现');
    const principles = JSON.parse(membersOf(out).get(MEMBER.principles)!.toString('utf8')) as Array<Record<string, unknown>>;
    assert.ok(principles.every((p) => !('embedding' in p) && !('embedding_model' in p)), '向量列不进包');
    const bytes = readFileSync(out);
    assert.ok(!bytes.includes(Buffer.from('SQLite format 3')), '数据库文件不进包');
    assert.throws(() => exportArchive({ store, scope: 'personal', outPath: out, now: () => T1 }), /已经存在，不覆盖/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('往返：导入另一个库后编号按内容翻译，血缘、证据、统计、状态、铁律启用状态全部保留且不串号', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    seedSource(a);
    const out = join(root, 'a.tar.gz');
    exportArchive({ store: a, scope: 'personal', outPath: out, now: () => T1 });
    a.close();

    // 目标库先有自己的东西，让编号整体错位：铁律 1 条、经历 2 条、原则 1 条
    const b = openStore(join(root, 'b.db'));
    b.addIronRule({ scope: 'personal', content: '本地已有的铁律。', now: T0 });
    b.addExperience({ scope: 'personal', kind: 'fact', summary: '本机 shell 带 NODE_ENV=production。', source: 'manual', createdAt: T0 });
    b.addExperience({ scope: 'personal', kind: 'fact', summary: '本机是 Linux。', source: 'manual', createdAt: T0 });
    const local = b.insertPrinciple({ scope: 'personal', triggerWhen: '当你在本机装依赖的时候', rule: '装 devDependencies 必须加 --include=dev', now: T0 });
    assert.equal(local.id, 1);

    const report = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge', now: () => '2026-11-27T12:00:00.000Z' });
    assert.equal(report.experiences.added, 3);
    assert.equal(report.iron_rules.added, 2);
    assert.equal(report.principles.added, 4);
    assert.equal(report.principles.conflicts.length, 0);

    // 铁律：本地那条没动；归档两条进来，启用状态保留
    const rules = b.listIronRules('personal', { activeOnly: false });
    assert.deepEqual(rules.map((r) => [r.id, r.active]), [[1, true], [2, true], [3, false]]);
    assert.equal(rules[2]?.content, '周末不处理工作消息。');

    // 经历：本地两条编号 1、2；归档的 exp:1/2/3 → 3/4/5；计数和处理时间保留
    assert.equal(b.getExperience(3)?.hitCount, 4);
    assert.equal(b.getExperience(3)?.lastHitAt, T1);
    assert.equal(b.getExperience(3)?.source, 'import');
    assert.equal(b.getExperience(3)?.evidence?.includes('[已掩蔽:OpenAI 风格密钥]'), true);
    assert.equal(b.getExperience(5)?.processedAt, null, '源库里待处理的，导入后仍是待处理');

    // 原则：本地 #1 没动；p:1..p:4 → #2..#5；p:2 的 parents [p:1] → [2]，sources [exp:1, exp:2] → [3, 4]
    assert.equal(b.getPrinciple(1).rule, '装 devDependencies 必须加 --include=dev');
    const p2 = b.getPrinciple(3);
    assert.equal(p2.triggerWhen, '当你准备递归删除一个目录的时候');
    assert.deepEqual(p2.parentIds, [2]);
    assert.deepEqual(p2.sourceExperienceIds, [3, 4]);
    assert.equal(p2.status, 'active');
    assert.equal(p2.isCore, true);
    assert.equal(p2.strength, 1.5);
    assert.equal(p2.appliedCount, 3);
    assert.equal(p2.violatedCount, 1);
    assert.equal(p2.lastUsedAt, T1);
    assert.equal(b.getPrinciple(2).status, 'merged');
    assert.equal(b.getPrinciple(2).retireReason, '已上位抽象合并为原则 #3', '说明文字里的「原则 #2」按本次内容翻译成本地编号 #3，不留下指向同号别人的裸编号');
    assert.equal(b.getPrinciple(5).status, 'retired');
    assert.equal(b.getPrinciple(5).retireReason, '旧项目已经不用了');
    // 绝不留下指向错误内容的裸编号：每条导入原则的来源都能在目标库里找到对应的经历
    for (const id of [2, 3, 4, 5]) for (const expId of b.getPrinciple(id).sourceExperienceIds) assert.ok(b.getExperience(expId), `原则 #${id} 的来源经历 #${expId} 存在`);
    b.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merge：不覆盖本地较新文本、不改本地铁律；字面接近或状态不同的只报告冲突不导入；重复导入无重复', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    seedSource(a);
    const out = join(root, 'a.tar.gz');
    exportArchive({ store: a, scope: 'personal', outPath: out, now: () => T1 });
    a.close();

    const b = openStore(join(root, 'b.db'));
    // 同一条铁律，但本地已停用：导入后必须还是停用
    const rule = b.addIronRule({ scope: 'personal', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: T0 });
    b.setIronRuleActive(rule.id, false, T1);
    // 和归档 p:3 字面很接近、但本地文本更新（多了一句）
    const newer = b.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备汇报工作结果的时候', rule: '先说结论，再说细节，不要一上来铺陈过程，并且要用大白话', sourceExperienceIds: [], now: T1 });
    // 和归档 p:4 文字一样，但本地是生效的（归档里是已退役）
    const activeCopy = b.insertPrinciple({ scope: 'personal', triggerWhen: '当你在旧项目里配置代理的时候', rule: '用旧的代理脚本就行', now: T1 });

    const report = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge' });
    assert.equal(report.iron_rules.added, 1);
    assert.equal(report.iron_rules.skipped, 1);
    assert.equal(b.getIronRule(rule.id).active, false, '本地铁律的启用状态没被改');
    assert.deepEqual(report.iron_rules.state_conflicts, [{ ref: 'iron:1', local_id: rule.id, archived_active: true, local_active: false }], '启停状态不同要写进回执，不能悄悄重新启用');
    assert.equal(report.principles.added, 2);
    assert.equal(
      report.principles.conflicts.map((c) => c.ref).sort().join(','),
      'p:3,p:4',
    );
    assert.match(report.principles.conflicts.find((c) => c.ref === 'p:3')?.reason ?? '', /字面很接近/);
    assert.match(report.principles.conflicts.find((c) => c.ref === 'p:4')?.reason ?? '', /状态不同/);
    assert.equal(b.getPrinciple(newer.id).rule, '先说结论，再说细节，不要一上来铺陈过程，并且要用大白话', '本地较新的文本原样保留');
    assert.equal(b.getPrinciple(activeCopy.id).status, 'active', '本地状态以本地为准');
    assert.equal(b.listPrinciples('personal', { status: 'all' }).length, 4);

    const again = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge' });
    assert.equal(again.experiences.added + again.iron_rules.added + again.principles.added, 0, '重复导入一个字节都不新增');
    assert.equal(again.experiences.skipped, 3);
    assert.equal(again.principles.merged, 2);
    b.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replace：只把选定作用域里包里没有的生效原则软退役留底；别的作用域和铁律不动', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    seedSource(a);
    const out = join(root, 'a.tar.gz');
    exportArchive({ store: a, scope: 'personal', outPath: out, now: () => T1 });
    a.close();
    const b = openStore(join(root, 'b.db'));
    const extra = b.insertPrinciple({ scope: 'personal', triggerWhen: '当你提交代码的时候', rule: '提交前先跑一遍测试', now: T0 });
    const other = b.insertPrinciple({ scope: 'project:other', triggerWhen: '当你在别的项目里的时候', rule: '别的作用域的原则', now: T0 });
    const rule = b.addIronRule({ scope: 'personal', content: '本地铁律要留着。', now: T0 });
    const report = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'replace', now: () => '2026-11-27T12:00:00.000Z' });
    assert.equal(report.principles.retired_by_replace, 1);
    assert.equal(report.principles.added, 4);
    const retired = b.getPrinciple(extra.id);
    assert.equal(retired.status, 'retired');
    assert.match(retired.retireReason ?? '', /导入替换.*replace/);
    assert.equal(b.getPrinciple(other.id).status, 'active', '别的作用域不动');
    assert.equal(b.getIronRule(rule.id).active, true, '铁律不动');
    assert.equal(b.listIronRules('personal', { activeOnly: false }).length, 3, '归档里的铁律照常补进来，本地的没删没停');
    b.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FaultyStore extends Store {
  failOnCall = 0;
  private calls = 0;
  override insertPrinciple(input: Parameters<Store['insertPrinciple']>[0]): ReturnType<Store['insertPrinciple']> {
    this.calls += 1;
    if (this.calls === this.failOnCall) throw new Error('模拟：写第二张表时磁盘满了');
    return super.insertPrinciple(input);
  }
}

test('事务失败整体回滚：目标库一个字节不变，.team 文件一个不写', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    seedSource(a);
    const project = join(root, 'proj');
    mkdirSync(join(project, '.team'), { recursive: true });
    writeFileSync(join(project, '.team', 'TEAM.md'), '# 班底\n');
    const out = join(root, 'a.tar.gz');
    exportArchive({ store: a, scope: 'personal', outPath: out, projectDir: project, now: () => T1 });
    a.close();
    const b = new FaultyStore(join(root, 'b.db'));
    b.failOnCall = 2;
    const targetProject = join(root, 'target');
    mkdirSync(join(targetProject, '.team'), { recursive: true });
    await assert.rejects(
      () => importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge', projectDir: targetProject }),
      /磁盘满了/,
    );
    assert.equal(b.listExperiences('personal').length, 0, '经历没有留下半截');
    assert.equal(b.listPrinciples('personal', { status: 'all' }).length, 0, '原则没有留下半截');
    assert.equal(b.listIronRules('personal', { activeOnly: false }).length, 0, '铁律没有留下半截');
    assert.equal(existsSync(join(targetProject, '.team', 'TEAM.md')), false, '数据库没提交，.team 文件也不写');
    b.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('读入先校验：作用域不匹配、版本不对、哈希被改、成员缺失、多出成员、team 里藏秘密文件、数量对不上、包内重复 —— 一个字节不写', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    seedSource(a);
    const out = join(root, 'a.tar.gz');
    exportArchive({ store: a, scope: 'personal', outPath: out, now: () => T1 });
    a.close();
    const fresh = (): Store => openStore(join(root, `t${Math.random().toString(36).slice(2)}.db`));
    const expectRejected = async (path: string, pattern: RegExp, label: string): Promise<void> => {
      const store = fresh();
      await assert.rejects(() => importArchive({ store, scope: 'personal', archivePath: path, mode: 'merge' }), pattern, label);
      assert.equal(store.listExperiences('personal').length + store.listPrinciples('personal', { status: 'all' }).length + store.listIronRules('personal', { activeOnly: false }).length, 0, `${label}：一个字节不写`);
      store.close();
    };
    const base = membersOf(out);
    assert.equal(readArchive(out).manifest.scope, 'personal');

    const wrongScope = membersOf(out);
    withManifest(wrongScope, (m) => {
      m.scope = 'project:other';
      m.project_id = 'other';
    });
    await expectRejected(repack(root, wrongScope, 'scope.tar.gz'), /作用域/, '作用域不匹配');

    const wrongVersion = membersOf(out);
    withManifest(wrongVersion, (m) => void (m.schema_version = 2));
    await expectRejected(repack(root, wrongVersion, 'version.tar.gz'), /schema_version/, '版本不对');

    const tampered = membersOf(out);
    setMember(tampered, MEMBER.principles, `${tampered.get(MEMBER.principles)!.toString('utf8')} `, false);
    await expectRejected(repack(root, tampered, 'tampered.tar.gz'), /SHA-256/, '哈希被改');

    const missing = membersOf(out);
    missing.delete(MEMBER.standing);
    withManifest(missing, (m) => void delete m.sha256[MEMBER.standing]);
    await expectRejected(repack(root, missing, 'missing.tar.gz'), /缺少成员/, '成员缺失');

    const extra = membersOf(out);
    setMember(extra, 'extra.txt', '多出来的东西');
    await expectRejected(repack(root, extra, 'extra.tar.gz'), /不该出现的成员/, '多出不认识的成员');

    const hidden = membersOf(out);
    setMember(hidden, 'team/.env', 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456');
    await expectRejected(repack(root, hidden, 'hidden.tar.gz'), /不该出现/, 'team 里藏秘密文件');

    const wrongCounts = membersOf(out);
    withManifest(wrongCounts, (m) => void (m.counts.principles = 5));
    await expectRejected(repack(root, wrongCounts, 'counts.tar.gz'), /counts.*对不上/, '数量对不上');

    const duplicated = membersOf(out);
    const principles = JSON.parse(duplicated.get(MEMBER.principles)!.toString('utf8')) as unknown[];
    principles.push(principles[0]);
    setMember(duplicated, MEMBER.principles, JSON.stringify(principles));
    withManifest(duplicated, (m) => void (m.counts.principles = 5));
    await expectRejected(repack(root, duplicated, 'dup.tar.gz'), /出现了两次/, '包内重复');

    const badField = membersOf(out);
    const raw = JSON.parse(badField.get(MEMBER.principles)!.toString('utf8')) as Array<Record<string, unknown>>;
    raw[0]!.status = 'deleted';
    setMember(badField, MEMBER.principles, JSON.stringify(raw));
    await expectRejected(repack(root, badField, 'field.tar.gz'), /status.*只能是/, '记录字段不合法');

    const parsed: ParsedArchive = readArchive(out);
    assert.equal(parsed.principles[0]?.status, 'merged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('项目域：.team 只带纯文本（秘密文件名、数据库、锁、符号链接、非文本都排除并说明）；导入只写不存在的，不覆写手写文件', async () => {
  const root = temp();
  try {
    const manifest = JSON.stringify({ schema_version: 1, project_id: 'proj-m3-1', project_name: '演示项目', domain: 'custom', created_at: T0 }, null, 2);
    const p1 = join(root, 'p1');
    const team1 = join(p1, '.team');
    mkdirSync(join(team1, 'roles'), { recursive: true });
    mkdirSync(join(team1, 'inbox', '2026-11', 'a'), { recursive: true });
    writeFileSync(join(team1, 'manifest.json'), manifest);
    writeFileSync(join(team1, 'TEAM.md'), '# 班底\n');
    writeFileSync(join(team1, 'BRIEF.md'), '# 速览\n');
    writeFileSync(join(team1, 'roles', 'reviewer.md'), '# 审查员\n');
    writeFileSync(join(team1, 'inbox', '2026-11', 'a', 'ISSUE.md'), '# 问题\n');
    writeFileSync(join(team1, 'notes.txt'), `备忘：部署用的令牌是 ${SECRET}\n`);
    writeFileSync(join(team1, '.env'), 'SECRET=x');
    writeFileSync(join(team1, '.crew.lock'), '');
    writeFileSync(join(team1, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    mkdirSync(join(team1, 'keys'));
    writeFileSync(join(team1, 'keys', 'secret.pem'), '-----BEGIN PRIVATE KEY-----\n');
    symlinkSync('/etc/hosts', join(team1, 'link.md'));
    const store = openStore(join(team1, '.mind.db'));
    seedSource(store, 'project:proj-m3-1');
    const out = join(root, 'proj.tar.gz');
    const report = exportArchive({ store, scope: 'project:proj-m3-1', outPath: out, projectDir: p1, now: () => T1 });
    store.close();
    assert.equal(report.counts.team_files, 6);
    const parsed = readArchive(out);
    assert.deepEqual(
      parsed.teamFiles.map((f) => f.path).sort(),
      ['BRIEF.md', 'TEAM.md', 'inbox/2026-11/a/ISSUE.md', 'manifest.json', 'notes.txt', 'roles/reviewer.md'].sort(),
    );
    const excluded = Object.fromEntries(report.excluded.map((e) => [e.path, e.reason]));
    assert.match(excluded['.mind.db'] ?? '', /像凭据、数据库、锁或模型/);
    assert.match(excluded['.env'] ?? '', /像凭据/);
    assert.match(excluded['.crew.lock'] ?? '', /锁/);
    assert.match(excluded['link.md'] ?? '', /符号链接/);
    assert.match(excluded['img.png'] ?? '', /不是纯文本/);
    assert.match(excluded['keys/secret.pem'] ?? '', /凭据/);
    assert.ok(parsed.teamFiles.find((f) => f.path === 'notes.txt')?.text.includes('[已掩蔽:OpenAI 风格密钥]'));
    assert.ok(report.masked.some((m) => m.member === 'team/notes.txt'));
    assert.throws(() => exportArchive({ store: openStore(join(team1, '.mind.db')), scope: 'project:proj-m3-1', outPath: join(team1, 'x.tar.gz'), projectDir: p1 }), /不能放进 `.team\/`/);

    // 导入到另一个同项目目录：manifest 一致、reviewer.md 一致、TEAM.md 是人手写的且不同 → 不覆写
    const p2 = join(root, 'p2');
    const team2 = join(p2, '.team');
    mkdirSync(join(team2, 'roles'), { recursive: true });
    writeFileSync(join(team2, 'manifest.json'), manifest);
    writeFileSync(join(team2, 'TEAM.md'), '# 这份是人手写的班底\n');
    writeFileSync(join(team2, 'roles', 'reviewer.md'), '# 审查员\n');
    const b = openStore(join(team2, '.mind.db'));
    const imported = await importArchive({ store: b, scope: 'project:proj-m3-1', archivePath: out, mode: 'merge', projectDir: p2, projectId: 'proj-m3-1' });
    assert.deepEqual(imported.team.written, ['BRIEF.md', 'inbox/2026-11/a/ISSUE.md', 'notes.txt'].sort());
    assert.equal(imported.team.identical, 2);
    assert.deepEqual(imported.team.conflicts.map((c) => c.path), ['TEAM.md']);
    assert.equal(readFileSync(join(team2, 'TEAM.md'), 'utf8'), '# 这份是人手写的班底\n');
    assert.equal(b.listPrinciples('project:proj-m3-1', { status: 'active' }).length, 2);
    // 项目包不能导进个人库；个人包也不能导进项目库
    await assert.rejects(() => importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge' }), /作用域/);
    await assert.rejects(() => importArchive({ store: b, scope: 'project:proj-m3-1', archivePath: join(root, 'nope.tar.gz'), mode: 'merge', projectId: 'proj-m3-1' }), /找不到归档文件/);
    b.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('可注入的语义判断：字面不同但意思相同的归档原则合并到本地那条，不新增近似的；判断不可信就整包不导', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    const e = a.addExperience({ scope: 'personal', kind: 'preference', summary: '用户说写汇报时结论要放在最前面。', source: 'manual', createdAt: T0 });
    a.insertPrinciple({ scope: 'personal', triggerWhen: '当你要写工作汇报的时候', rule: '结论放在最前面，过程放在后面说', sourceExperienceIds: [e.id], now: T0 });
    const out = join(root, 'a.tar.gz');
    exportArchive({ store: a, scope: 'personal', outPath: out, now: () => T1 });
    a.close();
    const b = openStore(join(root, 'b.db'));
    const local = b.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备汇报工作结果的时候', rule: '先说结论，再说细节，不要一上来铺陈过程', now: T0 });
    const honest: DuplicateJudge = {
      id: 'test-judge',
      findDuplicate: async (candidate, existing) => (candidate.trigger_when === '当你要写工作汇报的时候' && existing.some((p) => p.id === local.id) ? local.id : null),
    };
    const report = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge', judge: honest });
    assert.equal(report.principles.merged_semantic, 1);
    assert.equal(report.principles.added, 0);
    assert.equal(b.listPrinciples('personal', { status: 'all' }).length, 1);
    assert.deepEqual(b.getPrinciple(local.id).sourceExperienceIds, [1], '归档里的来源经历并进了本地那条');
    const withoutJudge = await importArchive({ store: openStore(join(root, 'c.db')), scope: 'personal', archivePath: out, mode: 'merge' });
    assert.equal(withoutJudge.principles.added, 1, '不给语义判断时按字面处理：字面不接近，照常新增');
    const liar: DuplicateJudge = { id: 'liar', findDuplicate: async () => 999 };
    const c = openStore(join(root, 'd.db'));
    await assert.rejects(() => importArchive({ store: c, scope: 'personal', archivePath: out, mode: 'merge', judge: liar }), /判定不可信/);
    assert.equal(c.listPrinciples('personal', { status: 'all' }).length, 0);
    assert.equal(c.listExperiences('personal').length, 0, '判断不可信时整包不导，经历也不留');
    b.close();
    c.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同文不重复编号：同总结不同引文的经历、同文不同启停的铁律、同文的生效版和历史版原则 —— 读端放行、导入保留区分、血缘不自指、二次导入零新增', async () => {
  const root = temp();
  try {
    const a = openStore(join(root, 'a.db'));
    // 两条经历总结一样、引文 / 类别 / 会话 / 时间不一样：是两条真实证据
    const e1 = a.addExperience({ scope: 'personal', kind: 'correction', summary: '删目录之前先看一眼是不是软链接。', evidence: '不对，先看是不是软链接', source: 'correction', sourceSession: 's1', createdAt: T0, occurredAt: T0 });
    const e2 = a.addExperience({ scope: 'personal', kind: 'preference', summary: '删目录之前先看一眼是不是软链接。', evidence: '以后都这样', source: 'manual', createdAt: T1, occurredAt: T1 });
    // 父台的最小复现顺序：加一条 → 停用 #1 → 再加同原文的 #2（源库 #1 停用、#2 生效）
    const firstRule = a.addIronRule({ scope: 'personal', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: T0 });
    a.setIronRuleActive(firstRule.id, false, T1);
    a.addIronRule({ scope: 'personal', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: T1 });
    // 同文的生效版 + 历史版（接替时文本没改），再加一条更早的同文退役版
    const older = a.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备删除一个目录的时候', rule: '先看一眼是不是软链接再删', now: '2026-11-26T10:00:00.000Z' });
    a.restorePrincipleMeta(older.id, { status: 'retired', isCore: false, rationale: null, strength: 0.5, appliedCount: 0, violatedCount: 0, retireReason: '最早的一版', createdAt: '2026-11-26T10:00:00.000Z', updatedAt: T0, lastUsedAt: null });
    const old = a.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备删除一个目录的时候', rule: '先看一眼是不是软链接再删', sourceExperienceIds: [e1.id], now: T0 });
    a.restorePrincipleMeta(old.id, { status: 'superseded', isCore: false, rationale: null, strength: 1, appliedCount: 2, violatedCount: 0, retireReason: '被原则 #3 替代', createdAt: T0, updatedAt: T1, lastUsedAt: null });
    const currentRow = a.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备删除一个目录的时候', rule: '先看一眼是不是软链接再删', parentIds: [old.id], sourceExperienceIds: [e1.id, e2.id], now: T1 });
    const out = join(root, 'a.tar.gz');
    const report = exportArchive({ store: a, scope: 'personal', outPath: out, now: () => T1 });
    assert.deepEqual([report.counts.iron_rules, report.counts.principles, report.counts.experiences], [2, 3, 2]);
    assert.equal(readArchive(out).principles.length, 3, '自己导出的包必须能读回：读端只拒重复编号，不拒同文的不同记录');
    a.close();

    const b = openStore(join(root, 'b.db'));
    const imported = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge' });
    assert.equal(imported.experiences.added, 2, '同总结不同引文的经历各自保留');
    assert.equal(imported.iron_rules.added, 2, '恢复到空库：同文的停用版和生效版各还原一条，原本生效的那条不能丢');
    assert.deepEqual(b.listIronRules('personal', { activeOnly: false }).map((r) => r.active).sort(), [false, true], '两种启停状态都读得回来（修前只剩停用的 #1）');
    assert.deepEqual(imported.iron_rules.state_conflicts, [], '空库里没有本地铁律可冲突，不该报假的状态冲突');
    assert.equal(imported.principles.added, 3);
    const rows = b.listPrinciples('personal', { status: 'all' });
    const active = rows.filter((p) => p.status === 'active');
    assert.equal(active.length, 1, '生效的只有一条');
    assert.deepEqual(active[0]?.parentIds, [rows.find((p) => p.status === 'superseded')?.id], '生效版的父亲是被替代的那条的历史版，不是自己');
    assert.notEqual(active[0]?.parentIds[0], active[0]?.id);
    assert.deepEqual(rows.map((p) => p.status).sort(), ['active', 'retired', 'superseded']);
    assert.equal(b.getPrinciple(active[0]!.id).retireReason, null);
    assert.equal(b.getPrinciple(rows.find((p) => p.status === 'superseded')!.id).retireReason, `被原则 #${active[0]!.id} 替代`, '说明文字里的编号翻成本地的');
    for (const p of rows) for (const expId of p.sourceExperienceIds) assert.notEqual(expId, undefined);

    const again = await importArchive({ store: b, scope: 'personal', archivePath: out, mode: 'merge' });
    assert.deepEqual([again.experiences.added, again.iron_rules.added, again.principles.added], [0, 0, 0], '同一个包第二次导入零新增');
    assert.equal(again.experiences.skipped, 2);
    assert.equal(again.principles.merged, 3);
    assert.deepEqual(again.iron_rules.state_conflicts, [], '重复导入：两种状态都在本地，各自对应同状态那条，没有假冲突');
    assert.deepEqual(b.listIronRules('personal', { activeOnly: false }).map((r) => r.active).sort(), [false, true], '重复导入后两种状态仍都在');
    assert.equal(again.iron_rules.skipped, 2);

    // 本地已经把这条淘汰了：归档里的生效版不复活，历史版照常留下
    const c = openStore(join(root, 'c.db'));
    const retiredLocal = c.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备删除一个目录的时候', rule: '先看一眼是不是软链接再删', now: T0 });
    c.setPrincipleStatus(retiredLocal.id, 'retired', { retireReason: '本地用户淘汰了', now: T1 });
    const intoRetired = await importArchive({ store: c, scope: 'personal', archivePath: out, mode: 'merge' });
    assert.equal(c.listPrinciples('personal', { status: 'active' }).length, 0, '不复活');
    assert.match(intoRetired.principles.conflicts.find((x) => x.archived_text.includes('软链接') && /不复活/.test(x.reason))?.reason ?? '', /不复活/);
    b.close();
    c.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('角色归档不带也不写 team/，只回同一个项目的同名角色；.team 逐级拒绝符号链接；角色快照目录带项目编号', async () => {
  const root = temp();
  const makeProject = (name: string, id: string): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.team', 'roles'), { recursive: true });
    writeFileSync(join(dir, '.team', 'manifest.json'), JSON.stringify({ schema_version: 1, project_id: id, project_name: name, domain: 'custom', created_at: T0 }));
    writeFileSync(join(dir, '.team', 'TEAM.md'), '# 班底\n');
    writeFileSync(join(dir, '.team', 'roles', 'reviewer.md'), '# 审查员\n');
    return dir;
  };
  try {
    const pa = makeProject('proj-a', 'proj-a-id');
    const pb = makeProject('proj-b', 'proj-b-id');
    const storeA = openStore(join(pa, '.team', '.mind.db'));
    storeA.insertPrinciple({ scope: 'role:reviewer', triggerWhen: '当你审查别人的代码的时候', rule: '先看测试再看实现', now: T0 });
    const roleArchive = join(root, 'role.tar.gz');
    const roleReport = exportArchive({ store: storeA, scope: 'role:reviewer', outPath: roleArchive, projectDir: pa, projectId: 'proj-a-id', now: () => T1 });
    assert.equal(roleReport.counts.team_files, 0, '角色归档不带 team/');
    assert.deepEqual(readArchive(roleArchive).teamFiles, []);
    assert.equal(readArchive(roleArchive).manifest.project_id, 'proj-a-id');
    assert.throws(() => exportArchive({ store: storeA, scope: 'role:reviewer', outPath: join(root, 'role2.tar.gz'), projectDir: pa, now: () => T1 }), /必须给项目编号/);

    const storeB = openStore(join(pb, '.team', '.mind.db'));
    await assert.rejects(() => importArchive({ store: storeB, scope: 'role:reviewer', archivePath: roleArchive, mode: 'merge', projectDir: pb, projectId: 'proj-b-id' }), /来自项目「proj-a-id」，当前目标是「proj-b-id」/);
    assert.equal(storeB.listPrinciples('role:reviewer', { status: 'all' }).length, 0, '另一个项目的同名角色一个字节不写');
    assert.equal(readFileSync(join(pb, '.team', 'TEAM.md'), 'utf8'), '# 班底\n');
    await assert.rejects(() => importArchive({ store: storeB, scope: 'role:reviewer', archivePath: roleArchive, mode: 'merge', projectDir: pb }), /来自项目「proj-a-id」/, '不给项目编号也不行');
    storeB.close();
    storeA.close();

    // 同项目的另一个检出：导入成功、不带 team/；.team/roles 是符号链接时逐级拒绝，不往链接目标写
    const pa2 = makeProject('proj-a-again', 'proj-a-id');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    rmSync(join(pa2, '.team', 'roles'), { recursive: true, force: true });
    symlinkSync(outside, join(pa2, '.team', 'roles'));
    const storeA2 = openStore(join(pa2, '.team', '.mind.db'));
    const intoRole = await importArchive({ store: storeA2, scope: 'role:reviewer', archivePath: roleArchive, mode: 'merge', projectDir: pa2, projectId: 'proj-a-id' });
    assert.equal(intoRole.principles.added, 1);
    assert.deepEqual(intoRole.team, { written: [], identical: 0, conflicts: [], failed: [] }, '角色归档不写 team/');
    const projectArchive = join(root, 'proj.tar.gz');
    const storePa = openStore(join(pa, '.team', '.mind.db'));
    assert.equal(exportArchive({ store: storePa, scope: 'project:proj-a-id', outPath: projectArchive, projectDir: pa, projectId: 'proj-a-id', now: () => T1 }).counts.team_files, 3, '项目归档带 manifest.json / TEAM.md / roles/reviewer.md');
    storePa.close();
    const pa3 = join(root, 'proj-a-third');
    mkdirSync(join(pa3, '.team'), { recursive: true });
    const storeA3 = openStore(join(pa3, '.team', '.mind.db'));
    writeFileSync(join(pa3, '.team', 'manifest.json'), JSON.stringify({ schema_version: 1, project_id: 'proj-a-id', project_name: 'x', domain: 'custom', created_at: T0 }));
    symlinkSync(outside, join(pa3, '.team', 'roles'));
    writeFileSync(join(pa3, '.team', 'TEAM.md'), '# 班底\n');
    const projectImport = await importArchive({ store: storeA3, scope: 'project:proj-a-id', archivePath: projectArchive, mode: 'merge', projectDir: pa3, projectId: 'proj-a-id' });
    assert.equal(projectImport.committed, true);
    assert.deepEqual(projectImport.team.failed.map((f) => f.path), ['manifest.json', 'roles/reviewer.md'].sort().filter((p) => p !== 'manifest.json'), 'roles/ 是符号链接：它下面的文件不写、不比较');
    assert.match(projectImport.team.failed[0]?.reason ?? '', /符号链接/);
    assert.equal(existsSync(join(outside, 'reviewer.md')), false, '没有顺着链接往外写');
    assert.deepEqual(projectImport.team.written, []);
    assert.equal(projectImport.team.identical, 1, 'TEAM.md 一致');
    assert.deepEqual(projectImport.team.conflicts.map((c) => c.path), ['manifest.json'], '本地 manifest.json（project_name 不同）不覆写');
    assert.match(readFileSync(join(pa3, '.team', 'manifest.json'), 'utf8'), /"project_name":"x"/);
    storeA2.close();
    storeA3.close();

    // 受控入口：.team 或 manifest.json 是符号链接就拒绝；库文件是符号链接也拒绝
    const pa4 = makeProject('proj-a-fourth', 'proj-a-id');
    const realTeam = join(root, 'real-team');
    mkdirSync(realTeam);
    writeFileSync(join(realTeam, 'manifest.json'), JSON.stringify({ schema_version: 1, project_id: 'proj-a-id', project_name: 'x', domain: 'custom', created_at: T0 }));
    rmSync(join(pa4, '.team'), { recursive: true, force: true });
    symlinkSync(realTeam, join(pa4, '.team'));
    assert.throws(() => resolveContext({ project: pa4, home: root }), /符号链接或不是目录，拒绝使用/);
    const pa5 = makeProject('proj-a-fifth', 'proj-a-id');
    symlinkSync(join(realTeam, 'manifest.json'), join(pa5, '.team', 'linked-manifest.json'));
    rmSync(join(pa5, '.team', 'manifest.json'));
    symlinkSync(join(realTeam, 'manifest.json'), join(pa5, '.team', 'manifest.json'));
    assert.throws(() => resolveContext({ project: pa5, home: root }), /符号链接或不是普通文件，拒绝使用/);
    const pa6 = makeProject('proj-a-sixth', 'proj-a-id');
    symlinkSync(join(root, 'elsewhere.db'), join(pa6, '.team', '.mind.db'));
    const linkedDb = new Memloom(resolveContext({ project: pa6, home: root }));
    assert.throws(() => linkedDb.store, /库文件.*是符号链接，拒绝打开/);
    linkedDb.close();

    // 同名角色在两个项目里的快照目录各带各的项目编号
    const home = join(root, 'home');
    const appA = new Memloom(resolveContext({ project: pa, role: 'reviewer', home, db: join(root, 'snap-a.db') }));
    const appB = new Memloom(resolveContext({ project: pb, role: 'reviewer', home, db: join(root, 'snap-b.db') }));
    appA.store.insertPrinciple({ scope: 'role:reviewer', triggerWhen: '当你审查别人的代码的时候', rule: '先看测试再看实现', now: T0 });
    appB.store.insertPrinciple({ scope: 'role:reviewer', triggerWhen: '当你审查别人的代码的时候', rule: '先跑一遍再说', now: T0 });
    const snapA = appA.writeSnapshot('role:reviewer');
    const snapB = appB.writeSnapshot('role:reviewer');
    assert.match(snapA.dir, /readable\/project-proj-a-id\/role-reviewer$/);
    assert.match(snapB.dir, /readable\/project-proj-b-id\/role-reviewer$/);
    assert.match(readFileSync(join(snapA.dir, 'PRINCIPLES.md'), 'utf8'), /先看测试再看实现/);
    assert.match(readFileSync(join(snapB.dir, 'PRINCIPLES.md'), 'utf8'), /先跑一遍再说/);
    assert.equal(appA.writeSnapshot('role:reviewer').dir, snapA.dir);
    appA.close();
    appB.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
