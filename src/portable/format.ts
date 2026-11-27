/**
 * 便携归档的格式定义（架构规格 §7）：成员清单、manifest、记录字段、内容指纹、常见凭据的识别与掩蔽、`.team` 纯文本的取舍规则。
 * 这里只有常量、纯函数和「读入先校验」的形状检查，不碰数据库、不碰文件系统。
 */
import { createHash } from 'node:crypto';

export const ARCHIVE_SCHEMA_VERSION = 1;

/** 固定成员（§7）；项目域另有 `team/` 前缀下的纯文本 */
export const MEMBER = {
  manifest: 'manifest.json',
  ironRules: 'iron_rules.json',
  principles: 'principles.json',
  experiences: 'experiences.jsonl',
  standing: 'readable/STANDING.md',
  principlesMd: 'readable/PRINCIPLES.md',
  teamPrefix: 'team/',
} as const;

export const FIXED_MEMBERS = [MEMBER.manifest, MEMBER.ironRules, MEMBER.principles, MEMBER.experiences, MEMBER.standing, MEMBER.principlesMd] as const;

/** 读入上限：数量、大小都先于任何写入生效 */
export const ARCHIVE_LIMITS = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxUnpackedBytes: 64 * 1024 * 1024,
  maxIronRules: 200,
  maxPrinciples: 2_000,
  maxExperiences: 10_000,
  maxTeamFiles: 200,
  maxTeamFileBytes: 1024 * 1024,
  maxTeamTotalBytes: 8 * 1024 * 1024,
  maxFieldChars: {
    ironContent: 2_000,
    triggerWhen: 400,
    rule: 1_200,
    rationale: 1_000,
    retireReason: 1_000,
    summary: 1_000,
    evidence: 4_000,
    sourceSession: 200,
  },
} as const;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/* ---------- manifest 与记录 ---------- */

export interface ArchiveManifest {
  schema_version: typeof ARCHIVE_SCHEMA_VERSION;
  kind: 'memloom-archive';
  scope: string;
  /** 来源项目：个人归档是 null；项目 / 角色归档是 .team/manifest.json 里的 project_id（角色备份只回同一个项目） */
  project_id: string | null;
  exported_at: string;
  generator: string;
  counts: { iron_rules: number; principles: number; experiences: number; team_files: number };
  /** 每个成员（manifest 自己除外）的 SHA-256，小写十六进制 */
  sha256: Record<string, string>;
  /** 导出时被掩蔽的常见凭据：在哪个成员、哪一类、几处 */
  masked: Array<{ member: string; kind: string; count: number }>;
  /** 导出 `.team` 时被排除的文件和原因 */
  excluded: Array<{ path: string; reason: string }>;
  /** 导出时因为经历没被选进包里而省略掉的引用数（原则的来源经历） */
  omitted_references: number;
}

/** 归档内的记录编号：`iron:<源库编号>`、`p:<源库编号>`、`exp:<源库编号>`；导入时按本次内容翻译成本地编号 */
export type ArchiveRef = string;

export interface ArchivedIronRule {
  ref: ArchiveRef;
  content: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ArchivedPrinciple {
  ref: ArchiveRef;
  trigger_when: string;
  rule: string;
  rationale: string | null;
  status: 'active' | 'merged' | 'superseded' | 'retired';
  is_core: boolean;
  parents: ArchiveRef[];
  sources: ArchiveRef[];
  strength: number;
  applied_count: number;
  violated_count: number;
  retire_reason: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface ArchivedExperience {
  ref: ArchiveRef;
  kind: 'correction' | 'preference' | 'pitfall' | 'decision' | 'fact';
  summary: string;
  evidence: string | null;
  source: string;
  source_session: string | null;
  occurred_at: string;
  created_at: string;
  processed_at: string | null;
  hit_count: number;
  last_hit_at: string | null;
}

export interface ArchivedTeamFile {
  path: string;
  text: string;
}

export interface ParsedArchive {
  manifest: ArchiveManifest;
  ironRules: ArchivedIronRule[];
  principles: ArchivedPrinciple[];
  experiences: ArchivedExperience[];
  teamFiles: ArchivedTeamFile[];
}

/* ---------- 内容指纹 ---------- */

/** 和凝结核心同一套归一化：小写、只留汉字与字母数字；指纹用于「按内容去重」，和编号无关 */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '');
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(normalizeForFingerprint(text), 'utf8').digest('hex');
}

