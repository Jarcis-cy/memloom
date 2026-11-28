#!/usr/bin/env node
/**
 * 宿主子进程入口（通用，不绑任何宿主；契约见 docs/HOST-CONTRACT.md）：
 *   node dist/src/host/hook-cli.js --event           stdin 是一条 HostEvent 的 JSON → stdout 是一条 HostResponse 的 JSON
 *   node dist/src/host/hook-cli.js --job <说明文件>   跑一个后台任务（由核心另起的脱离短命子进程：宿主进程退出了它也做得完，跑完即退）
 * 任何情况都退出 0（宿主不该被记忆系统拦住），诊断只写 stderr，且不写用户原话、不写凭据。
 * --job 的后台模型凭据只从子进程环境变量 MEMLOOM_JOB_LLM_API_KEY 取（由核心在拉起时放入）；说明文件读完立刻删除，里面本来也没有凭据。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { depsFromJobConfig, runBackgroundJob } from './background.js';
import { resolveHostConfig } from './crew.js';
import { HostCore } from './core.js';
import { FileSessionStore, removeJobSpec } from './session.js';
import type { BackgroundJob, HostEvent, HostResponse, JobConfig } from './types.js';

function readAll(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream || (stream as { isTTY?: boolean }).isTTY === true) return Promise.resolve('');
  return new Promise((resolvePromise) => {
    let text = '';
    stream.on('data', (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    stream.on('end', () => resolvePromise(text));
    stream.on('error', () => resolvePromise(text));
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------- 后台任务（脱离的短命子进程） ---------- */

interface JobSpec {
  job: BackgroundJob;
  config: JobConfig;
}

async function runJob(specPath: string, stderr: NodeJS.WriteStream, env: NodeJS.ProcessEnv): Promise<number> {
  let spec: JobSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8')) as JobSpec;
  } catch (error) {
    stderr.write(`memloom job：读不了任务说明 ${specPath}：${errorText(error)}\n`);
    return 0;
  }
  // 读完立刻删：说明只活在「拉起到子进程读到」这一小段里
  removeJobSpec(specPath);
  const { job, config } = spec;
  let deps: ReturnType<typeof depsFromJobConfig> | null = null;
  try {
    deps = depsFromJobConfig(config, (line) => stderr.write(`memloom job：${line}\n`), () => new Date().toISOString(), env, new FileSessionStore(config.home, { scope: config.scope, dbPath: config.dbPath }));
    const report = await runBackgroundJob(job, deps);
    stderr.write(
      `memloom job：${job.kind} ${report.ok ? '完成' : '没完成'}；新增经历 ${report.inserted}，拒收 ${report.rejected}；${report.condense ?? ''}${report.craft ? `；${report.craft}` : ''}${report.error ? `；出错：${report.error}` : ''}\n`,
    );
  } catch (error) {
    stderr.write(`memloom job：${job.kind} 出错：${errorText(error)}\n`);
  } finally {
    deps?.store.close();
  }
  return 0;
}

/* ---------- 入口 ---------- */

export async function hookCliMain(
  args: readonly string[],
  stdin: NodeJS.ReadableStream | undefined,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const jobIndex = args.indexOf('--job');
  if (jobIndex >= 0) {
    const specPath = args[jobIndex + 1];
    if (!specPath) {
      stderr.write('memloom job：--job 后面要跟任务说明文件的路径\n');
      return 0;
    }
    return runJob(specPath, stderr, env);
  }
  if (!args.includes('--event')) {
    stderr.write('用法：node hook-cli.js --event（stdin 一条 HostEvent JSON）或 --job <任务说明文件>\n');
    return 0;
  }
  const text = (await readAll(stdin)).trim();
  if (text === '') return 0;
  let core: HostCore | null = null;
  try {
    const event = JSON.parse(text) as HostEvent;
    core = new HostCore(resolveHostConfig({}, env));
    const response: HostResponse = await core.handle(event);
    stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    stderr.write(`memloom：处理宿主事件出错（宿主不受影响）：${errorText(error)}\n`);
  } finally {
    core?.close();
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  void hookCliMain(process.argv.slice(2), process.stdin, process.stdout, process.stderr).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`memloom：出错（宿主不受影响）：${errorText(error)}\n`);
      process.exit(0);
    },
  );
}
