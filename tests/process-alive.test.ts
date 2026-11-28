import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inspectLinuxProcess, isProcessAlive, parseProcState, type StatReader } from '../src/core/process-alive.js';

/**
 * 进程判活（检索守护进程的锁、会话文件锁共用的一套）：/proc 的解析和每个分支都用注入的夹具确定性验证，不依赖机器状态；
 * 真僵尸只造一个，而且父进程、子进程、出错、释放都有上限，收尾只动自己拉起的两个进程。
 */

function throwsCode(code: string): StatReader {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

const noop = (): void => undefined;

test('/proc/<pid>/stat 解析：只认最后一个 ) 之后的状态字母，进程名里的空格、括号、换行都不干扰', () => {
  assert.equal(parseProcState('1869759 (cat) R 1869758 1869758 1869752 0 -1'), 'R');
  assert.equal(parseProcState('4321 (node) S 1 4321 4321 0'), 'S');
  assert.equal(parseProcState('4321 (a weird ) name (with parens)) Z 1 4321 4321 0'), 'Z', '僵尸，而且进程名里带括号和空格');
  assert.equal(parseProcState('4321 (multi\nline name) D 1'), 'D', '进程名里带换行');
  assert.equal(parseProcState('4321 (kworker/0:1H) I 2'), 'I');
  assert.equal(parseProcState(''), null);
  assert.equal(parseProcState('4321 node S'), null, '没有括号');
  assert.equal(parseProcState('4321 (node)'), null, '括号后面没有状态字母');
  assert.equal(parseProcState('4321 (node) '), null);
  assert.equal(parseProcState('4321 (node) 7 1'), null, '括号后面不是字母');
});

test('Linux 判读（注入读入）：Z / X / x 算退出，其它状态活着；ENOENT 算没了，其它读错和看不懂的内容当不知道', () => {
  for (const state of ['Z', 'X', 'x']) assert.equal(inspectLinuxProcess(1, () => `1 (x) ${state} 0`), 'dead', state);
  for (const state of ['R', 'S', 'D', 'I', 'T', 't', 'W', 'P']) assert.equal(inspectLinuxProcess(1, () => `1 (x) ${state} 0`), 'alive', state);
  assert.equal(inspectLinuxProcess(1, throwsCode('ENOENT')), 'gone');
  assert.equal(inspectLinuxProcess(1, throwsCode('EACCES')), 'unknown');
  assert.equal(inspectLinuxProcess(1, throwsCode('EIO')), 'unknown');
  assert.equal(inspectLinuxProcess(1, () => 'garbage'), 'unknown');
});

test('isProcessAlive（注入）：非法 pid 和 kill 报错、EPERM、非 Linux 都保持原行为；Linux 下僵尸 / 没了算退出，读错仍算活着', () => {
  const linux = { platform: 'linux' as const };
  assert.equal(isProcessAlive(0, linux), false);
  assert.equal(isProcessAlive(-5, linux), false);
  assert.equal(isProcessAlive(1.5, linux), false);
  assert.equal(isProcessAlive(999, { ...linux, kill: throwsCode('ESRCH') }), false, '进程不存在');
  assert.equal(isProcessAlive(999, { ...linux, kill: throwsCode('EPERM') }), true, 'EPERM：进程在，只是不归我们管，仍算活着');
  assert.equal(isProcessAlive(999, { platform: 'darwin', kill: noop, readStat: throwsCode('ENOENT') }), true, '非 Linux 只看 kill(0)，不读 /proc');
  assert.equal(isProcessAlive(999, { platform: 'win32', kill: noop, readStat: () => '1 (x) Z 0' }), true, '非 Linux 即使 /proc 里是僵尸也不看');
  assert.equal(isProcessAlive(999, { ...linux, kill: noop, readStat: () => '999 (node) Z 1' }), false, '僵尸');
  assert.equal(isProcessAlive(999, { ...linux, kill: noop, readStat: () => '999 (node) X 1' }), false, 'dead');
  assert.equal(isProcessAlive(999, { ...linux, kill: noop, readStat: throwsCode('ENOENT') }), false, 'kill(0) 和读 /proc 之间进程没了');
  assert.equal(isProcessAlive(999, { ...linux, kill: noop, readStat: throwsCode('EIO') }), true, '其它读错照旧当活着，不误判成死的');
  assert.equal(isProcessAlive(999, { ...linux, kill: noop, readStat: () => 'garbage' }), true, '看不懂的内容当活着');
  assert.equal(isProcessAlive(999, { ...linux, kill: noop, readStat: () => '999 (node) S 1' }), true);
  assert.equal(isProcessAlive(process.pid), true, '自己当然活着（这条读的是真的 /proc 或真的 kill(0)）');
});

/* ---------- 真僵尸（只在 Linux） ---------- */

// 父进程脚本：拉起一个 1 秒后自己退出的子进程，把子进程 pid 报到 stdout，然后自己停在这里等测试发 SIGSTOP 把它冻住。
// 测试没来收的话 8 秒后自己退出（子进程会被系统回收），所以不管测试怎么断，它都不会一直留着。
const HOLDER = `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1000)'], { stdio: 'ignore' });
process.stdout.write(String(child.pid) + '\\n');
setTimeout(() => process.exit(0), 8000);
`;

interface Holder {
  child: ChildProcess;
  /** 它拉起的子进程的 pid（将要变成僵尸的那个） */
  pid: number;
  closed: Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 拉起「会冻住的父进程」：拿到它报的子进程 pid 才算成功；拉不起、没报 pid 就退出、10 秒没回话，都杀掉并报错 */
function startHolder(): Promise<Holder> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    let settled = false;
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${message}；父进程 stderr：${stderr.trim() || '（空）'}`));
    };
    const timer = setTimeout(() => fail('等父进程报子进程 pid 超过 10 秒'), 10_000);
    child.on('error', (error) => fail(`拉不起父进程：${error.message}`));
    child.on('exit', (code, signal) => fail(`父进程没报 pid 就退出了（code=${String(code)} signal=${String(signal)}）`));
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
      const firstLine = out.split('\n')[0] ?? '';
      if (out.includes('\n') && firstLine !== '') {
        const pid = Number(firstLine);
        if (Number.isInteger(pid) && pid > 0) {
          clearTimeout(timer);
          settled = true;
          resolve({ child, pid, closed });
        } else {
          fail(`父进程报的子进程 pid 看不懂：${firstLine}`);
        }
      }
    });
  });
}

/** 读 /proc/<pid>/stat 的状态字母；进程已经没了（或读不了）返回 null */
function procState(pid: number): string | null {
  try {
    return parseProcState(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

const hasProc = (() => {
  try {
    readFileSync('/proc/self/stat');
    return true;
  } catch {
    return false;
  }
})();

test(
  '真僵尸：父进程被冻住时子进程退出，kill(0) 仍成功但进程已经没了，isProcessAlive 报 false；解冻后父进程回收它',
  { skip: process.platform !== 'linux' ? '只在 Linux 上造僵尸' : hasProc ? false : '这个环境读不了 /proc，造不了僵尸' },
  async () => {
    const holder = await startHolder();
    const parent = holder.child.pid as number;
    const signal = (pid: number, name: NodeJS.Signals): void => {
      try {
        process.kill(pid, name);
      } catch {
        // 已经退了
      }
    };
    try {
      // 冻住父进程：它收不到子进程的退出，子进程退出后只能以僵尸留着
      signal(parent, 'SIGSTOP');
      const deadline = Date.now() + 3_000;
      while (procState(holder.pid) !== 'Z' && Date.now() < deadline) await sleep(20);
      assert.equal(procState(holder.pid), 'Z', '3 秒内子进程应当已经退出并成为僵尸');

      // 以前只看 kill(0)：僵尸的 pid 还占着，kill(0) 不报错，于是已经退出的守护进程被当成活着
      assert.doesNotThrow(() => process.kill(holder.pid, 0), '僵尸的 pid 还占着，kill(0) 不报错');
      assert.equal(isProcessAlive(holder.pid), false, '僵尸不算活着');

      // 释放：解冻父进程，它会回收僵尸；/proc 里不再有这个 pid
      signal(parent, 'SIGCONT');
      const goneBy = Date.now() + 2_000;
      while (procState(holder.pid) !== null && Date.now() < goneBy) await sleep(20);
      assert.equal(procState(holder.pid), null, '解冻后父进程回收了僵尸');
    } finally {
      // 只动自己拉起的这一个父进程；不管上面断言结果如何，解冻、杀掉、最多再等 2 秒
      signal(parent, 'SIGCONT');
      holder.child.kill('SIGKILL');
      await Promise.race([holder.closed, sleep(2_000)]);
    }
  },
);