export function principleFingerprint(triggerWhen: string, rule: string): string {
  return fingerprint(`${triggerWhen}\n${rule}`);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/* ---------- 常见凭据：识别与掩蔽 ---------- */

/**
 * 只认这些「格式上能明确判断」的常见凭据。掩蔽成 `[已掩蔽:类型]`。
 * 这不是万能的秘密识别器：不认识的令牌、口令、内部地址都会原样保留，所以导出后仍建议人手目检一眼。
 */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; regex: RegExp }> = [
  { kind: '私钥', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'OpenAI 风格密钥', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'GitHub 令牌', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'AWS 密钥编号', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Slack 令牌', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'Bearer 令牌', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { kind: 'Hugging Face 令牌', regex: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { kind: 'npm 令牌', regex: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: '网址里的账号密码', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/gi },
  {
    kind: '键值形式的密钥',
    regex: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*["'`]?[A-Za-z0-9._~+/=-]{12,}["'`]?/gi,
  },
];

export interface MaskResult {
  text: string;
  hits: Array<{ kind: string; count: number }>;
}

/** 把文本里能明确判断的常见凭据换成占位符，并报告每一类换了几处。 */
export function maskSecrets(text: string): MaskResult {
  let out = text;
  const hits: MaskResult['hits'] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    let count = 0;
    out = out.replace(regex, () => {
      count += 1;
      return `[已掩蔽:${kind}]`;
    });
    if (count > 0) hits.push({ kind, count });
  }
  return { text: out, hits };
}

/* ---------- `.team` 纯文本的取舍 ---------- */

const SECRET_FILE_NAME =
  /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|\.db(-wal|-shm)?$|\.sqlite3?(-wal|-shm)?$|\.sock$|\.onnx$|\.lock$|^\.crew\.lock$|^id_(rsa|ed25519|ecdsa|dsa)$|^credentials|^secrets|^\.npmrc$|^\.netrc$|^\.git-credentials$|^\.htpasswd$|\.log$)/i;
const SECRET_DIR_NAME = /^(\.git|node_modules|models|__pycache__|\.cache)$/;
const TEXT_EXTENSION = /\.(md|json|txt|yaml|yml|csv)$/i;

/** `.team` 下的子目录要不要整个跳过：返回原因或 null。 */
export function teamDirExclusion(name: string): string | null {
  return SECRET_DIR_NAME.test(name) ? `目录「${name}」不打包` : null;
}

/** 这个相对路径的文件要不要带：返回 null 表示可以带，否则返回排除原因（memloom 不改 `.team` 的文件协议，只按保守规则挑纯文本）。 */
export function teamFileExclusion(relPath: string): string | null {
  const parts = relPath.split('/');
  const base = (parts[parts.length - 1] as string).toLowerCase();
  for (const part of parts.slice(0, -1)) {
    if (SECRET_DIR_NAME.test(part)) return `目录「${part}」不打包`;
  }
  if (SECRET_FILE_NAME.test(base)) return `文件名像凭据、数据库、锁或模型（${base}），不打包`;
  if (base === 'manifest.json') return null;
  if (!TEXT_EXTENSION.test(base)) return '不是纯文本文件（只收 .md / .json / .txt / .yaml / .yml / .csv）';
  return null;
}

/** 文本内容的底线：必须是能原样读回来的 UTF-8，且没有 NUL 字节。 */
export function looksLikePlainText(data: Uint8Array): string | null {
  if (data.includes(0)) return '内容里有 NUL 字节，不是纯文本';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return null;
  } catch {
    return '不是合法的 UTF-8 文本';
  }
}

/* ---------- 形状校验（导入前，全部通过才开始写） ---------- */

type Shape = { key: string; type: 'string' | 'bool' | 'number' | 'ref' | 'refs' | 'iso' | 'iso?' | 'string?' | 'enum' | 'any'; values?: readonly string[] };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const REF = /^(iron|p|exp):[1-9]\d*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkIso(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ArchiveError(`${where} 的时间不是 ISO-8601 写法：${String(value)}`);
  }
  return value;
}

