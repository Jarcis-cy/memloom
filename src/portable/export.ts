/**
 * 导出（规格 §7）：把一个作用域打成 `memloom-<scope>-<日期>.tar.gz`。
 * 只带纯文本：manifest、铁律、原则（含状态 / 血缘 / 统计）、精选经历、两份可读快照；项目域再带 `.team` 纯文本。
 * 不带 SQLite、向量字节、缓存、模型和凭据：向量列根本不读；常见凭据在记录字段里会被掩蔽并写进 manifest。
 * 所有写入内存 → 一次写盘（`wx`，不覆盖已有文件）。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { assertScope, type ExperienceRow, type PrincipleRow } from '../core/types.js';
import type { Store } from '../core/store.js';
import {
  ARCHIVE_LIMITS,
  ARCHIVE_SCHEMA_VERSION,
  ArchiveError,
  type ArchiveManifest,
  type ArchivedExperience,
  type ArchivedIronRule,
  type ArchivedPrinciple,
  looksLikePlainText,
  maskSecrets,
  MEMBER,
  sha256Hex,
  teamDirExclusion,
  teamFileExclusion,
} from './format.js';
import { renderPrinciples, renderStanding } from './readable.js';
import { assertSafeMemberPath, gzipBytes, packTar, type TarFile } from './tar.js';

export const GENERATOR = 'memloom 0.1.0';

/** 精选经历：被原则引用的全部 + 待处理的全部 + 最近若干 + 被召回最多的若干；总数封顶 */
export const EXPORT_SELECTION = { recent: 30, frequent: 20, maxExperiences: 500 } as const;

export interface ExportOptions {
  store: Store;
  scope: string;
  outPath: string;
  /** 项目目录；给了就把 `<projectDir>/.team` 的纯文本打进 `team/` */
  projectDir?: string | null;
  /** 项目 ID（.team/manifest.json 的 project_id）；项目 / 角色归档记进 manifest，导入时只认同一个项目 */
  projectId?: string | null;
  now?: () => string;
  maxExperiences?: number;
}

export interface ExportReport {
  outPath: string;
  bytes: number;
  scope: string;
  exportedAt: string;
  counts: ArchiveManifest['counts'];
  masked: ArchiveManifest['masked'];
  excluded: ArchiveManifest['excluded'];
  /** 因为经历没被选进而省略掉的来源引用数 */
  omittedReferences: number;
  members: string[];
}

