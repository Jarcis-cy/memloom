/**
 * 和 agent-crew 的单向联动（两仓单向联动的约定见 docs/HOST-CONTRACT.md）：
 * - 项目 / 角色作用域只认显式给出的、已建队的项目目录（`.team/manifest.json` 的 project_id）和已经存在的角色；
 * - CRAFT 是从 SQLite 出发的单向投影：只改 `<!-- memloom:craft:start/end -->` 之间，区外字节原样，手写条目保留，整份 ≤ 40 条；
 * - BRIEF.md 只由 agent-crew 自己的 `crew brief --write` 渲染，这里只在用户显式给了可信 CLI 路径时用参数数组去调它。
 * 这里绝不从 Markdown 反写数据库，绝不读写别的项目，绝不从项目目录里找可执行程序。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveContext, UsageError } from '../app/context.js';
import { resolveMemloomEnv } from '../app/env.js';
import { llmConfigFromEnv } from '../app/llm.js';
import { retrieverConfigFromEnv, type RetrieverConfig } from '../retriever/index.js';
import type { Store } from '../core/store.js';
import { parseScope } from '../core/types.js';
import { HINT_OPTION_DEFAULTS, type HostConfig, type HostFlags } from './types.js';

export const CRAFT_START = '<!-- memloom:craft:start -->';
export const CRAFT_END = '<!-- memloom:craft:end -->';
/** agent-crew 的硬上限：整份 CRAFT.md（手写 + 生成）的顶格列表项不超过 40 条 */
export const CRAFT_HARD_LIMIT = 40;
const LIST_LINE = /^[-*+]\s+\S/;
const BRIEF_TIMEOUT_MS = 30_000;

/** 只读校验：这一级必须是普通目录（不是链接）。返回 false 表示不存在，抛错表示形态不对。 */
function assertRealDir(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new UsageError(`「${path}」是符号链接，拒绝在它下面读写 ${label}`);
  if (!stats.isDirectory()) throw new UsageError(`「${path}」不是目录，拒绝使用`);
  return true;
}

function assertRealFile(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new UsageError(`「${path}」是符号链接，拒绝把它当 ${label}`);
  if (!stats.isFile()) throw new UsageError(`「${path}」不是普通文件，拒绝把它当 ${label}`);
  return true;
}

/** 角色必须真的存在：`.team/roles/<slug>/ROLE.md` 是普通文件，沿途没有链接。 */
export function assertCrewRole(projectDir: string, role: string): void {
  const team = join(projectDir, '.team');
  assertRealDir(team, '.team');
  const roles = join(team, 'roles');
  if (!assertRealDir(roles, 'roles/')) throw new UsageError(`项目「${projectDir}」里还没有任何角色（.team/roles 不存在）；角色 ${role} 不存在，请先用项目的建队工具 role add`);
  const roleDir = join(roles, role);
  if (!assertRealDir(roleDir, `roles/${role}/`)) throw new UsageError(`项目「${projectDir}」里没有角色「${role}」；memloom 不替项目建角色，请先用项目的建队工具 role add`);
  if (!assertRealFile(join(roleDir, 'ROLE.md'), `roles/${role}/ROLE.md`)) throw new UsageError(`角色目录「${role}」里没有 ROLE.md，不算已存在的角色`);
}

/**
 * 宿主配置：沿用命令行同一套（MEMLOOM_HOME / MEMLOOM_DB / MEMLOOM_PROJECT / MEMLOOM_ROLE / 检索 / 后台模型），
 * 再加提醒预算、预热开关、可信 agent-crew CLI 路径。项目 / 角色必须显式给出；不从 cwd 猜。
 */
export function resolveHostConfig(flags: HostFlags, rawEnv: NodeJS.ProcessEnv = process.env): HostConfig {
  const env = resolveMemloomEnv(rawEnv);
  const ctx = resolveContext(flags, env);
  if (ctx.roleName !== null && ctx.projectDir !== null) assertCrewRole(ctx.projectDir, ctx.roleName);
  const budget = Number(env.MEMLOOM_HINT_BUDGET_MS);
  const threshold = Number(env.MEMLOOM_HINT_THRESHOLD);
  const crewCliPath = env.MEMLOOM_CREW_CLI?.trim() || null;
  const config: HostConfig = {
    home: ctx.home,
    dbPath: ctx.dbPath,
    scope: ctx.scope,
    projectDir: ctx.projectDir,
    projectId: ctx.projectId,
    roleName: ctx.roleName,
    stateDir: ctx.stateDir,
    llm: llmConfigFromEnv(env),
    retrieverConfig: withHintBudget(retrieverConfigFromEnv({ ...env, MEMLOOM_STATE_DIR: env.MEMLOOM_STATE_DIR ?? ctx.stateDir }), Number.isFinite(budget) && budget > 0 ? budget : HINT_OPTION_DEFAULTS.budgetMs),
    hint: {
      budgetMs: Number.isFinite(budget) && budget > 0 ? budget : HINT_OPTION_DEFAULTS.budgetMs,
      threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : HINT_OPTION_DEFAULTS.threshold,
    },
    warmupOnStart: env.MEMLOOM_WARMUP?.trim() !== '0',
    crewCliPath,
  };
  if (crewCliPath !== null) config.crewCliPath = trustedCrewCli(crewCliPath).path;
  return config;
}

