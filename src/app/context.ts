/**
 * 命令行和 MCP 共用的运行配置：从参数和环境变量算出「用哪个库、哪个作用域、哪个状态目录」。
 * 个人库默认 `~/.memloom/personal.db`（MEMLOOM_HOME 可改）；项目库依据 `<项目>/.team/manifest.json` 的稳定 project_id
 * 和 `<项目>/.team/.mind.db`；角色只在指定了项目时才有意义。测试一律用 --db / --home / --state-dir 指到临时目录。
 * 这里只是读配置，不建目录、不开库（开库在 ops 里，按需才做）。
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertScope, type ParsedScope } from '../core/types.js';

export interface ContextFlags {
  home?: string;
  db?: string;
  project?: string;
  role?: string;
  stateDir?: string;
}

export interface MemloomContext {
  home: string;
  dbPath: string;
  scope: string;
  projectDir: string | null;
  projectId: string | null;
  roleName: string | null;
  /** 共享检索服务的状态目录（socket、锁、日志） */
  stateDir: string;
}

/** 参数写错、缺参数、作用域不匹配这一类「用法问题」：提示怎么改，退出码 1。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;

function readProjectId(manifestPath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new UsageError(`读不了 ${manifestPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const projectId = (parsed as { project_id?: unknown } | null)?.project_id;
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) {
    throw new UsageError(`${manifestPath} 里没有合法的 project_id（1~64 位字母、数字、连字符）；memloom 不改这个文件，请用项目的建队工具修正`);
  }
  return projectId;
}

export function resolveContext(flags: ContextFlags, env: NodeJS.ProcessEnv = process.env): MemloomContext {
  const home = resolve(flags.home ?? env.MEMLOOM_HOME ?? join(homedir(), '.memloom'));
  const stateDir = resolve(flags.stateDir ?? env.MEMLOOM_STATE_DIR ?? home);
  const projectRaw = flags.project ?? env.MEMLOOM_PROJECT ?? null;
  const role = flags.role ?? env.MEMLOOM_ROLE ?? null;
  if (role !== null && !projectRaw) {
    throw new UsageError('角色（--role / MEMLOOM_ROLE）只在指定了项目目录（--project / MEMLOOM_PROJECT）时才有意义');
  }
  if (projectRaw) {
    const projectDir = resolve(projectRaw);
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) throw new UsageError(`项目目录不存在：${projectDir}`);
    const teamDir = join(projectDir, '.team');
    if (existsSync(teamDir) && !lstatSync(teamDir).isDirectory()) {
      throw new UsageError(`「${teamDir}」是符号链接或不是目录，拒绝使用：memloom 不顺着链接读写项目的 .team`);
    }
    const manifestPath = join(teamDir, 'manifest.json');
    if (existsSync(manifestPath) && !lstatSync(manifestPath).isFile()) {
      throw new UsageError(`「${manifestPath}」是符号链接或不是普通文件，拒绝使用`);
    }
    if (!existsSync(manifestPath)) {
      throw new UsageError(`「${projectDir}」不是启用了 .team 的项目目录（缺 .team/manifest.json）；memloom 不会替你建 .team，请先用项目的建队工具初始化`);
    }
    const projectId = readProjectId(manifestPath);
    const scope = role ? `role:${role}` : `project:${projectId}`;
    return { home, dbPath: resolve(flags.db ?? join(projectDir, '.team', '.mind.db')), scope, projectDir, projectId, roleName: role, stateDir };
  }
  const dbPath = resolve(flags.db ?? env.MEMLOOM_DB ?? join(home, 'personal.db'));
  return { home, dbPath, scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir };
}

/**
 * 工具参数里可以带 scope。只允许当前库该管的作用域：个人库只能 personal；
 * 项目库可以是项目本身，或者这个项目下的角色（`role:<名字>`）。别的（另一个项目、或把个人数据塞进项目库）一律拒绝。
 */
export function scopeFor(ctx: MemloomContext, requested: string | undefined | null): string {
  if (requested === undefined || requested === null || requested === '') return ctx.scope;
  const parsed: ParsedScope = assertScope(requested);
  if (ctx.projectDir === null) {
    if (parsed.kind !== 'personal') throw new UsageError(`当前是个人库，只能用 personal 作用域，不能用「${requested}」`);
  } else if (parsed.kind === 'personal') {
    throw new UsageError('当前是项目库，不能在这里用 personal 作用域；个人数据在 ~/.memloom/personal.db，项目数据在 .team/.mind.db，两边不混');
  } else if (parsed.kind === 'project' && parsed.name !== ctx.projectId) {
    throw new UsageError(`「${requested}」不是这个项目（这个项目是 project:${ctx.projectId}）`);
  }
  return parsed.scope;
}