class Masker {
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

function selectExperiences(store: Store, scope: string, principles: readonly PrincipleRow[], max: number): ExperienceRow[] {
  const referenced = new Set(principles.flatMap((p) => p.sourceExperienceIds));
  const priority = new Map<number, number>();
  const rows = new Map<number, ExperienceRow>();
  const put = (row: ExperienceRow, rank: number): void => {
    const known = priority.get(row.id);
    if (known === undefined || rank < known) priority.set(row.id, rank);
    rows.set(row.id, row);
  };
  for (const row of store.getExperiences([...referenced])) put(row, 0);
  for (const row of store.listExperiences(scope, { processed: false, limit: max })) put(row, 1);
  for (const row of store.listExperiences(scope, { limit: EXPORT_SELECTION.recent })) put(row, 2);
  for (const row of store.listFrequentExperiences(scope, EXPORT_SELECTION.frequent)) put(row, 2);
  return [...rows.values()]
    .sort((a, b) => (priority.get(a.id) as number) - (priority.get(b.id) as number) || b.id - a.id)
    .slice(0, max)
    .sort((a, b) => a.id - b.id);
}

interface TeamWalk {
  files: Array<{ path: string; data: Buffer }>;
  excluded: Array<{ path: string; reason: string }>;
}

/** 走一遍 `.team/`：不顺着符号链接读，不收非普通文件；按保守规则只挑纯文本。 */
function walkTeam(teamDir: string): TeamWalk {
  const out: TeamWalk = { files: [], excluded: [] };
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    for (const entry of readdirSync(rel === '' ? teamDir : resolve(teamDir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        out.excluded.push({ path: childRel, reason: '是符号链接，不打包也不顺着链接读' });
        continue;
      }
      if (entry.isDirectory()) {
        const reason = teamDirExclusion(entry.name);
        if (reason) out.excluded.push({ path: childRel, reason });
        else stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) {
        out.excluded.push({ path: childRel, reason: '不是普通文件（管道、设备等）' });
        continue;
      }
      const reason = teamFileExclusion(childRel);
      if (reason) {
        out.excluded.push({ path: childRel, reason });
        continue;
      }
      const stats = statSync(resolve(teamDir, childRel));
      if (stats.size > ARCHIVE_LIMITS.maxTeamFileBytes) {
        out.excluded.push({ path: childRel, reason: `超过单个文件 ${ARCHIVE_LIMITS.maxTeamFileBytes} 字节上限` });
        continue;
      }
      const data = readFileSync(resolve(teamDir, childRel));
      const textReason = looksLikePlainText(data);
      if (textReason) {
        out.excluded.push({ path: childRel, reason: textReason });
        continue;
      }
      out.files.push({ path: childRel, data });
    }
  }
  // 按码点排序（不随系统语言变），保证同一个目录每次打出来的包成员顺序一样
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  out.excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function exportArchive(options: ExportOptions): ExportReport {
  const scope = assertScope(options.scope).scope;
  const now = options.now ?? (() => new Date().toISOString());
  const exportedAt = now();
  const max = Math.min(Math.max(1, options.maxExperiences ?? EXPORT_SELECTION.maxExperiences), EXPORT_SELECTION.maxExperiences);
  const outPath = resolve(options.outPath);
  if (existsSync(outPath)) throw new ArchiveError(`「${outPath}」已经存在，不覆盖已有文件；换个文件名，或确认旧包不要了再删`);
  const outDir = dirname(outPath);
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) throw new ArchiveError(`输出目录不存在：${outDir}（不替你建目录）`);

  // team/ 只属于 project:<id>；角色归档绝不带它（角色备份只回同一个项目，不带也不写整个 .team）
  const teamDir = options.projectDir && assertScope(scope).kind === 'project' ? resolve(options.projectDir, '.team') : null;
  if (teamDir && (outPath === teamDir || outPath.startsWith(`${teamDir}${sep}`))) {
    throw new ArchiveError('导出文件不能放进 `.team/` 目录里（免得包套包，污染下一次导出）');
  }

  const ironRules = options.store.listIronRules(scope, { activeOnly: false });
  const principles = options.store.listPrinciples(scope, { status: 'all', limit: ARCHIVE_LIMITS.maxPrinciples });
  const experiences = selectExperiences(options.store, scope, principles, max);
  const exportedExperienceRefs = new Set(experiences.map((e) => e.id));

  const ironMasker = new Masker(MEMBER.ironRules);
  const archivedIron: ArchivedIronRule[] = ironRules.map((rule) => ({
    ref: `iron:${rule.id}`,
    content: ironMasker.text(rule.content),
    active: rule.active,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  }));

  const principleMasker = new Masker(MEMBER.principles);
  let omittedReferences = 0;
  const archivedPrinciples: ArchivedPrinciple[] = principles.map((p) => {
    const sources = p.sourceExperienceIds.filter((id) => exportedExperienceRefs.has(id));
    omittedReferences += p.sourceExperienceIds.length - sources.length;
    return {
      ref: `p:${p.id}`,
      trigger_when: principleMasker.text(p.triggerWhen),
      rule: principleMasker.text(p.rule),
      rationale: p.rationale === null ? null : principleMasker.text(p.rationale),
      status: p.status,
      is_core: p.isCore,
      parents: p.parentIds.map((id) => `p:${id}`),
      sources: sources.map((id) => `exp:${id}`),
      strength: p.strength,
      applied_count: p.appliedCount,
      violated_count: p.violatedCount,
      retire_reason: p.retireReason === null ? null : principleMasker.text(p.retireReason),
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      last_used_at: p.lastUsedAt,
    };
  });

  const experienceMasker = new Masker(MEMBER.experiences);
  const archivedExperiences: ArchivedExperience[] = experiences.map((e) => ({
    ref: `exp:${e.id}`,
    kind: e.kind,
    summary: experienceMasker.text(e.summary),
    evidence: e.evidence === null ? null : experienceMasker.text(e.evidence),
    source: e.source,
    source_session: e.sourceSession,
    occurred_at: e.occurredAt,
    created_at: e.createdAt,
    processed_at: e.processedAt,
    hit_count: e.hitCount,
    last_hit_at: e.lastHitAt,
  }));

  const files: TarFile[] = [
    { path: MEMBER.ironRules, data: Buffer.from(`${JSON.stringify(archivedIron, null, 1)}\n`, 'utf8') },
    { path: MEMBER.principles, data: Buffer.from(`${JSON.stringify(archivedPrinciples, null, 1)}\n`, 'utf8') },
    {
      path: MEMBER.experiences,
      data: Buffer.from(archivedExperiences.map((e) => JSON.stringify(e)).join('\n') + (archivedExperiences.length > 0 ? '\n' : ''), 'utf8'),
    },
    {
      path: MEMBER.standing,
      data: Buffer.from(renderStanding(scope, archivedIron.map((r, index) => ({ id: ironRules[index]?.id ?? index + 1, active: r.active, content: r.content }))), 'utf8'),
    },
    {
      path: MEMBER.principlesMd,
      data: Buffer.from(
        renderPrinciples(
          scope,
          archivedPrinciples.map((a, index) => ({
            id: principles[index]?.id ?? index + 1,
            triggerWhen: a.trigger_when,
            rule: a.rule,
            rationale: a.rationale,
            status: a.status,
            isCore: a.is_core,
            strength: a.strength,
            appliedCount: a.applied_count,
            violatedCount: a.violated_count,
            retireReason: a.retire_reason,
          })),
        ),
        'utf8',
      ),
    },
  ];
  const masked = [...ironMasker.report(), ...principleMasker.report(), ...experienceMasker.report()];
  let excluded: ArchiveManifest['excluded'] = [];

  if (teamDir && options.projectDir) {
    if (!existsSync(teamDir) || !lstatSync(teamDir).isDirectory()) throw new ArchiveError(`项目目录下没有 .team/ 目录：${teamDir}`);
    const walk = walkTeam(teamDir);
    excluded = walk.excluded;
    if (walk.files.length > ARCHIVE_LIMITS.maxTeamFiles) {
      throw new ArchiveError(`.team/ 里可打包的文件有 ${walk.files.length} 个，超过 ${ARCHIVE_LIMITS.maxTeamFiles} 个上限；请先清理`);
    }
    const totalBytes = walk.files.reduce((sum, file) => sum + file.data.byteLength, 0);
    if (totalBytes > ARCHIVE_LIMITS.maxTeamTotalBytes) {
      throw new ArchiveError(`.team/ 里可打包的内容合计 ${totalBytes} 字节，超过 ${ARCHIVE_LIMITS.maxTeamTotalBytes} 字节上限`);
    }
    for (const file of walk.files) {
      assertSafeMemberPath(file.path);
      const member = `${MEMBER.teamPrefix}${file.path}`;
      const masker = new Masker(member);
      files.push({ path: member, data: Buffer.from(masker.text(file.data.toString('utf8')), 'utf8') });
      masked.push(...masker.report());
    }
  }

  const mtime = new Date(exportedAt);
  for (const file of files) file.mtime = mtime;
  const sha256: Record<string, string> = {};
  for (const file of files) sha256[file.path] = sha256Hex(file.data);
  const manifest: ArchiveManifest = {
    schema_version: ARCHIVE_SCHEMA_VERSION,
    kind: 'memloom-archive',
    scope,
    project_id: projectScopeId(scope, options.projectId ?? null),
    exported_at: exportedAt,
    generator: GENERATOR,
    counts: { iron_rules: archivedIron.length, principles: archivedPrinciples.length, experiences: archivedExperiences.length, team_files: files.length - 5 },
    sha256,
    masked,
    excluded,
    omitted_references: omittedReferences,
  };
  files.unshift({ path: MEMBER.manifest, data: Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, 'utf8'), mtime });

