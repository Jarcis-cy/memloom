/**
 * 后台活动：纠错即时凝结、定期复盘抽取、关会话 / 压缩前抢救。用户会话从不等它们。
 * - 有界：同一会话同一时刻最多 1 个任务在跑、最多 1 个排队，同类任务在队列里只留一个。
 * - 两种跑法：InProcessRunner（Pi 这类常驻进程里的串行队列）；DetachedJobRunner（关会话 / 压缩前的抢救由
 *   `node hook-cli.js --job <说明文件>` 另起的脱离短命子进程做，宿主进程退出也做得完，没有常驻调度服务）。
 * - 脱离任务说明会短暂落盘，所以里面只放非密钥字段（端点、模型名、作用域、路径和要抽取的那段对话）；
 *   后台模型的凭据只通过子进程环境变量 MEMLOOM_JOB_LLM_API_KEY 传给这个固定的 node 子进程，说明文件里永远没有它。
 * - 只在配置了后台模型时才做；没配置就登记 skipped，什么都不发。项目 / 角色会话凝结后会顺手投影 CRAFT。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OpenAiCompatibleCondenseModel, OpenAiCompatibleExtractionModel } from '../app/llm.js';
import { extractExperiences } from '../core/capture.js';
import { condense } from '../core/condense.js';
import { openStore, type Store } from '../core/store.js';
import type { CondenseModel, ExtractionModel } from '../core/types.js';
import { projectCraft } from './crew.js';
import { removeJobSpec, writeJobSpec } from './session.js';
import type { BackgroundEntry, BackgroundJob, BackgroundKind, BackgroundRunner, JobConfig, SessionStore } from './types.js';

export const DEFAULT_HOOK_ENTRY = fileURLToPath(new URL('./hook-cli.js', import.meta.url));
/** 子进程里后台模型的凭据只从这个环境变量取；外层环境里的 MEMLOOM_LLM_API_KEY 不会传进去，也不会被读 */
export const JOB_API_KEY_ENV = 'MEMLOOM_JOB_LLM_API_KEY';

export interface JobDeps {
  store: Store;
  scope: string;
  projectDir: string | null;
  extractionModel: ExtractionModel | null;
  condenseModel: CondenseModel | null;
  sessionStore: SessionStore | null;
  crewCliPath: string | null;
  now: () => string;
  log: (line: string) => void;
}

export interface JobReport {
  kind: BackgroundKind;
  ok: boolean;
  inserted: number;
  rejected: number;
  /** 凝结这一步的大白话结果 */
  condense: string | null;
  craft: string | null;
  error: string | null;
}

export interface JobSpec {
  job: BackgroundJob;
  config: JobConfig;
}

/**
 * 脱离任务说明：逐字段挑选，不是把配置整个倒出去——类型上的 Omit 挡不住运行时多出来的字段，
 * 所以这里明确只放端点、模型名、超时和路径，凭据永远不进来。
 */
export function jobSpec(job: BackgroundJob, config: JobConfig): JobSpec {
  return {
    job,
    config: {
      home: config.home,
      dbPath: config.dbPath,
      scope: config.scope,
      projectDir: config.projectDir,
      projectId: config.projectId,
      roleName: config.roleName,
      stateDir: config.stateDir,
      llm: config.llm
        ? {
            baseUrl: config.llm.baseUrl,
            model: config.llm.model,
            ...(config.llm.reasoningEffort ? { reasoningEffort: config.llm.reasoningEffort } : {}),
            ...(config.llm.thinkingFormat ? { thinkingFormat: config.llm.thinkingFormat } : {}),
            timeoutMs: config.llm.timeoutMs,
          }
        : null,
      crewCliPath: config.crewCliPath ?? null,
    },
  };
}

/** 脱离子进程的环境：复制本进程环境但去掉外层后台模型的凭据，只放当前配置这一份（没有就给空串 = 明确无凭据） */
export function jobEnv(apiKey: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== 'MEMLOOM_LLM_API_KEY' && key !== JOB_API_KEY_ENV) out[key] = value;
  }
  out[JOB_API_KEY_ENV] = apiKey ?? '';
  return out;
}