function checkShape(raw: unknown, where: string, shape: readonly Shape[]): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new ArchiveError(`${where} 不是对象`);
  const out: Record<string, unknown> = {};
  const allowed = new Set(shape.map((field) => field.key));
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ArchiveError(`${where} 多了不认识的字段「${key}」`);
  }
  for (const field of shape) {
    const value = raw[field.key];
    const label = `${where} 的「${field.key}」`;
    if (field.type === 'string?' || field.type === 'iso?') {
      if (value === null || value === undefined) {
        out[field.key] = null;
        continue;
      }
    }
    switch (field.type) {
      case 'string':
      case 'string?':
        if (typeof value !== 'string') throw new ArchiveError(`${label} 必须是文字`);
        out[field.key] = value;
        break;
      case 'bool':
        if (typeof value !== 'boolean') throw new ArchiveError(`${label} 必须是 true 或 false`);
        out[field.key] = value;
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ArchiveError(`${label} 必须是不小于 0 的数字`);
        out[field.key] = value;
        break;
      case 'ref':
        if (typeof value !== 'string' || !REF.test(value)) throw new ArchiveError(`${label} 不是合法的归档编号：${String(value)}`);
        out[field.key] = value;
        break;
      case 'refs':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !REF.test(item))) {
          throw new ArchiveError(`${label} 必须是归档编号数组`);
        }
        out[field.key] = value as string[];
        break;
      case 'iso':
      case 'iso?':
        out[field.key] = checkIso(value, label);
        break;
      case 'enum':
        if (typeof value !== 'string' || !(field.values as readonly string[]).includes(value)) {
          throw new ArchiveError(`${label} 只能是 ${(field.values as readonly string[]).join(' / ')}：${String(value)}`);
        }
        out[field.key] = value;
        break;
      case 'any':
        if (value === undefined) throw new ArchiveError(`${label} 缺失`);
        out[field.key] = value;
        break;
    }
  }
  return out;
}