  const gz = gzipBytes(packTar(files));
  writeFileSync(outPath, gz, { flag: 'wx', mode: 0o600 });
  return {
    outPath,
    bytes: gz.byteLength,
    scope,
    exportedAt,
    counts: manifest.counts,
    masked,
    excluded,
    omittedReferences,
    members: files.map((file) => file.path),
  };
}

/** 来源项目记进 manifest：个人是 null；项目归档就是 scope 里的项目名；角色归档必须由调用方给项目编号（角色备份只回同一个项目）。 */
function projectScopeId(scope: string, given: string | null): string | null {
  const parsed = assertScope(scope);
  if (parsed.kind === 'personal') return null;
  if (parsed.kind === 'project') return parsed.name;
  if (given === null) throw new ArchiveError('导出角色归档必须给项目编号（.team/manifest.json 的 project_id）：角色备份只回同一个项目');
  return given;
}

/** 导出文件名里用的日期：20261127 */
export function archiveDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

/** 归档包的默认文件名（个人：memloom-personal-20261127.tar.gz；项目：memloom-project-<id>-…）。 */
export function defaultArchiveName(scope: string, exportedAt: string): string {
  return `memloom-${scope.replace(':', '-')}-${archiveDate(exportedAt)}.tar.gz`;
}

/** 便于报错和回执里显示的相对路径 */
export function displayPath(path: string, cwd: string = process.cwd()): string {
  const relativePath = relative(cwd, path);
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath;
}