/** 把本地检索客户端的单次请求上限压到前台预算，超时后它自己会收尾，不占着服务。 */
function withHintBudget(config: RetrieverConfig, budgetMs: number): RetrieverConfig {
  switch (config.mode) {
    case 'local-onnx':
      return { ...config, requestTimeoutMs: budgetMs };
    case 'auto':
      return { ...config, local: { ...(config.local ?? {}), requestTimeoutMs: budgetMs } };
    default:
      return config;
  }
}

/** 可信 CLI 路径的门槛：绝对路径 + 存在的普通文件 + 脚本后缀；不满足就当没配置，如实提示手动刷新。 */
export function trustedCrewCli(path: string): { path: string } | { path: null; reason: string } {
  if (!isAbsolute(path)) return { path: null, reason: 'MEMLOOM_CREW_CLI 必须是绝对路径' };
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { path: null, reason: `MEMLOOM_CREW_CLI 指向的文件不存在：${path}` };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return { path: null, reason: `MEMLOOM_CREW_CLI 必须是普通文件（不能是链接）：${path}` };
  if (!/\.(?:mjs|cjs|js)$/i.test(path)) return { path: null, reason: `MEMLOOM_CREW_CLI 必须是 agent-crew 的 crew.mjs 脚本：${path}` };
  return { path };
}

/* ---------- CRAFT 单向投影 ---------- */

export function countCraft(text: string): number {
  return text.split(/\r?\n/).filter((line) => LIST_LINE.test(line)).length;
}

export interface CraftTarget {
  path: string;
  scope: string;
}

/** 目标文件：项目 → `.team/CRAFT.md`，角色 → `.team/roles/<slug>/CRAFT.md`；沿途任何链接或错误形态都拒绝。 */
export function craftTarget(projectDir: string, scope: string): CraftTarget {
  const parsed = parseScope(scope);
  if (!parsed || parsed.kind === 'personal') throw new UsageError(`只有项目 / 角色作用域才有 CRAFT 投影，收到的是「${scope}」`);
  const team = join(projectDir, '.team');
  if (!assertRealDir(team, '.team')) throw new UsageError(`项目目录「${projectDir}」里没有 .team，不是已建队的项目`);
  if (parsed.kind === 'role') {
    assertCrewRole(projectDir, parsed.name);
    const path = join(team, 'roles', parsed.name, 'CRAFT.md');
    assertRealFile(path, `roles/${parsed.name}/CRAFT.md`);
    return { path, scope };
  }
  const path = join(team, 'CRAFT.md');
  assertRealFile(path, '.team/CRAFT.md');
  return { path, scope };
}

