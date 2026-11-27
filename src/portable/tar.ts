/**
 * 最小 tar 读写（ustar 头）+ gzip 封装，不引入任何第三方依赖。
 *
 * 导出：把内存里的一组纯文本成员写成标准 `.tar.gz`（系统 `tar -tzf` 能原样列出）。
 * 导入：只读普通文件和目录项。符号链接、硬链接、设备、管道、PAX / GNU 扩展头（长文件名、稀疏文件）
 *       一律拒绝——归档是不可信输入，认不全的成员宁可整包拒收，也不猜它是什么。
 *       解压后的总字节数、成员个数、单个成员大小都有上限，在解析过程中逐步生效，不等整个包读完。
 */
import { gzipSync, gunzipSync } from 'node:zlib';

export interface TarFile {
  /** 相对路径，用 `/` 分隔，没有 `..`、没有开头的 `/` */
  path: string;
  data: Uint8Array;
  mode?: number;
  mtime?: Date;
}

export interface TarLimits {
  maxMembers: number;
  maxMemberBytes: number;
  maxTotalBytes: number;
}

export const TAR_DEFAULT_LIMITS: TarLimits = {
  maxMembers: 512,
  maxMemberBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

const BLOCK = 512;
const RECORD = 10_240;
const EMPTY: Uint8Array = new Uint8Array(0);

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarFormatError';
  }
}

/* ====================== 写 ====================== */

function octal(value: number, length: number): string {
  const text = value.toString(8);
  if (text.length > length - 1) throw new TarFormatError(`数值 ${value} 超出了 tar 头里 ${length} 字节的八进制字段`);
  return `${text.padStart(length - 1, '0')}\0`;
}

/** 路径超过 100 字节时按 ustar 的 prefix/name 切开：找一个 `/`，让前缀 ≤ 155 字节、名字 ≤ 100 字节。 */
function splitPath(path: string): { prefix: string; name: string } {
  let cut = -1;
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== '/') continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      cut = index;
      break;
    }
  }
  if (cut < 0) throw new TarFormatError(`成员路径太长，ustar 头放不下：${path}`);
  return { prefix: path.slice(0, cut), name: path.slice(cut + 1) };
}

function byteSum(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) sum += byte;
  return sum;
}

