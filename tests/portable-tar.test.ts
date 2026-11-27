import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { assertSafeMemberPath, gunzipBytes, gzipBytes, packTar, TarFormatError, unpackTar, type TarFile } from '../src/portable/tar.js';

/**
 * tar / gzip 往返与不可信输入的边界（单元防御性验证，不是攻击流程）：
 * 自己写的包系统 tar 能原样列出和解开；系统 tar 写的 ustar / GNU 包自己能读；
 * 路径穿越、绝对路径、链接、重复成员、校验和被改、截断、压缩包炸弹、超限，都在读到那一步就拒绝。
 */

const text = (value: string): Buffer => Buffer.from(value, 'utf8');
const utf8 = (data: Uint8Array): string => Buffer.from(data).toString('utf8');

function roundTrip(files: TarFile[]): TarFile[] {
  return unpackTar(gunzipBytes(gzipBytes(packTar(files)), 64 * 1024 * 1024));
}

/** 手写一个 tar 成员头（测试里用来造 packTar 故意写不出来的东西：链接、`..`、绝对路径）。 */
function forgeMember(name: string, typeflag: string, content = '', claimedSize = -1): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write(`${(claimedSize >= 0 ? claimedSize : Buffer.byteLength(content)).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write('00000000000\0', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write(typeflag, 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const body = text(content);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function rawTar(members: Buffer[]): Buffer {
  const out = Buffer.concat([...members, Buffer.alloc(1024)]);
  const remainder = out.length % 10_240;
  return remainder === 0 ? out : Buffer.concat([out, Buffer.alloc(10_240 - remainder)]);
}

test('tar 往返：自己打包自己解包一致，系统 tar 能原样列出并解出同样的内容（含长路径和中文路径）', () => {
  const longPath = `readable/${'a'.repeat(60)}/${'b'.repeat(60)}/笔记.md`;
  const files: TarFile[] = [
    { path: 'manifest.json', data: text('{"a":1}\n'), mtime: new Date('2026-11-27T10:00:00.000Z') },
    { path: longPath, data: text('中文内容\n第二行\n'), mtime: new Date('2026-11-27T10:00:00.000Z') },
    { path: 'team/manifest.json', data: text('{"project_id":"p-1"}\n'), mtime: new Date('2026-11-27T10:00:00.000Z') },
    { path: 'empty.txt', data: new Uint8Array(0), mtime: new Date('2026-11-27T10:00:00.000Z') },
  ];
  const back = roundTrip(files);
  assert.deepEqual(back.map((f) => f.path), files.map((f) => f.path));
  for (const file of files) assert.equal(utf8(back.find((f) => f.path === file.path)?.data ?? new Uint8Array()), utf8(file.data));
  assert.equal(back[0]?.mtime?.toISOString(), '2026-11-27T10:00:00.000Z');

  const root = mkdtempSync(join(tmpdir(), 'memloom-tar-'));
  try {
    const archive = join(root, 'a.tar.gz');
    writeFileSync(archive, gzipBytes(packTar(files)));
    const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listed, files.map((f) => f.path));
    execFileSync('tar', ['-xzf', archive, '-C', root]);
    for (const file of files) {
      assert.equal(readFileSync(join(root, file.path), 'utf8'), utf8(file.data));
    }
    assert.equal(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).includes('ustar'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('系统 tar 打的包（ustar 和 GNU 默认格式，带目录项）自己也能读', () => {
  const root = mkdtempSync(join(tmpdir(), 'memloom-tar-sys-'));
  try {
    const src = join(root, 'src');
    execFileSync('mkdir', ['-p', join(src, 'readable'), join(src, 'team', 'roles')]);
    writeFileSync(join(src, 'manifest.json'), '{"ok":true}\n');
    writeFileSync(join(src, 'readable', 'STANDING.md'), '# 铁律\n');
    writeFileSync(join(src, 'team', 'roles', 'reviewer.md'), '手艺\n');
    for (const format of ['ustar', 'gnu']) {
      const archive = join(root, `${format}.tar.gz`);
      execFileSync('tar', [`--format=${format}`, '-czf', archive, '-C', src, 'manifest.json', 'readable', 'team']);
      const members = unpackTar(gunzipBytes(readFileSync(archive), 64 * 1024 * 1024));
      assert.deepEqual(
        members.map((m) => m.path).sort(),
        ['manifest.json', 'readable/STANDING.md', 'team/roles/reviewer.md'],
        `${format} 格式`,
      );
      assert.equal(utf8(members.find((m) => m.path === 'readable/STANDING.md')?.data ?? new Uint8Array()), '# 铁律\n');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不可信归档：路径穿越、绝对路径、反斜杠、链接、设备、GNU/PAX 扩展头、重复成员、校验和被改、截断 —— 一律拒绝', () => {
  const good = forgeMember('manifest.json', '0', '{}');
  const cases: Array<[string, Buffer, RegExp]> = [
    ['../', rawTar([forgeMember('../evil.json', '0', '{}')]), /「\.\.」|空的目录名/],
    ['绝对路径', rawTar([forgeMember('/etc/passwd', '0', '{}')]), /绝对路径/],
    ['反斜杠', rawTar([forgeMember('a\\b', '0', '{}')]), /反斜杠/],
    ['符号链接', rawTar([forgeMember('link', '2')]), /不是普通文件.*符号链接/],
    ['硬链接', rawTar([forgeMember('hard', '1')]), /不是普通文件.*硬链接/],
    ['字符设备', rawTar([forgeMember('dev', '3')]), /不是普通文件.*字符设备/],
    ['GNU 长文件名扩展', rawTar([forgeMember('././@LongLink', 'L', 'x')]), /不是普通文件.*GNU 长文件名/],
    ['PAX 扩展头', rawTar([forgeMember('PaxHeaders/x', 'x', '{}')]), /不是普通文件.*PAX 扩展头/],
    ['稀疏文件', rawTar([forgeMember('sparse', 'S')]), /不是普通文件.*稀疏文件/],
    ['重复成员', rawTar([good, good]), /出现了两次/],
    ['校验和被改', (() => { const bytes = rawTar([good]); bytes[3] = 0x58; return bytes; })(), /校验和对不上/],
    ['结尾不完整', rawTar([good]).subarray(0, 1024 + 512), /结尾不完整/],
    ['大小造假（声明超出实际长度）', rawTar([forgeMember('big', '0', 'xx', 2048)]).subarray(0, 512 + 512 + 100), /实际长度/],
    ['空成员名', rawTar([forgeMember('', '0')]), /路径是空的/],
  ];
  for (const [name, bytes, expected] of cases) {
    assert.throws(() => unpackTar(bytes), (error: unknown) => error instanceof TarFormatError && expected.test(error.message), name);
  }
  assert.throws(() => assertSafeMemberPath('a/../b'), TarFormatError);
  assert.throws(() => assertSafeMemberPath('a/./b'), TarFormatError);
  assert.throws(() => packTar([{ path: '../x', data: text('x') }]), TarFormatError, '自己写包时也写不出 ..');
});

test('压缩包炸弹和解压上限：输出超过上限就停，不先把内存吃光', () => {
  const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < 64 * 1024);
  assert.throws(() => gunzipBytes(bomb, 1024 * 1024), /超过 1024 字节上限|压缩包炸弹/);
  assert.throws(() => gunzipBytes(Buffer.from('不是 gzip'), 1024), /不是有效的 gzip/);
  assert.equal(gunzipBytes(bomb, 16 * 1024 * 1024).length, 8 * 1024 * 1024);
});

test('成员数、单成员大小、总大小上限在解析途中生效', () => {
  const files: TarFile[] = [
    { path: 'a.txt', data: text('a'.repeat(3000)) },
    { path: 'b.txt', data: text('b'.repeat(3000)) },
    { path: 'c.txt', data: text('c') },
  ];
  const tar = packTar(files);
  assert.throws(() => unpackTar(tar, { maxMembers: 2, maxMemberBytes: 10_000, maxTotalBytes: 100_000 }), /成员超过 2 个/);
  assert.throws(() => unpackTar(tar, { maxMembers: 10, maxMemberBytes: 2000, maxTotalBytes: 100_000 }), /超过单个成员上限 2000/);
  assert.throws(() => unpackTar(tar, { maxMembers: 10, maxMemberBytes: 10_000, maxTotalBytes: 5000 }), /超过 5000 字节上限/);
  assert.throws(() => unpackTar(tar, { maxMembers: 10, maxMemberBytes: 10_000, maxTotalBytes: 6000 }), /超过 6000 字节上限/, '前两条正好到线，第三条超线');
  assert.equal(unpackTar(tar, { maxMembers: 10, maxMemberBytes: 10_000, maxTotalBytes: 7000 }).length, 3, '上限内的成员照常读出');
});
