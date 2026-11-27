/**
 * 导入（规格 §7 + 冻结规范）：
 *   1. 读包：gzip 输出上限 → tar 成员（只认普通文件）→ 成员集合 → manifest 版本与来源项目 → 每个成员的 SHA-256 → 数量 → 记录字段 → 包内重复编号；
 *   2. 全部通过后才在一个事务里写库；跨库编号按本次内容翻译，包里没有的引用显式省略并计数；
 *   3. 默认 merge：不覆盖本地较新的文本、不改本地铁律；按「稳定身份」去重（重复导入无重复）——
 *      经历 = 类别 + 总结 + 引文 + 来源会话 + 发生时间（同总结但引文 / 类别 / 会话不同是不同证据，不合并）；
 *      铁律 = 正文 + 启停状态（空库按归档里出现过的不同状态各还原一条；本地已有同文的不改、不另插生效条绕过本地停用，差异写进回执）；
 *      原则 = 正文 + 状态（历史版本再带创建时间，同文的生效版和历史版不折叠、血缘不自指）；
 *      显式 replace：额外把目标作用域里「包里没有的生效原则」软退役留底，铁律、别的作用域、手写文件照旧不动；
 *   4. 事务提交后才写 `.team` 文件（逐级拒绝符号链接和非普通文件，只写目标里不存在的，每个文件的成功 / 一致 / 冲突 / 失败分别回报）。
 * 读端只拒重复编号和无效结构，不拒「两个合法编号、内容相同」的记录——产品自己导出的包必须能读回。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { isNearDuplicate } from '../core/condense.js';
import type { Store } from '../core/store.js';
import { assertScope, type DuplicateJudge, type PrincipleRow } from '../core/types.js';
import {
  ARCHIVE_LIMITS,
  ArchiveError,
  FIXED_MEMBERS,
  MEMBER,
  fingerprint,
  looksLikePlainText,
  maskSecrets,
  parseExperiences,
  parseIronRules,
  parsePrinciples,
  principleFingerprint,
  sha256Hex,
  teamFileExclusion,
  validateManifest,
  type ParsedArchive,
} from './format.js';
import { assertSafeMemberPath, gunzipBytes, unpackTar } from './tar.js';

export type ImportMode = 'merge' | 'replace';

export interface ImportOptions {
  store: Store;
  scope: string;
  archivePath: string;
  mode: ImportMode;
  /** 目标项目目录；项目域归档的 `team/` 文件写到 `<projectDir>/.team/`，只写不存在的 */
  projectDir?: string | null;
  /** 目标项目 ID：项目 / 角色归档必须来自同一个项目（角色备份不能迁进另一个同名角色） */
  projectId?: string | null;
  /** 可注入的语义查重：字面不同但意思相同的归档原则，判定为同一件事时合并血缘而不是新增一条近似的 */
  judge?: DuplicateJudge;
  now?: () => string;
}

export interface TeamFileFailure {
  path: string;
  reason: string;
}

export interface ImportReport {
  mode: ImportMode;
  scope: string;
  archive: { path: string; scope: string; project_id: string | null; exported_at: string; generator: string };
  /** 数据库事务已提交（后置步骤的成败不影响这个事实） */
  committed: boolean;
  /** added 新写；skipped 本地已有同文或同文同状态（含同一个包里重复的）；state_conflicts：导入前本地就有同文、但没有同状态的那条，以本地为准并在回执里写明 */
  iron_rules: { added: number; skipped: number; added_ids: number[]; state_conflicts: Array<{ ref: string; local_id: number; archived_active: boolean; local_active: boolean }> };
  principles: {
    added: number;
    merged: number;
    merged_semantic: number;
    core_demoted: number;
    retired_by_replace: number;
    added_ids: number[];
    /** 没法安全处理、原样留着没导的：本地文本和归档文本都列出来，由人决定 */
    conflicts: Array<{ ref: string; local_id: number; reason: string; local_text: string; archived_text: string }>;
  };
  experiences: { added: number; skipped: number };
  /** 包里引用了、但没被选进包里（或因冲突没导入）的记录：导入时显式省略，不留下指向错误内容的编号 */
  omitted_references: number;
  omitted_sample: string[];
  /** `.team` 文件逐个的结果：新写 / 已有一致 / 内容不同未覆写 / 没能写（原因） */
  team: { written: string[]; identical: number; conflicts: Array<{ path: string; reason: string }>; failed: TeamFileFailure[] };
  /** 导入时在记录字段里又掩蔽掉的常见凭据（正常情况下导出时已掩蔽，这里是兜底） */
  masked: Array<{ member: string; kind: string; count: number }>;
}

