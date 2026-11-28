/**
 * 默认环境配置文件读取：优先遵循 XDG 约定（$XDG_CONFIG_HOME/memloom/env，默认 ~/.config/memloom/env），
 * 也允许用 MEMLOOM_ENV_FILE 指定别的路径，或用 MEMLOOM_NO_ENV_FILE=1 关闭自动读取（例如离线测试）。
 *
 * 边界与安全：
 * - 外部已经传入的环境变量永远优先于文件（含显式传空串覆盖）；
 * - 只读普通文件，遇到符号链接或非普通文件直接拒绝；
 * - 只接受 MEMLOOM_* 和 HF_ENDPOINT，绝不导入 PATH / NODE_OPTIONS 这类进程级变量；
 * - 凭据值只进内存里的 env 对象，不写入任何日志或回执。
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from './context.js';

const ALLOWED_KEY = /^(?:MEMLOOM_[A-Z0-9_]+|HF_ENDPOINT)$/;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvFileStatus {
  path: string | null;
  loaded: boolean;
  disabled: boolean;
  keys: number;
}

/** 默认配置文件路径：$XDG_CONFIG_HOME/memloom/env 或 ~/.config/memloom/env */
export function defaultEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? resolve(xdg) : join(homedir(), '.config');
  return join(base, 'memloom', 'env');
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\([nrt"\\])/g, (_all, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case '"':
          return '"';
        case '\\':
          return '\\';
        default:
          return ch;
      }
    });
  }
  // 没加引号的值：去掉「空白 + #」后面的行尾注释
  const comment = /\s+#/.exec(trimmed);
  return (comment ? trimmed.slice(0, comment.index) : trimmed).trim();
}

/** 解析常见的 .env / export 写法；只保留 MEMLOOM_* 与 HF_ENDPOINT，忽略其它键。 */
export function parseEnvText(text: string, sourceLabel = '环境配置文件'): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') || line.startsWith('export\t') ? line.slice(6).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      throw new UsageError(`${sourceLabel}第 ${i + 1} 行格式不对（需要 KEY=VALUE）`);
    }
    const key = body.slice(0, eq).trim();
    if (!KEY_NAME.test(key)) {
      throw new UsageError(`${sourceLabel}第 ${i + 1} 行的变量名不合法：${key}`);
    }
    if (!ALLOWED_KEY.test(key)) continue;
    result[key] = unquote(body.slice(eq + 1));
  }
  return result;
}

/**
 * 合并进程环境与默认配置文件，返回一个新的 env 对象（不改动原对象）。
 * 规则：进程里已经存在的变量永远赢；默认文件不存在时安静跳过；显式 MEMLOOM_ENV_FILE 不存在或文件是符号链接时直接报错。
 */
export function loadMemloomEnv(baseEnv: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; file: EnvFileStatus } {
  if (baseEnv.MEMLOOM_NO_ENV_FILE?.trim() === '1') {
    return { env: { ...baseEnv }, file: { path: null, loaded: false, disabled: true, keys: 0 } };
  }
  const explicit = baseEnv.MEMLOOM_ENV_FILE?.trim() ?? '';
  const filePath = explicit !== '' ? resolve(explicit) : defaultEnvFilePath(baseEnv);
  if (!existsSync(filePath)) {
    if (explicit !== '') throw new UsageError(`指定的环境配置文件不存在：${filePath}`);
    return { env: { ...baseEnv }, file: { path: filePath, loaded: false, disabled: false, keys: 0 } };
  }
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new UsageError(`环境配置文件「${filePath}」是符号链接或不是普通文件，拒绝读取`);
  }
  const parsed = parseEnvText(readFileSync(filePath, 'utf8'), `环境配置文件 ${filePath} `);
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  let applied = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (baseEnv[key] === undefined) {
      merged[key] = value;
      applied += 1;
    }
  }
  return { env: merged, file: { path: filePath, loaded: true, disabled: false, keys: applied } };
}

export function resolveMemloomEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return loadMemloomEnv(baseEnv).env;
}