function nonEmpty(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new ArchiveError(`${label} 必须是文字`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ArchiveError(`${label} 不能为空`);
  if (trimmed.length > max) throw new ArchiveError(`${label} 超过 ${max} 字`);
  if (trimmed.includes('\u0000')) throw new ArchiveError(`${label} 里有 NUL 字符`);
  return trimmed;
}

function parseJson(text: string, member: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArchiveError(`成员「${member}」不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonl(text: string, member: string): unknown[] {
  const lines = text.split('\n');
  const out: unknown[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new ArchiveError(`成员「${member}」第 ${index + 1} 行不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return out;
}

function manifestScopeKind(scope: string): 'personal' | 'project' | 'role' | null {
  if (scope === 'personal') return 'personal';
  if (/^project:[^\s:]+$/.test(scope)) return 'project';
  if (/^role:[^\s:]+$/.test(scope)) return 'role';
  return null;
}

/** manifest 自身的形状 */
export function validateManifest(raw: unknown): ArchiveManifest {
  const shape = checkShape(raw, 'manifest.json', [
    { key: 'schema_version', type: 'number' },
    { key: 'kind', type: 'enum', values: ['memloom-archive'] },
    { key: 'scope', type: 'string' },
    { key: 'exported_at', type: 'iso' },
    { key: 'generator', type: 'string' },
    { key: 'counts', type: 'any' },
    { key: 'sha256', type: 'any' },
    { key: 'masked', type: 'any' },
    { key: 'excluded', type: 'any' },
    { key: 'omitted_references', type: 'number' },
    { key: 'project_id', type: 'any' },
  ]);
  if (shape.schema_version !== ARCHIVE_SCHEMA_VERSION) {
    throw new ArchiveError(`归档的 schema_version 是 ${String(shape.schema_version)}，这里只认 ${ARCHIVE_SCHEMA_VERSION}`);
  }
  const counts = checkShape(shape.counts, 'manifest.json 的 counts', [
    { key: 'iron_rules', type: 'number' },
    { key: 'principles', type: 'number' },
    { key: 'experiences', type: 'number' },
    { key: 'team_files', type: 'number' },
  ]);
  if (!isPlainObject(shape.sha256)) throw new ArchiveError('manifest.json 的 sha256 必须是对象');
  const sha256: Record<string, string> = {};
  for (const [key, value] of Object.entries(shape.sha256)) {
    if (!/^[0-9a-f]{64}$/.test(String(value))) throw new ArchiveError(`manifest.json 里成员「${key}」的 sha256 不是 64 位小写十六进制`);
    sha256[key] = String(value);
  }
  for (const key of ['masked', 'excluded']) {
    if (!Array.isArray(shape[key])) throw new ArchiveError(`manifest.json 的 ${key} 必须是数组`);
  }
  const masked = (shape.masked as unknown[]).map((item) => {
    const row = checkShape(item, 'manifest.json 的 masked', [
      { key: 'member', type: 'string' },
      { key: 'kind', type: 'string' },
      { key: 'count', type: 'number' },
    ]);
    return { member: String(row.member), kind: String(row.kind), count: Number(row.count) };
  });
  const excluded = (shape.excluded as unknown[]).map((item) => {
    const row = checkShape(item, 'manifest.json 的 excluded', [
      { key: 'path', type: 'string' },
      { key: 'reason', type: 'string' },
    ]);
    return { path: String(row.path), reason: String(row.reason) };
  });
  // 来源项目：个人归档必须是 null；项目归档必须等于 scope 里的项目名；角色归档必须带项目编号（导入时再和目标项目比对）
  const rawProjectId = shape.project_id;
  if (rawProjectId !== null && (typeof rawProjectId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(rawProjectId))) {
    throw new ArchiveError('manifest.json 的 project_id 要么是 null（个人归档），要么是 1~64 位字母、数字、连字符的项目编号');
  }
  const checkedProjectId: string | null = rawProjectId as string | null;
  const scopeKind = manifestScopeKind(String(shape.scope));
  if (scopeKind === 'personal' && checkedProjectId !== null) throw new ArchiveError('个人归档的 project_id 必须是 null');
  if (scopeKind === 'project' && checkedProjectId !== String(shape.scope).slice('project:'.length)) throw new ArchiveError('项目归档的 project_id 必须和 scope 里的项目名一致');
  if (scopeKind === 'role' && checkedProjectId === null) throw new ArchiveError('角色归档必须带来源项目编号 project_id');
  if (scopeKind === null) throw new ArchiveError(`manifest.json 的 scope 写法不正确：${String(shape.scope)}`);
  return {
    schema_version: ARCHIVE_SCHEMA_VERSION,
    kind: 'memloom-archive',
    scope: String(shape.scope),
    exported_at: String(shape.exported_at),
    generator: String(shape.generator),
    counts: { iron_rules: Number(counts.iron_rules), principles: Number(counts.principles), experiences: Number(counts.experiences), team_files: Number(counts.team_files) },
    sha256,
    masked,
    excluded,
    omitted_references: Number(shape.omitted_references),
    project_id: checkedProjectId,
  };
}

const IRON_SHAPE: readonly Shape[] = [
  { key: 'ref', type: 'ref' },
  { key: 'content', type: 'string' },
  { key: 'active', type: 'bool' },
  { key: 'created_at', type: 'iso' },
  { key: 'updated_at', type: 'iso' },
];

const PRINCIPLE_SHAPE: readonly Shape[] = [
  { key: 'ref', type: 'ref' },
  { key: 'trigger_when', type: 'string' },
  { key: 'rule', type: 'string' },
  { key: 'rationale', type: 'string?' },
  { key: 'status', type: 'enum', values: ['active', 'merged', 'superseded', 'retired'] },
  { key: 'is_core', type: 'bool' },
  { key: 'parents', type: 'refs' },
  { key: 'sources', type: 'refs' },
  { key: 'strength', type: 'number' },
  { key: 'applied_count', type: 'number' },
  { key: 'violated_count', type: 'number' },
  { key: 'retire_reason', type: 'string?' },
  { key: 'created_at', type: 'iso' },
  { key: 'updated_at', type: 'iso' },
  { key: 'last_used_at', type: 'iso?' },
];

const EXPERIENCE_SHAPE: readonly Shape[] = [
  { key: 'ref', type: 'ref' },
  { key: 'kind', type: 'enum', values: ['correction', 'preference', 'pitfall', 'decision', 'fact'] },
  { key: 'summary', type: 'string' },
  { key: 'evidence', type: 'string?' },
  { key: 'source', type: 'string' },
  { key: 'source_session', type: 'string?' },
  { key: 'occurred_at', type: 'iso' },
  { key: 'created_at', type: 'iso' },
  { key: 'processed_at', type: 'iso?' },
  { key: 'hit_count', type: 'number' },
  { key: 'last_hit_at', type: 'iso?' },
];

const EXPERIENCE_SOURCES = ['review', 'correction', 'flush', 'manual', 'import'] as const;

export function validateIronRules(raw: unknown): ArchivedIronRule[] {
  if (!Array.isArray(raw)) throw new ArchiveError('iron_rules.json 必须是数组');
  if (raw.length > ARCHIVE_LIMITS.maxIronRules) throw new ArchiveError(`铁律超过 ${ARCHIVE_LIMITS.maxIronRules} 条上限`);
  return raw.map((item, index) => {
    const row = checkShape(item, `iron_rules.json 第 ${index + 1} 条`, IRON_SHAPE);
    if (!String(row.ref).startsWith('iron:')) throw new ArchiveError(`iron_rules.json 第 ${index + 1} 条的编号必须是 iron: 开头`);
    return {
      ref: String(row.ref),
      content: nonEmpty(row.content, ARCHIVE_LIMITS.maxFieldChars.ironContent, `iron_rules.json 第 ${index + 1} 条的正文`),
      active: Boolean(row.active),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  });
}

export function validatePrinciples(raw: unknown): ArchivedPrinciple[] {
  if (!Array.isArray(raw)) throw new ArchiveError('principles.json 必须是数组');
  if (raw.length > ARCHIVE_LIMITS.maxPrinciples) throw new ArchiveError(`原则超过 ${ARCHIVE_LIMITS.maxPrinciples} 条上限`);
  const limits = ARCHIVE_LIMITS.maxFieldChars;
  return raw.map((item, index) => {
    const where = `principles.json 第 ${index + 1} 条`;
    const row = checkShape(item, where, PRINCIPLE_SHAPE);
    if (!String(row.ref).startsWith('p:')) throw new ArchiveError(`${where} 的编号必须是 p: 开头`);
    for (const ref of row.parents as string[]) if (!ref.startsWith('p:')) throw new ArchiveError(`${where} 的 parents 里只能放原则编号`);
    for (const ref of row.sources as string[]) if (!ref.startsWith('exp:')) throw new ArchiveError(`${where} 的 sources 里只能放经历编号`);
    const rationale = row.rationale === null ? null : nonEmpty(row.rationale, limits.rationale, `${where} 的 rationale`);
    const retireReason = row.retire_reason === null ? null : nonEmpty(row.retire_reason, limits.retireReason, `${where} 的 retire_reason`);
    return {
      ref: String(row.ref),
      trigger_when: nonEmpty(row.trigger_when, limits.triggerWhen, `${where} 的 trigger_when`),
      rule: nonEmpty(row.rule, limits.rule, `${where} 的 rule`),
      rationale,
      status: row.status as ArchivedPrinciple['status'],
      is_core: Boolean(row.is_core),
      parents: row.parents as string[],
      sources: row.sources as string[],
      strength: Number(row.strength),
      applied_count: Number(row.applied_count),
      violated_count: Number(row.violated_count),
      retire_reason: retireReason,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_used_at: row.last_used_at as string | null,
    };
  });
}

export function validateExperiences(raw: unknown): ArchivedExperience[] {
  if (!Array.isArray(raw)) throw new ArchiveError('experiences.jsonl 必须按行解析成数组');
  if (raw.length > ARCHIVE_LIMITS.maxExperiences) throw new ArchiveError(`经历超过 ${ARCHIVE_LIMITS.maxExperiences} 条上限`);
  const limits = ARCHIVE_LIMITS.maxFieldChars;
  return raw.map((item, index) => {
    const where = `experiences.jsonl 第 ${index + 1} 条`;
    const row = checkShape(item, where, EXPERIENCE_SHAPE);
    if (!String(row.ref).startsWith('exp:')) throw new ArchiveError(`${where} 的编号必须是 exp: 开头`);
    if (!(EXPERIENCE_SOURCES as readonly string[]).includes(String(row.source))) {
      throw new ArchiveError(`${where} 的 source 只能是 ${EXPERIENCE_SOURCES.join(' / ')}`);
    }
    const evidence = row.evidence === null ? null : nonEmpty(row.evidence, limits.evidence, `${where} 的 evidence`);
    const session = row.source_session === null ? null : nonEmpty(row.source_session, limits.sourceSession, `${where} 的 source_session`);
    return {
      ref: String(row.ref),
      kind: row.kind as ArchivedExperience['kind'],
      summary: nonEmpty(row.summary, limits.summary, `${where} 的 summary`),
      evidence,
      source: String(row.source),
      source_session: session,
      occurred_at: String(row.occurred_at),
      created_at: String(row.created_at),
      processed_at: row.processed_at as string | null,
      hit_count: Number(row.hit_count),
      last_hit_at: row.last_hit_at as string | null,
    };
  });
}

export function parseIronRules(text: string): ArchivedIronRule[] {
  return validateIronRules(parseJson(text, MEMBER.ironRules));
}

export function parsePrinciples(text: string): ArchivedPrinciple[] {
  return validatePrinciples(parseJson(text, MEMBER.principles));
}

export function parseExperiences(text: string): ArchivedExperience[] {
  return validateExperiences(parseJsonl(text, MEMBER.experiences));
}