function textOf(data: Uint8Array, member: string): string {
  const reason = looksLikePlainText(data);
  if (reason) throw new ArchiveError(`成员「${member}」${reason}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function assertUnique(values: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ArchiveError(`${what}「${value}」在归档里出现了两次`);
    seen.add(value);
  }
}

/** 读包并校验到记录字段这一层；不写任何东西。 */
export function readArchive(archivePath: string): ParsedArchive {
  if (!existsSync(archivePath)) throw new ArchiveError(`找不到归档文件：${archivePath}`);
  const stats = statSync(archivePath);
  if (!stats.isFile()) throw new ArchiveError(`归档不是普通文件：${archivePath}`);
  if (stats.size > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ArchiveError(`归档有 ${stats.size} 字节，超过 ${ARCHIVE_LIMITS.maxArchiveBytes} 字节上限`);
  }
  const tar = gunzipBytes(readFileSync(archivePath), ARCHIVE_LIMITS.maxUnpackedBytes);
  const members = unpackTar(tar);

  const byPath = new Map<string, Uint8Array>();
  for (const member of members) {
    const fixed = (FIXED_MEMBERS as readonly string[]).includes(member.path);
    if (!fixed && !member.path.startsWith(MEMBER.teamPrefix)) {
      throw new ArchiveError(`归档里有不该出现的成员「${member.path}」，整包拒收`);
    }
    byPath.set(member.path, member.data);
  }
  for (const required of FIXED_MEMBERS) {
    if (!byPath.has(required)) throw new ArchiveError(`归档缺少成员「${required}」`);
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(textOf(byPath.get(MEMBER.manifest) as Uint8Array, MEMBER.manifest)) as unknown;
  } catch (error) {
    throw new ArchiveError(`manifest.json 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = validateManifest(manifestJson);

  const hashed = new Set<string>();
  for (const [member, expected] of Object.entries(manifest.sha256)) {
    const data = byPath.get(member);
    if (!data) throw new ArchiveError(`manifest 里记了成员「${member}」的哈希，但归档里没有这个成员`);
    if (sha256Hex(data) !== expected) throw new ArchiveError(`成员「${member}」的 SHA-256 和 manifest 对不上，文件损坏或被改过`);
    hashed.add(member);
  }
  for (const member of byPath.keys()) {
    if (member !== MEMBER.manifest && !hashed.has(member)) throw new ArchiveError(`成员「${member}」没有在 manifest 里登记哈希`);
  }

  const teamFiles: ParsedArchive['teamFiles'] = [];
  let teamBytes = 0;
  for (const [member, data] of byPath) {
    if (!member.startsWith(MEMBER.teamPrefix)) continue;
    const rel = assertSafeMemberPath(member.slice(MEMBER.teamPrefix.length));
    const reason = teamFileExclusion(rel);
    if (reason) throw new ArchiveError(`归档里的 team/ 成员「${rel}」不该出现：${reason}，整包拒收`);
    if (teamFiles.length >= ARCHIVE_LIMITS.maxTeamFiles) throw new ArchiveError(`team/ 文件超过 ${ARCHIVE_LIMITS.maxTeamFiles} 个上限`);
    if (data.byteLength > ARCHIVE_LIMITS.maxTeamFileBytes) throw new ArchiveError(`team/${rel} 超过单个文件 ${ARCHIVE_LIMITS.maxTeamFileBytes} 字节上限`);
    teamBytes += data.byteLength;
    if (teamBytes > ARCHIVE_LIMITS.maxTeamTotalBytes) throw new ArchiveError(`team/ 合计超过 ${ARCHIVE_LIMITS.maxTeamTotalBytes} 字节上限`);
    teamFiles.push({ path: rel, text: textOf(data, member) });
  }
  // team/ 只属于 project:<id>；个人和角色归档绝不带它
  if (teamFiles.length > 0 && !/^project:[^\s:]+$/.test(manifest.scope)) {
    throw new ArchiveError(`这是「${manifest.scope}」的归档，却带着 ${teamFiles.length} 个 team/ 文件；team/ 只属于项目归档，整包拒收`);
  }

  const ironRules = parseIronRules(textOf(byPath.get(MEMBER.ironRules) as Uint8Array, MEMBER.ironRules));
  const principles = parsePrinciples(textOf(byPath.get(MEMBER.principles) as Uint8Array, MEMBER.principles));
  const experiences = parseExperiences(textOf(byPath.get(MEMBER.experiences) as Uint8Array, MEMBER.experiences));
  const counts = manifest.counts;
  if (counts.iron_rules !== ironRules.length || counts.principles !== principles.length || counts.experiences !== experiences.length || counts.team_files !== teamFiles.length) {
    throw new ArchiveError(
      `manifest 的 counts（铁律 ${counts.iron_rules} / 原则 ${counts.principles} / 经历 ${counts.experiences} / team 文件 ${counts.team_files}）和实际成员（` +
        `${ironRules.length} / ${principles.length} / ${experiences.length} / ${teamFiles.length}）对不上`,
    );
  }
  assertUnique(ironRules.map((r) => r.ref), '铁律编号');
  assertUnique(principles.map((p) => p.ref), '原则编号');
  assertUnique(experiences.map((e) => e.ref), '经历编号');
  return { manifest, ironRules, principles, experiences, teamFiles };
}

class ImportMasker {
  readonly hits = new Map<string, number>();

  constructor(private readonly member: string) {}

  text(value: string): string {
    const result = maskSecrets(value);
    for (const hit of result.hits) this.hits.set(hit.kind, (this.hits.get(hit.kind) ?? 0) + hit.count);
    return result.text;
  }

  report(): Array<{ member: string; kind: string; count: number }> {
    return [...this.hits.entries()].map(([kind, count]) => ({ member: this.member, kind, count }));
  }
}

function refNumber(ref: string): number {
  const value = Number(ref.slice(ref.indexOf(':') + 1));
  return Number.isSafeInteger(value) ? value : 0;
}

/* ---------- 稳定身份：只用来认「同一条」，不用来合并不同的证据 ---------- */

function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 经历：类别 + 总结 + 引文 + 来源会话 + 发生时间。同总结但引文 / 类别 / 会话 / 时间不同，就是不同的证据。 */
function experienceKey(exp: { kind: string; summary: string; evidence: string | null; sourceSession: string | null; occurredAt: string }): string {
  return sha256Hex(
    JSON.stringify([exp.kind, squashWhitespace(exp.summary), exp.evidence === null ? null : squashWhitespace(exp.evidence), exp.sourceSession ?? null, exp.occurredAt]),
  );
}

/** 铁律：正文。本地已有同文的就不再写第二条（哪怕启停状态不同）——本地用户停用的规则不能被归档悄悄重新启用；状态差异写进回执。 */
function ironKey(content: string): string {
  return fingerprint(content);
}

/** 原则：正文 + 状态；历史版本（非生效）再带创建时间，同文的两个历史版本不折叠，生效版和历史版也不折叠。 */
function principleKey(triggerWhen: string, rule: string, status: string, createdAt: string): string {
  const base = `${principleFingerprint(triggerWhen, rule)}|${status}`;
  return status === 'active' ? base : `${base}|${createdAt}`;
}

interface PreparedPrinciple {
  archived: ParsedArchive['principles'][number];
  triggerWhen: string;
  rule: string;
  rationale: string | null;
  retireReason: string | null;
}

/**
 * 事务是同步的，所以可注入的语义判断（异步）要在开事务前跑完：
 * 只对「本地连字面相同的都没有」的归档原则问它，它说和哪条本地生效原则是同一件事，就记下来在事务里合并血缘。
 */
async function judgeSemantics(
  store: Store,
  scope: string,
  prepared: readonly PreparedPrinciple[],
  judge: DuplicateJudge | undefined,
): Promise<Map<string, number>> {
  const semantic = new Map<string, number>();
  if (!judge) return semantic;
  const localActive = store.listPrinciples(scope, { status: 'active', limit: ARCHIVE_LIMITS.maxPrinciples });
  const localTexts = new Set(store.listPrinciples(scope, { status: 'all', limit: ARCHIVE_LIMITS.maxPrinciples }).map((p) => principleFingerprint(p.triggerWhen, p.rule)));
  for (const item of prepared) {
    if (localTexts.has(principleFingerprint(item.triggerWhen, item.rule))) continue;
    const id = await judge.findDuplicate(
      { trigger_when: item.triggerWhen, rule: item.rule },
      localActive.map((l) => ({ id: l.id, trigger_when: l.triggerWhen, rule: l.rule })),
    );
    if (id === null) continue;
    if (!localActive.some((l) => l.id === id)) {
      throw new ArchiveError(`语义查重（${judge.id}）返回的编号 #${id} 不在本地生效原则里，判定不可信，整包不导`);
    }
    semantic.set(item.archived.ref, id);
  }
  return semantic;
}

function applyImport(
  store: Store,
  scope: string,
  archive: ParsedArchive,
  context: { mode: ImportMode; prepared: readonly PreparedPrinciple[]; semantic: Map<string, number>; masked: ImportReport['masked']; now: string },
): ImportReport {
  const { mode } = context;
  const at = context.now;
  const report: ImportReport = {
    mode,
    scope,
    archive: { path: '', scope: archive.manifest.scope, project_id: archive.manifest.project_id, exported_at: archive.manifest.exported_at, generator: archive.manifest.generator },
    committed: false,
    iron_rules: { added: 0, skipped: 0, added_ids: [], state_conflicts: [] },
    principles: { added: 0, merged: 0, merged_semantic: 0, core_demoted: 0, retired_by_replace: 0, added_ids: [], conflicts: [] },
    experiences: { added: 0, skipped: 0 },
    omitted_references: 0,
    omitted_sample: [],
    team: { written: [], identical: 0, conflicts: [], failed: [] },
    masked: context.masked,
  };
  const idMap = new Map<string, number>();
  const omitted = new Set<string>();
  const mapRefs = (refs: readonly string[]): number[] => {
    const out: number[] = [];
    for (const ref of refs) {
      const id = idMap.get(ref);
      if (id === undefined) {
        omitted.add(ref);
        continue;
      }
      if (!out.includes(id)) out.push(id);
    }
    return out.sort((a, b) => a - b);
  };

  /** 系统自己写的说明文字里带着「原则 #N」「经历 #N」：按本次翻译换成本地编号；包里没带上的写明是归档编号，绝不留下指向别人同号记录的裸编号。 */
  const translateTextRefs = (value: string): string =>
    value
      .replace(/原则 #(\d+)/g, (_match, id: string) => {
        const mapped = idMap.get(`p:${id}`);
        return mapped === undefined ? `原则（归档编号 ${id}，这次没有导入）` : `原则 #${mapped}`;
      })
      .replace(/经历 #(\d+)/g, (_match, id: string) => {
        const mapped = idMap.get(`exp:${id}`);
        return mapped === undefined ? `经历（归档编号 ${id}，这次没有导入）` : `经历 #${mapped}`;
      });

  /* ---- 经历（先于原则，原则的来源要翻译成新编号）：身份表随新增及时更新 ---- */
  const experienceMasker = new ImportMasker(MEMBER.experiences);
  const localExpByKey = new Map<string, number>();
  for (const e of store.listExperiences(scope, { limit: 1_000_000 })) {
    const key = experienceKey({ kind: e.kind, summary: e.summary, evidence: e.evidence, sourceSession: e.sourceSession, occurredAt: e.occurredAt });
    if (!localExpByKey.has(key)) localExpByKey.set(key, e.id);
  }
  for (const exp of archive.experiences) {
    const summary = experienceMasker.text(exp.summary);
    const evidence = exp.evidence === null ? null : experienceMasker.text(exp.evidence);
    const key = experienceKey({ kind: exp.kind, summary, evidence, sourceSession: exp.source_session, occurredAt: exp.occurred_at });
    const existing = localExpByKey.get(key);
    if (existing !== undefined) {
      // 确实等价的一条（或同一个包里重复出现的同一条）：并到已有的，不重复记
      report.experiences.skipped += 1;
      idMap.set(exp.ref, existing);
      continue;
    }
    const row = store.addExperience({ scope, kind: exp.kind, summary, evidence, source: 'import', sourceSession: exp.source_session, occurredAt: exp.occurred_at, createdAt: exp.created_at });
    store.restoreExperienceCounters(row.id, { hitCount: exp.hit_count, lastHitAt: exp.last_hit_at, processedAt: exp.processed_at });
    report.experiences.added += 1;
    idMap.set(exp.ref, row.id);
    localExpByKey.set(key, row.id);
  }

  /* ---- 铁律：只补缺，从不改本地已有（文本、启用状态都不动）----
   * 导入前本地就有同文的：优先对应同状态的那条；没有同状态就跳过并如实报状态冲突，绝不另插一条同文生效的去绕过本地明确停用。
   * 导入前本地没有同文的：按归档里出现过的「正文 + 启停状态」各还原一条（恢复到空库时保留原有启停状态），同文同状态去重，次序不影响是否保留生效。 */
  const ironMasker = new ImportMasker(MEMBER.ironRules);
  /** 导入前本地就有的同文铁律：正文 → 各条（只读，不动） */
  const preExistingIron = new Map<string, Array<{ id: number; active: boolean }>>();
  for (const r of store.listIronRules(scope, { activeOnly: false })) {
    const key = ironKey(r.content);
    preExistingIron.set(key, [...(preExistingIron.get(key) ?? []), { id: r.id, active: r.active }]);
  }
  /** 本批新写的：正文 + 状态 → 编号（原先本地没有同文时用） */
  const writtenIron = new Map<string, number>();
  for (const rule of archive.ironRules) {
    const content = ironMasker.text(rule.content);
    const key = ironKey(content);
    const existing = preExistingIron.get(key);
    if (existing !== undefined) {
      const sameState = existing.find((e) => e.active === rule.active);
      const anchor = sameState ?? (existing[0] as { id: number; active: boolean });
      report.iron_rules.skipped += 1;
      idMap.set(rule.ref, anchor.id);
      if (!sameState) {
        report.iron_rules.state_conflicts.push({ ref: rule.ref, local_id: anchor.id, archived_active: rule.active, local_active: anchor.active });
      }
      continue;
    }
    const stateKey = `${key}|${rule.active ? 'on' : 'off'}`;
    const written = writtenIron.get(stateKey);
    if (written !== undefined) {
      report.iron_rules.skipped += 1;
      idMap.set(rule.ref, written);
      continue;
    }
    const row = store.addIronRule({ scope, content, now: rule.created_at });
    store.setIronRuleActive(row.id, rule.active, rule.updated_at);
    report.iron_rules.added += 1;
    report.iron_rules.added_ids.push(row.id);
    idMap.set(rule.ref, row.id);
    writtenIron.set(stateKey, row.id);
  }

  /* ---- 原则 ---- */
  const localPrinciples = store.listPrinciples(scope, { status: 'all', limit: ARCHIVE_LIMITS.maxPrinciples });
  /** 稳定身份 → 本地原则（随新增及时更新） */
  const localByIdentity = new Map<string, PrincipleRow>();
  /** 正文指纹 → 导入前本地就有的同文版本（任何状态）：只用来判「状态不同」和「不复活旧原则」，不看这次刚导进来的 */
  const preExistingText = new Map<string, PrincipleRow[]>();
  for (const p of localPrinciples) {
    const identity = principleKey(p.triggerWhen, p.rule, p.status, p.createdAt);
    if (!localByIdentity.has(identity)) localByIdentity.set(identity, p);
    const fp = principleFingerprint(p.triggerWhen, p.rule);
    preExistingText.set(fp, [...(preExistingText.get(fp) ?? []), p]);
  }
  const localActive = localPrinciples.filter((p) => p.status === 'active');
  const matchedLocal = new Set<number>();
  /** 用来做「字面很接近」比对的本池：本地生效原则 + 这次刚导进来的 */
  const nearPool: Array<{ id: number; text: string }> = localActive.map((p) => ({ id: p.id, text: `${p.triggerWhen}\n${p.rule}` }));
  const capacityBefore = store.capacity(scope);
  let coreBudget = Math.max(0, capacityBefore.maxCore - capacityBefore.coreCount);
  const sorted = [...context.prepared].sort((a, b) => refNumber(a.archived.ref) - refNumber(b.archived.ref));
  // 说明文字里的「原则 #N」要等全部原则都拿到本地编号后才能翻译，所以先记下来，循环结束再统一写回
  const pendingText: Array<{ id: number; meta: Parameters<Store['restorePrincipleMeta']>[1]; rationale: string | null; retireReason: string | null }> = [];

  for (const item of sorted) {
    const p = item.archived;
    const text = `${item.triggerWhen}\n${item.rule}`;
    const fp = principleFingerprint(item.triggerWhen, item.rule);
    const same = localByIdentity.get(principleKey(item.triggerWhen, item.rule, p.status, p.created_at));
    const semanticId = context.semantic.get(p.ref);

    if (same) {
      // 同一条（同文、同状态；历史版本还同创建时间）：只补血缘，不改文本、强度、状态
      matchedLocal.add(same.id);
      idMap.set(p.ref, same.id);
      report.principles.merged += 1;
      const newSources = mapRefs(p.sources).filter((id) => !same.sourceExperienceIds.includes(id));
      if (newSources.length > 0 && same.status === 'active') store.reinforcePrinciple(same.id, { delta: 0, addSourceIds: newSources, now: at });
      continue;
    }

    const sameText = preExistingText.get(fp) ?? [];
    const activeLocal = sameText.find((l) => l.status === 'active');
    if (activeLocal && p.status !== 'active') {
      // 本地这条是生效的，归档里是它的历史版本：以本地为准，不把生效的那条改成历史，也不多留一份历史
      matchedLocal.add(activeLocal.id);
      idMap.set(p.ref, activeLocal.id);
      report.principles.conflicts.push({
        ref: p.ref,
        local_id: activeLocal.id,
        reason: `文字一样但状态不同：本地是「active」，归档是「${p.status}」；以本地为准，没有改`,
        local_text: text,
        archived_text: text,
      });
      continue;
    }
    if (p.status === 'active' && sameText.length > 0) {
      // 本地已经把这条淘汰 / 替代 / 合并了：归档里的生效版不复活
      const anchor = sameText[0] as PrincipleRow;
      idMap.set(p.ref, anchor.id);
      report.principles.conflicts.push({
        ref: p.ref,
        local_id: anchor.id,
        reason: `文字一样但状态不同：本地已经把这条标为「${sameText.map((l) => l.status).join(' / ')}」，归档里却是生效的；不复活旧原则，以本地为准`,
        local_text: text,
        archived_text: text,
      });
      continue;
    }

    if (semanticId !== undefined) {
      const local = localPrinciples.find((l) => l.id === semanticId);
      if (!local) throw new ArchiveError('内部错误：语义判断匹配到的本地原则不见了');
      matchedLocal.add(local.id);
      idMap.set(p.ref, local.id);
      report.principles.merged_semantic += 1;
      const newSources = mapRefs(p.sources).filter((id) => !local.sourceExperienceIds.includes(id));
      if (newSources.length > 0) store.reinforcePrinciple(local.id, { delta: 0, addSourceIds: newSources, now: at });
      continue;
    }

    const near = nearPool.find((other) => !matchedLocal.has(other.id) && isNearDuplicate(text, other.text));
    if (near) {
      report.principles.conflicts.push({
        ref: p.ref,
        local_id: near.id,
        reason: `和本地原则 #${near.id} 字面很接近但内容不同；默认合并不覆盖本地文本，这条没有导入，请人工决定`,
        local_text: near.text,
        archived_text: text,
      });
      matchedLocal.add(near.id);
      continue;
    }

    const mappedParents = mapRefs(p.parents); // 父亲都是本包里编号更小的归档记录，刚插入的这条不可能当自己的父亲
    const mappedSources = mapRefs(p.sources);
    let isCore = p.is_core && p.status === 'active';
    if (isCore && coreBudget <= 0) {
      isCore = false;
      report.principles.core_demoted += 1;
    }
    if (isCore) coreBudget -= 1;
    const row = store.insertPrinciple({
      scope,
      triggerWhen: item.triggerWhen,
      rule: item.rule,
      rationale: item.rationale,
      isCore,
      parentIds: mappedParents,
      sourceExperienceIds: mappedSources,
      now: p.created_at,
    });
    const meta = {
      status: p.status,
      isCore,
      rationale: item.rationale,
      strength: p.strength,
      appliedCount: p.applied_count,
      violatedCount: p.violated_count,
      retireReason: item.retireReason,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      lastUsedAt: p.last_used_at,
    };
    store.restorePrincipleMeta(row.id, meta);
    if (item.rationale !== null || item.retireReason !== null) pendingText.push({ id: row.id, meta, rationale: item.rationale, retireReason: item.retireReason });
    report.principles.added += 1;
    report.principles.added_ids.push(row.id);
    idMap.set(p.ref, row.id);
    // 身份表随新增及时更新：同一个包里后面再出现等价的一条，就并到这条，不再新增
    const inserted = store.getPrinciple(row.id);
    localByIdentity.set(principleKey(inserted.triggerWhen, inserted.rule, inserted.status, inserted.createdAt), inserted);
    if (p.status === 'active') nearPool.push({ id: row.id, text });
  }
  for (const item of pendingText) {
    const rationale = item.rationale === null ? null : translateTextRefs(item.rationale);
    const retireReason = item.retireReason === null ? null : translateTextRefs(item.retireReason);
    if (rationale !== item.rationale || retireReason !== item.retireReason) store.restorePrincipleMeta(item.id, { ...item.meta, rationale, retireReason });
  }
  report.omitted_references = omitted.size;
  report.omitted_sample = [...omitted].sort().slice(0, 20);

  /* ---- replace：目标作用域里包里没有的生效原则软退役留底（铁律、别的作用域都不碰） ---- */
  if (mode === 'replace') {
    for (const local of localActive) {
      if (matchedLocal.has(local.id)) continue;
      store.setPrincipleStatus(local.id, 'retired', {
        retireReason: `导入替换：归档（导出于 ${archive.manifest.exported_at}）里没有这条，按 replace 模式软退役，历史保留`,
        now: at,
      });
      report.principles.retired_by_replace += 1;
    }
  }

  /* ---- 容量硬上限：事务内复核，超了整体回滚 ---- */
  const capacity = store.capacity(scope);
  if (capacity.activeCount > capacity.hardCount) {
    throw new ArchiveError(`导入后生效原则会到 ${capacity.activeCount} 条，超过这个作用域的硬上限 ${capacity.hardCount} 条；整包没有导入`);
  }
  if (capacity.activeChars > capacity.hardChars) {
    throw new ArchiveError(`导入后生效原则会到 ${capacity.activeChars} 字，超过这个作用域的硬上限 ${capacity.hardChars} 字；整包没有导入`);
  }
  return report;
}