/** 从说明 + 子进程环境造出任务依赖（脱离子进程用；库按需才开）。凭据只认 env 参数，不读说明、不读别的变量。 */
export function depsFromJobConfig(config: JobConfig, log: (line: string) => void, now: () => string, env: NodeJS.ProcessEnv, sessionStore: SessionStore | null = null, store?: Store): JobDeps {
  const apiKey = env[JOB_API_KEY_ENV] || undefined;
  const llm = config.llm ? { ...config.llm, apiKey } : null;
  return {
    store: store ?? openStore(config.dbPath),
    scope: config.scope,
    projectDir: config.projectDir,
    extractionModel: llm ? new OpenAiCompatibleExtractionModel(llm) : null,
    condenseModel: llm ? new OpenAiCompatibleCondenseModel(llm) : null,
    sessionStore,
    crewCliPath: config.crewCliPath ?? null,
    now,
    log,
  };
}

function craftAfter(store: Store, scope: string, projectDir: string | null): string | null {
  if (projectDir === null || scope === 'personal') return null;
  try {
    const report = projectCraft({ projectDir, store, scope });
    return report.status === 'ok' ? `CRAFT 已投影 ${report.written} 条到 ${report.path}${report.note ? `（${report.note}）` : ''}` : `CRAFT ${report.status}`;
  } catch (error) {
    return `CRAFT 投影没做成：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 真正干活的一段：进程内和脱离子进程共用。 */
export async function runBackgroundJob(job: BackgroundJob, deps: JobDeps): Promise<JobReport> {
  const report: JobReport = { kind: job.kind, ok: true, inserted: 0, rejected: 0, condense: null, craft: null, error: null };
  const { store } = deps;
  try {
    if (job.kind === 'correction') {
      if (!deps.condenseModel || typeof job.experienceId !== 'number') {
        return { ...report, ok: false, error: !deps.condenseModel ? '没有配置后台模型，纠错已入库但没有凝结' : '缺少要凝结的经历编号' };
      }
      const result = await condense({ store, scope: deps.scope, model: deps.condenseModel, reason: 'correction', experienceIds: [job.experienceId], now: deps.now });
      report.condense = describeCondense(result);
      if (result.ran && result.ok) report.craft = craftAfter(store, deps.scope, deps.projectDir);
      else report.ok = false;
      return report;
    }
    const messages = job.messages ?? [];
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (messages.length === 0) return { ...report, condense: job.kind === 'flush' ? null : '没有新消息' };
    if (!deps.extractionModel) return { ...report, ok: false, error: '没有配置后台模型，这次没有抽取' };
    const extracted = await extractExperiences({
      store,
      scope: deps.scope,
      source: job.kind === 'flush' ? 'flush' : 'review',
      sessionId: job.sessionId,
      messages,
      model: deps.extractionModel,
      now: deps.now,
    });
    report.inserted = extracted.inserted.length;
    report.rejected = extracted.rejected.length;
    // 会话还在时只有复盘才推游标；抢救（关会话 / 压缩前）不往回写，免得把已经裁剪掉的会话状态复活
    if (job.kind === 'review' && deps.sessionStore && lastId !== null) {
      try {
        await deps.sessionStore.withSession(job.sessionId, (state) => {
          state.coveredMessageId = lastId;
        });
      } catch (error) {
        deps.log(`记复盘游标没成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (job.kind === 'review') {
      if (!deps.condenseModel) {
        report.condense = '没有配置后台模型，抽取的经历先待处理';
      } else {
        const result = await condense({ store, scope: deps.scope, model: deps.condenseModel, reason: 'scheduled', now: deps.now });
        report.condense = describeCondense(result);
        if (result.ran && result.ok) report.craft = craftAfter(store, deps.scope, deps.projectDir);
        else if (result.ran && !result.ok) report.ok = false;
      }
    }
    return report;
  } catch (error) {
    return { ...report, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function describeCondense(result: Awaited<ReturnType<typeof condense>>): string {
  if (!result.ran) {
    return result.reason === 'nothing_pending' ? '没有待处理的经历' : `待处理 ${result.pendingCount} 条，不到 ${result.threshold} 条，这次不凝结`;
  }
  if (!result.ok) return `模型计划没通过校验，经历保持待处理：${result.error}`;
  return `凝结完成，处理经历 ${result.processedExperienceIds.length} 条，动作 ${result.actions.map((a) => a.action).join('、') || '无'}`;
}

function describe(report: JobReport): string {
  const head = `后台 ${report.kind}：${report.ok ? '完成' : '没完成'}`;
  const parts = [
    report.inserted > 0 ? `新增经历 ${report.inserted} 条` : '',
    report.rejected > 0 ? `拒收候选 ${report.rejected} 条` : '',
    report.condense ?? '',
    report.craft ?? '',
    report.error ?? '',
  ].filter((part) => part !== '');
  return [head, ...parts].join('；');
}

/* ---------- 进程内串行队列 ---------- */

export class InProcessRunner implements BackgroundRunner {
  private running = false;
  private readonly queue = new Map<BackgroundKind, BackgroundJob>();
  private idleListeners: Array<() => void> = [];

  constructor(
    private readonly execute: (job: BackgroundJob) => Promise<JobReport>,
    private readonly onDone: (line: string) => void = () => undefined,
  ) {}

  async submit(job: BackgroundJob): Promise<BackgroundEntry['state']> {
    if (!this.running) {
      this.running = true;
      void this.run(job);
      return 'queued';
    }
    const coalesced = this.queue.has(job.kind);
    this.queue.set(job.kind, job);
    return coalesced ? 'coalesced' : 'queued';
  }

  private async run(job: BackgroundJob): Promise<void> {
    try {
      this.onDone(describe(await this.execute(job)));
    } catch (error) {
      this.onDone(`后台 ${job.kind} 出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const next = this.queue.entries().next();
      if (next.done) {
        this.running = false;
        for (const listener of this.idleListeners.splice(0)) listener();
      } else {
        this.queue.delete(next.value[0]);
        void this.run(next.value[1]);
      }
    }
  }

  /** 测试和收尾用：等队列跑空 */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleListeners.push(resolve));
  }

  close(): void {
    this.queue.clear();
  }
}

/* ---------- 脱离的短命子进程（关会话 / 压缩前的抢救） ---------- */

/**
 * 拉起子进程并返回子进程号；拿不到就返回 null（同步异常，或 Node 内部已经失败）。
 * 关键：没有 pid 时 ChildProcess 仍会在下一拍发出 'error'（例如 execPath 不存在的 ENOENT），
 * 所以监听必须在任何返回之前无条件挂上，否则会变成宿主进程的未处理异常而退出。
 * 说明文件在同步异常 / 没有 pid / error / 退出时都会被清理（onGone 幂等），不会留下没人管的说明；说明里本来也没有凭据。
 */
export function spawnDetachedJob(entry: string, specPath: string, env: NodeJS.ProcessEnv, onGone: (reason: string) => void): number | null {
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entry, '--job', specPath], { detached: true, stdio: 'ignore', shell: false, env });
  } catch (error) {
    onGone(`拉起失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  // 无条件先挂监听，再谈有没有 pid
  child.once('error', (error) => onGone(`子进程出错：${error.message}`));
  child.once('exit', (code, signal) => onGone(`子进程已退出（${signal ?? `退出码 ${String(code)}`}）`));
  if (child.pid === undefined) {
    onGone('没有拿到子进程号');
    return null;
  }
  // 不替它撑住事件循环；退出事件照样收得到，说明没被它自己删掉时这里兜底
  child.unref();
  return child.pid;
}

/** 关会话 / 压缩前的抢救：写一份不含凭据的任务说明，另起脱离的短命子进程去做；本进程退出也做得完。 */
export class DetachedJobRunner implements BackgroundRunner {
  constructor(
    private readonly config: JobConfig,
    private readonly entry: string = DEFAULT_HOOK_ENTRY,
    private readonly apiKey: string | undefined = undefined,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async submit(job: BackgroundJob): Promise<BackgroundEntry['state']> {
    if (!existsSync(this.entry)) {
      this.log(`脱离任务的入口不存在（${this.entry}），这次不跑后台 ${job.kind}；请先 npm run build`);
      return 'skipped';
    }
    const specPath = writeJobSpec(this.config.home, jobSpec(job, this.config));
    // 同一份说明只清一次：没有 pid 时这里先清，下一拍的 error 事件再来一次也只记一句
    let gone = false;
    const cleanup = (reason: string): void => {
      if (gone) return;
      gone = true;
      removeJobSpec(specPath);
      this.log(`后台 ${job.kind} 的脱离任务说明已清理：${reason}`);
    };
    const pid = spawnDetachedJob(this.entry, specPath, jobEnv(this.apiKey, this.env), cleanup);
    return pid === null ? 'skipped' : 'spawned';
  }

  close(): void {
    // 子进程是脱离的，关会话不打断它；任务自己跑完就退
  }
}