export interface CraftReport {
  path: string;
  scope: string;
  status: 'ok' | 'unchanged' | 'skipped';
  /** 写进管理区的条数 */
  written: number;
  /** 因为整份 40 条上限没写的条数（少写，不截句） */
  omitted: number;
  handwritten: number;
  created: boolean;
  note: string | null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 把当前作用域的生效原则投到 CRAFT.md 的管理区（常驻核心优先、强度降序）。
 * 区外字节原样（含行尾风格）；手写条目保留；手写 + 生成 ≤ 40 条，放不下就少写并在回执里说明。
 */
export function projectCraft(input: { projectDir: string; store: Store; scope: string }): CraftReport {
  const target = craftTarget(input.projectDir, input.scope);
  const exists = existsSync(target.path);
  let before = '';
  let after = '';
  let eol = '\n';
  if (exists) {
    const text = readFileSync(target.path, 'utf8');
    eol = text.includes('\r\n') ? '\r\n' : '\n';
    const start = text.indexOf(CRAFT_START);
    const end = text.indexOf(CRAFT_END);
    if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
      throw new UsageError(`「${target.path}」里的 memloom 管理标记不成对，拒绝改写；请手工把 ${CRAFT_START} 和 ${CRAFT_END} 配成一对`);
    }
    if (start >= 0) {
      before = text.slice(0, start);
      after = text.slice(end + CRAFT_END.length);
    } else {
      // 第一次接管：管理区放在文件末尾，原有内容一个字节不动
      before = text.endsWith('\n') ? text : `${text}\n`;
      after = '';
    }
  }
  const handwritten = countCraft(before) + countCraft(after);
  const candidates = input.store
    .listPrinciples(input.scope, { status: 'active' })
    .sort((a, b) => Number(b.isCore) - Number(a.isCore) || b.strength - a.strength || a.id - b.id)
    .map((p) => `- ★ ${oneLine(p.triggerWhen)}：${oneLine(p.rule)}`);
  const allowed = Math.max(0, CRAFT_HARD_LIMIT - handwritten);
  const written = candidates.slice(0, allowed);
  const omitted = candidates.length - written.length;
  if (!exists && written.length === 0) {
    return { path: target.path, scope: input.scope, status: 'skipped', written: 0, omitted: 0, handwritten, created: false, note: '这个作用域还没有生效原则，没有建 CRAFT.md' };
  }
  const block = [CRAFT_START, ...written, CRAFT_END].join(eol);
  const head = exists ? '' : `# 手艺（${input.scope}）${eol}${eol}`;
  const next = `${head}${before}${block}${after}`;
  if (exists && next === readFileSync(target.path, 'utf8')) {
    return { path: target.path, scope: input.scope, status: 'unchanged', written: written.length, omitted, handwritten, created: false, note: null };
  }
  // 先写同目录临时文件再改名，中途失败不留半截；沿用原文件权限（新建 0644）
  const tmp = `${target.path}.${process.pid}.memloom.tmp`;
  const fd = openSync(tmp, 'wx', exists ? statSync(target.path).mode & 0o777 : 0o644);
  try {
    writeFileSync(fd, next);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target.path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 没写成就算了
    }
    throw error;
  }
  return {
    path: target.path,
    scope: input.scope,
    status: 'ok',
    written: written.length,
    omitted,
    handwritten,
    created: !exists,
    note: omitted > 0 ? `整份 CRAFT 最多 ${CRAFT_HARD_LIMIT} 条（手写 ${handwritten} 条），这次少写了 ${omitted} 条；要放进来请先淘汰或合并旧条目` : null,
  };
}

/* ---------- BRIEF 刷新：只调 agent-crew 自己的命令 ---------- */

export interface BriefReport {
  status: 'ok' | 'failed' | 'manual';
  code: number | null;
  note: string;
  manual: string;
}

/** 只认显式给出的可信 CLI：Node 参数数组、不经 shell、不读项目归档里的命令；没有路径就如实说手动。 */
export async function refreshBrief(input: { crewCliPath: string | null; projectDir: string; timeoutMs?: number }): Promise<BriefReport> {
  const manual = `手动刷新速览：node <agent-crew>/scripts/crew.mjs brief --project ${input.projectDir} --write`;
  if (!input.crewCliPath) {
    return { status: 'manual', code: null, note: '没有配置可信的 agent-crew CLI（MEMLOOM_CREW_CLI），memloom 不自己渲染 BRIEF.md', manual };
  }
  const trusted = trustedCrewCli(input.crewCliPath);
  if (!('path' in trusted) || trusted.path === null) return { status: 'manual', code: null, note: trusted.reason, manual };
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(process.execPath, [trusted.path, 'brief', '--project', input.projectDir, '--write'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: input.timeoutMs ?? BRIEF_TIMEOUT_MS });
    } catch (error) {
      resolve({ status: 'failed', code: null, note: `拉不起 agent-crew CLI：${error instanceof Error ? error.message : String(error)}`, manual });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 4_000) out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < 4_000) err += chunk.toString('utf8');
    });
    child.once('error', (error) => resolve({ status: 'failed', code: null, note: `拉不起 agent-crew CLI：${error.message}`, manual }));
    child.once('close', (code) => {
      if (code === 0) resolve({ status: 'ok', code, note: out.trim().split(/\r?\n/).slice(-3).join('；') || 'crew brief --write 已刷新 .team/BRIEF.md', manual });
      else resolve({ status: 'failed', code, note: `crew brief --write 退出码 ${String(code)}：${err.trim().slice(0, 400) || out.trim().slice(0, 400)}`, manual });
    });
  });
}