/** `path` 这一级存在吗：不存在返回 null；是符号链接 / 非目录 / 非普通文件返回原因。kind 是这次期望的形态。 */
function pathProblem(path: string, kind: 'dir' | 'file'): string | null {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `看不了 ${path}：${error instanceof Error ? error.message : String(error)}`;
  }
  if (stats.isSymbolicLink()) return `「${basename(path)}」是符号链接：不写、不比较、不顺着链接走`;
  if (kind === 'dir' && !stats.isDirectory()) return `「${basename(path)}」不是目录`;
  if (kind === 'file' && !stats.isFile()) return `「${basename(path)}」不是普通文件`;
  return null;
}

/** 事务提交后写 `.team` 文件：从 `.team` 到目标的每一级都拒绝符号链接和非普通文件；只写不存在的；每个文件的结果分别回报，这里不再抛错。 */
function writeTeamFiles(projectDir: string, archive: ParsedArchive, report: ImportReport): void {
  const teamRoot = resolve(projectDir, '.team');
  const rootProblem = pathProblem(teamRoot, 'dir');
  if (rootProblem) {
    for (const file of archive.teamFiles) report.team.failed.push({ path: file.path, reason: `.team/ 这一级就不行（${rootProblem}），一个文件都没写` });
    return;
  }
  for (const file of archive.teamFiles) {
    const target = resolve(teamRoot, file.path);
    if (!target.startsWith(`${teamRoot}${sep}`)) {
      report.team.failed.push({ path: file.path, reason: '路径解析后跑到了 .team/ 外面，拒绝写入' });
      continue;
    }
    // 逐级检查中间目录：已有的必须是真实目录，不存在的才建
    const segments = file.path.split('/');
    let problem: string | null = null;
    let cursor = teamRoot;
    for (const segment of segments.slice(0, -1)) {
      cursor = resolve(cursor, segment);
      const issue = pathProblem(cursor, 'dir');
      if (issue) {
        problem = issue;
        break;
      }
      if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o755 });
    }
    if (problem === null) problem = pathProblem(target, 'file');
    if (problem !== null) {
      report.team.failed.push({ path: file.path, reason: problem });
      continue;
    }
    if (existsSync(target)) {
      if (readFileSync(target, 'utf8') === file.text) report.team.identical += 1;
      else report.team.conflicts.push({ path: file.path, reason: '目标里已有内容不同的文件，没有覆写（人手写的文件以本地为准）' });
      continue;
    }
    try {
      writeFileSync(target, file.text, { flag: 'wx', mode: 0o644 });
      report.team.written.push(file.path);
    } catch (error) {
      report.team.failed.push({ path: file.path, reason: `写不进去：${error instanceof Error ? error.message : String(error)}` });
    }
  }
}