function headerOf(file: TarFile): Buffer {
  const bytes = Buffer.alloc(BLOCK);
  const { prefix, name } = Buffer.byteLength(file.path, 'utf8') > 100 ? splitPath(file.path) : { prefix: '', name: file.path };
  if (Buffer.byteLength(name, 'utf8') > 100) throw new TarFormatError(`成员名字太长：${file.path}`);
  bytes.write(name, 0, 'utf8');
  bytes.write(octal(file.mode ?? 0o644, 8), 100, 'latin1');
  bytes.write(octal(0, 8), 108, 'latin1');
  bytes.write(octal(0, 8), 116, 'latin1');
  bytes.write(octal(file.data.byteLength, 12), 124, 'latin1');
  const seconds = Math.floor((file.mtime ?? new Date(0)).getTime() / 1000);
  bytes.write(octal(seconds < 0 ? 0 : seconds, 12), 136, 'latin1');
  bytes.write('        ', 148, 'latin1');
  bytes.write('0', 156, 'latin1');
  bytes.write('ustar\0', 257, 'latin1');
  bytes.write('00', 263, 'latin1');
  bytes.write('memloom\0', 265, 'latin1');
  bytes.write('memloom\0', 297, 'latin1');
  bytes.write(octal(0, 8), 329, 'latin1');
  bytes.write(octal(0, 8), 337, 'latin1');
  if (prefix) bytes.write(prefix, 345, 'utf8');
  bytes.write(`${byteSum(bytes).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return bytes;
}

/**
 * 成员路径的安全底线（读写共用）：相对路径、`/` 分隔、每一段都非空且不是 `.` 或 `..`、
 * 没有反斜杠、控制字符和 NUL。这样的路径拼到任何目录下都跑不出去。
 */
export function assertSafeMemberPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new TarFormatError('成员路径是空的');
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new TarFormatError(`成员路径里有控制字符、NUL 或反斜杠：${JSON.stringify(path)}`);
  if (path.startsWith('/')) throw new TarFormatError(`成员路径是绝对路径，拒绝：${path}`);
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new TarFormatError(`成员路径里有空的目录名、「.」或「..」，拒绝：${path}`);
    }
  }
  return path;
}

/** 打包：每个成员一个 512 字节头 + 内容 + 补零；结尾至少两个零块，并补到 10240 字节的整数倍。 */
export function packTar(files: readonly TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const file of files) {
    assertSafeMemberPath(file.path);
    const head = headerOf(file);
    const pad = (BLOCK - (file.data.byteLength % BLOCK)) % BLOCK;
    parts.push(head, file.data, pad > 0 ? Buffer.alloc(pad) : EMPTY);
    total += BLOCK + file.data.byteLength + pad;
  }
  let zeros = 2 * BLOCK;
  const remainder = (total + zeros) % RECORD;
  if (remainder !== 0) zeros += RECORD - remainder;
  parts.push(Buffer.alloc(zeros));
  const out = new Uint8Array(total + zeros);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/* ====================== 读 ====================== */

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** 读一个八进制字段：允许两边有空格、结尾是 NUL 或空格；高位 base-256 编码一律拒绝。 */
function readOctal(block: Uint8Array, offset: number, length: number, what: string): number {
  const field = block.subarray(offset, offset + length);
  if ((field[0] ?? 0) & 0x80) throw new TarFormatError(`tar 头里的「${what}」用了 base-256 编码，这种归档不收`);
  let text = '';
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) continue;
    if (byte < 0x30 || byte > 0x37) throw new TarFormatError(`tar 头里的「${what}」不是八进制数字`);
    text += String.fromCharCode(byte);
  }
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new TarFormatError(`tar 头里的「${what}」数值不合法`);
  return value;
}

function verifyChecksum(block: Uint8Array): void {
  const stored = readOctal(block, 148, 8, '校验和');
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new TarFormatError(`tar 头校验和对不上（头里写的是 ${stored}，算出来是 ${unsigned}），文件损坏或被改过`);
  }
}

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

function fieldText(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && end < block.byteLength && block[end] !== 0) end += 1;
  try {
    return UTF8_FATAL.decode(block.subarray(offset, end));
  } catch {
    throw new TarFormatError('tar 头里的路径不是合法的 UTF-8 文本');
  }
}

/** 认 ustar（`ustar\0` + `00`，可用 prefix 字段）和 GNU 旧格式（`ustar ` + ` \0`，不用 prefix）。 */
function readName(block: Uint8Array): string {
  const magic = fieldText(block, 257, 6);
  const version = fieldText(block, 263, 2);
  const name = fieldText(block, 0, 100);
  if (magic === 'ustar' && version === '00') {
    const prefix = fieldText(block, 345, 155);
    return prefix ? `${prefix}/${name}` : name;
  }
  if (magic === 'ustar ' && version === ' ') return name;
  throw new TarFormatError(`不认识的 tar 格式（magic=${JSON.stringify(magic)} version=${JSON.stringify(version)}），只收 ustar 和 GNU tar`);
}

const TYPE_NAMES: Record<string, string> = {
  '1': '硬链接',
  '2': '符号链接',
  '3': '字符设备',
  '4': '块设备',
  '6': '管道',
  K: 'GNU 长链接名扩展',
  L: 'GNU 长文件名扩展',
  S: '稀疏文件',
  g: 'PAX 全局扩展头',
  x: 'PAX 扩展头',
};

/** 解包：边读边校验（校验和、大小、总数、路径、类型、重复成员），任何一处不对就整包拒收。 */
export function unpackTar(tar: Uint8Array, limits: TarLimits = TAR_DEFAULT_LIMITS): TarFile[] {
  const files: TarFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  let ended = false;
  while (offset + BLOCK <= tar.byteLength) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) {
      // 结束标记必须是连续两个零块：只有一个（或后面被截掉）不算完整结尾
      const next = tar.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.byteLength === BLOCK && isZeroBlock(next)) ended = true;
      break;
    }
    verifyChecksum(block);
    const name = readName(block);
    const type = String.fromCharCode(block[156] ?? 0);
    const size = readOctal(block, 124, 12, '大小');
    if (size > limits.maxMemberBytes) {
      throw new TarFormatError(`成员「${name}」声明有 ${size} 字节，超过单个成员上限 ${limits.maxMemberBytes} 字节`);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new TarFormatError(`归档解压后的内容超过 ${limits.maxTotalBytes} 字节上限，拒绝继续读取`);
    }
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) {
      throw new TarFormatError(`成员「${name}」声明的大小超出了归档的实际长度（文件被截断，或者大小造假）`);
    }
    offset = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === '5') {
      if (size !== 0) throw new TarFormatError(`目录项「${name}」却带着 ${size} 字节内容，不收`);
      assertSafeMemberPath(name.endsWith('/') ? name.slice(0, -1) : name);
      continue;
    }
    if (type !== '0' && type !== '\0') {
      throw new TarFormatError(`成员「${name}」不是普通文件（类型标记「${type}」＝${TYPE_NAMES[type] ?? '未知类型'}），这种成员一律不收`);
    }
    const path = assertSafeMemberPath(name);
    if (seen.has(path)) throw new TarFormatError(`成员「${path}」在归档里出现了两次`);
    seen.add(path);
    files.push({ path, data: Buffer.from(tar.subarray(dataStart, dataEnd)), mode: readOctal(block, 100, 8, '权限'), mtime: new Date(readOctal(block, 136, 12, '修改时间') * 1000) });
    if (files.length > limits.maxMembers) {
      throw new TarFormatError(`归档里的成员超过 ${limits.maxMembers} 个上限`);
    }
  }
  if (!ended) throw new TarFormatError('归档结尾不完整：没有读到结束标记（文件被截断，或者根本不是 tar）');
  return files;
}

/* ====================== gzip 封装 ====================== */

export function gzipBytes(data: Uint8Array): Buffer {
  return gzipSync(data, { level: 6 });
}

/** 解压时带输出上限：压缩包炸弹在这里就会被拦下，不会先把内存吃光。 */
export function gunzipBytes(data: Uint8Array, maxOutputBytes: number): Buffer {
  try {
    return gunzipSync(data, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TarFormatError(`解压后的内容超过 ${maxOutputBytes} 字节上限，拒绝继续（防止压缩包炸弹）`);
    }
    throw new TarFormatError(`不是有效的 gzip 数据：${error instanceof Error ? error.message : String(error)}`);
  }
}