/** 读包 → 校验 → 一个事务写库 → 写 `.team` 文件。向量重建和可读快照由调用方在之后做并分别报告。 */
export async function importArchive(options: ImportOptions): Promise<ImportReport> {
  const scope = assertScope(options.scope).scope;
  const archivePath = resolve(options.archivePath);
  const archive = readArchive(archivePath);
  if (archive.manifest.scope !== scope) {
    throw new ArchiveError(`这个归档是「${archive.manifest.scope}」作用域的，当前目标是「${scope}」；个人、项目、角色的数据不混着导`);
  }
  // 项目 / 角色归档绑来源项目：角色备份不能迁进另一个项目的同名角色
  if (archive.manifest.project_id !== (options.projectId ?? null)) {
    throw new ArchiveError(
      `这个归档来自项目「${archive.manifest.project_id ?? '（个人）'}」，当前目标是「${options.projectId ?? '（个人）'}」；项目数据只回同一个项目，角色备份不能迁进另一个项目的同名角色`,
    );
  }
  if (archive.teamFiles.length > 0 && !options.projectDir) {
    throw new ArchiveError(`归档带 ${archive.teamFiles.length} 个 team/ 文件，但这次导入没有指定项目目录；整包没有导入`);
  }
  const at = (options.now ?? (() => new Date().toISOString()))();
  const principleMasker = new ImportMasker(MEMBER.principles);
  const prepared: PreparedPrinciple[] = archive.principles.map((archived) => ({
    archived,
    triggerWhen: principleMasker.text(archived.trigger_when),
    rule: principleMasker.text(archived.rule),
    rationale: archived.rationale === null ? null : principleMasker.text(archived.rationale),
    retireReason: archived.retire_reason === null ? null : principleMasker.text(archived.retire_reason),
  }));
  const semantic = await judgeSemantics(options.store, scope, prepared, options.judge);
  const report = options.store.transaction(() =>
    applyImport(options.store, scope, archive, { mode: options.mode, prepared, semantic, masked: principleMasker.report(), now: at }),
  );
  report.archive.path = archivePath;
  report.committed = true;
  if (archive.teamFiles.length > 0 && options.projectDir) writeTeamFiles(options.projectDir, archive, report);
  return report;
}
