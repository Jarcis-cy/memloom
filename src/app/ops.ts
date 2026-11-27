/**
 * 命令行和 MCP 共用的薄层：每个操作 = 定作用域 → 调核心（core / retriever / portable）→ 返回可直接打印、也可直接给 MCP 的纯数据。
 * 这里不写业务规则（采集、凝结、归档的规则都在 core / portable 里），只做参数整理、结果整理和「如实报告」：
 * 没配模型就说没配，向量没建就说没建，事务落库后哪一步失败就分别报告，不合并成一句「成功」。
 */
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { captureCorrection } from '../core/capture.js';
import { condense, isNearDuplicate } from '../core/condense.js';
import { openStore, type Store } from '../core/store.js';
import { EXPERIENCE_KINDS, type CondenseModel, type DuplicateJudge, type ExperienceKind, type PrincipleRow } from '../core/types.js';
import {
  createRetriever,
  hybridRecall,
  rebuildVectors,
  retrieverConfigFromEnv,
  type Retriever,
  type RetrieverConfig,
  type RetrieverHealth,
} from '../retriever/index.js';
import { scopeFor, UsageError, type MemloomContext } from './context.js';
import { daemonStatus, daemonStop, type DaemonStatus } from './daemon.js';
import { describeLlm, llmConfigFromEnv, OpenAiCompatibleCondenseModel, type LlmConfig } from './llm.js';
import { defaultArchiveName, exportArchive } from '../portable/export.js';
import { importArchive, type ImportMode } from '../portable/import.js';
import { renderPrinciples, renderStanding, scopeSlug } from '../portable/readable.js';

export { UsageError };

/** 「没配置后台模型」这类不是故障、但确实什么都没做的情况：退出码 2，把怎么配置说清楚。 */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export interface MemloomOptions {
  env?: NodeJS.ProcessEnv;
  /** 注入检索器（测试用）；不给就按环境变量造 */
  retriever?: Retriever;
  retrieverConfig?: RetrieverConfig;
  /** null = 明确没有后台模型；不给 = 从环境变量读 */
  llm?: LlmConfig | null;
  /** 注入凝结模型（测试用离线替身） */
  model?: CondenseModel;
  judge?: DuplicateJudge;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

const HAN = /\p{Script=Han}/u;
const VERSION = '0.1.0';

export interface VectorReport {
  /** ok = 建完了；degraded = 没有可用的向量模型（正常退化）；failed = 这一步出错或没建完 */
  status: 'ok' | 'degraded' | 'failed';
  indexed: number;
  failed: number;
  scanned: number;
  model: string;
  health: RetrieverHealth | null;
  reason: string | null;
  note: string | null;
}

export interface SnapshotReport {
  status: 'ok' | 'failed';
  dir: string;
  files: string[];
  error: string | null;
  retry: string | null;
}

/** 后置步骤共同的 重试说法：重复导入 / 重新拍板不会重复写记录 */
const RETRY_IMPORT = '重新执行 memloom import <同一个包>（重复导入不会产生重复记录，只会补做没完成的后置步骤）';

function toId(value: unknown, what: string): number {
  const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new UsageError(`${what} 要是正整数编号，收到的是「${String(value)}」`);
  return id;
}

function text(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new UsageError(`${what} 必须是文字`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new UsageError(`${what} 长度要在 ${min} 到 ${max} 个字之间（现在是 ${trimmed.length} 字）`);
  if (!HAN.test(trimmed)) throw new UsageError(`${what} 必须用自然中文写，不能只有英文或符号`);
  return trimmed;
}

function optionalText(value: unknown, what: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return text(value, what, 1, max);
}

export class Memloom {
  private storeValue: Store | null = null;
  private retrieverValue: Retriever | null = null;
  readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly ctx: MemloomContext,
    private readonly options: MemloomOptions = {},
  ) {
    this.env = options.env ?? process.env;
  }

  now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  scope(requested?: string | null): string {
    return scopeFor(this.ctx, requested);
  }

  /** 第一次用到时才开库（父目录按需创建，只给当前用户）；doctor 这类只读操作用 storeIfExists。 */
  get store(): Store {
    if (!this.storeValue) {
      // 库文件是符号链接就拒绝打开（悬空的链接也算）：受控路径上的链接一律不顺着走
      try {
        if (lstatSync(this.ctx.dbPath).isSymbolicLink()) {
          throw new UsageError(`库文件「${this.ctx.dbPath}」是符号链接，拒绝打开；请换成真实的库文件`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      mkdirSync(dirname(this.ctx.dbPath), { recursive: true, mode: 0o700 });
      this.storeValue = openStore(this.ctx.dbPath);
    }
    return this.storeValue;
  }

  storeIfExists(): Store | null {
    return existsSync(this.ctx.dbPath) ? this.store : null;
  }

  get retriever(): Retriever {
    if (!this.retrieverValue) {
      this.retrieverValue =
        this.options.retriever ??
        createRetriever(
          this.options.retrieverConfig ??
            retrieverConfigFromEnv({ ...this.env, MEMLOOM_STATE_DIR: this.env.MEMLOOM_STATE_DIR ?? this.ctx.stateDir }),
        );
    }
    return this.retrieverValue;
  }

  retrieverConfig(): RetrieverConfig {
    return this.options.retrieverConfig ?? retrieverConfigFromEnv({ ...this.env, MEMLOOM_STATE_DIR: this.env.MEMLOOM_STATE_DIR ?? this.ctx.stateDir });
  }

  llmConfig(): LlmConfig | null {
    if (this.options.llm === null) return null;
    return this.options.llm ?? llmConfigFromEnv(this.env);
  }

  close(): void {
    this.storeValue?.close();
    this.storeValue = null;
  }

  /* ---------- 召回 ---------- */

  async recall(args: { scope?: string; query?: string; limit?: number }) {
    const scope = this.scope(args.scope);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new UsageError('recall 需要一句查询（memloom recall <查询文字>）');
    const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 10)), 25);
    const result = await hybridRecall({ store: this.store, scope, query, retriever: this.retriever, limit });
    const at = this.now();
    for (const item of result.items) if (item.type === 'experience') this.store.recordExperienceHit(item.id, at);
    return {
      scope,
      query,
      mode: result.mode,
      elapsedMs: result.elapsedMs,
      items: result.items.map((item) => ({
        type: item.type,
        id: item.id,
        score: Math.round(item.score * 1000) / 1000,
        source: item.source,
        reranked: item.reranked,
        strength: item.principle ? item.principle.strength : null,
        trigger_when: item.principle?.triggerWhen ?? null,
        rule: item.principle?.rule ?? null,
        summary: item.experience?.summary ?? null,
      })),
    };
  }

  /* ---------- 采集 ---------- */

  capture(args: { scope?: string; kind?: string; summary?: string; evidence?: string; sourceSession?: string; message?: string; sessionId?: string; turn?: number }) {
    const scope = this.scope(args.scope);
    const at = this.now();
    if (args.message !== undefined) {
      if (!args.sessionId || typeof args.turn !== 'number' || !Number.isFinite(args.turn)) throw new UsageError('按用户原话采集纠错需要同时给 --session <会话编号> 和 --turn <轮数>');
      const result = captureCorrection(this.store, { scope, sessionId: args.sessionId, turn: args.turn, message: args.message, now: at });
      if ('skipped' in result) {
        return {
          captured: false,
          reason: result.skipped,
          message: result.skipped === 'no_signal' ? '这句话里没有检测到纠错信号，什么都没记' : '这个会话刚记过一次纠错，限频期内不再重复记',
        };
      }
      return {
        captured: true,
        experience: { id: result.experience.id, kind: result.experience.kind, summary: result.experience.summary },
        pending: this.store.countPendingExperiences(scope),
        next: `运行 memloom concresce 可以马上把这条纠错（经历 #${result.experience.id}）凝结成原则`,
      };
    }
    if (!(EXPERIENCE_KINDS as readonly string[]).includes(args.kind ?? '')) {
      throw new UsageError(`capture 的 kind 只能是 ${EXPERIENCE_KINDS.join(' / ')}`);
    }
    const summary = text(args.summary, 'capture 的 summary', 2, 300);
    const evidence = optionalText(args.evidence, 'capture 的 evidence', 1000);
    const row = this.store.addExperience({
      scope,
      kind: args.kind as ExperienceKind,
      summary,
      evidence,
      source: 'manual',
      sourceSession: args.sourceSession ?? null,
      createdAt: at,
    });
    return {
      captured: true,
      experience: { id: row.id, kind: row.kind, summary: row.summary, evidence: row.evidence },
      pending: this.store.countPendingExperiences(scope),
      next: `运行 memloom concresce 可以把这条经历（#${row.id}）和其它待处理的一起凝结成原则`,
    };
  }

  /* ---------- 铁律（只有这些显式的人工入口能改） ---------- */

  ironRules(args: { scope?: string; action: string; content?: string; id?: number | string }) {
    const scope = this.scope(args.scope);
    const at = this.now();
    if (args.action === 'list') {
      const rules = this.store.listIronRules(scope, { activeOnly: false });
      return { scope, rules: rules.map((r) => ({ id: r.id, active: r.active, content: r.content, updated_at: r.updatedAt })) };
    }
    if (args.action === 'add') {
      const content = text(args.content, 'iron-rules add 的 content', 4, 1200);
      const row = this.store.addIronRule({ scope, content, now: at });
      return { added: { id: row.id, content: row.content }, note: '铁律只有这个显式的人工入口能加；后台凝结永远碰不到' };
    }
    if (args.action === 'disable') {
      const id = toId(args.id, 'iron-rules disable 的 id');
      const current = this.store.getIronRule(id);
      if (current.scope !== scope) throw new UsageError(`铁律 #${id} 属于「${current.scope}」，不在当前作用域「${scope}」里`);
      if (!current.active) throw new UsageError(`铁律 #${id} 本来就是停用状态`);
      const row = this.store.setIronRuleActive(id, false, at);
      return { disabled: { id: row.id, content: row.content }, note: '只是停用，没有删除；历史留底' };
    }
    throw new UsageError(`iron-rules 的 action 只能是 list / add / disable，收到的是「${args.action}」`);
  }

  /* ---------- 分歧 ---------- */

  dilemmasList(args: { scope?: string; all?: boolean }) {
    const scope = this.scope(args.scope);
    const rows = this.store.listDilemmas(scope, args.all ? { status: 'all' } : {});
    return {
      scope,
      open: rows.filter((d) => d.status === 'open').length,
      dilemmas: rows.map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        summary: d.summary,
        option_a: d.optionA,
        option_b: d.optionB,
        related_principle_ids: d.relatedPrincipleIds,
        source_experience_ids: d.sourceExperienceIds,
        resolution: d.resolution,
        created_at: d.createdAt,
      })),
    };
  }

  /**
   * 用户明确拍板后才执行：A = 保留现有原则；B = 用用户逐字段给出的新原则接替目标原则（结构化目标 + 校验过的字段，不执行自由文本）。
   * 两个选择都要 --confirm <分歧编号>（肯定操作标志要和编号一致）；已解决的不再执行第二次；不能跨作用域。
   */
  async dilemmaResolve(args: {
    scope?: string;
    id: number | string;
    choice?: string;
    confirm?: number | string;
    targetId?: number | string;
    triggerWhen?: string;
    rule?: string;
    rationale?: string;
    isCore?: boolean;
  }) {
    const scope = this.scope(args.scope);
    const id = toId(args.id, 'dilemmas resolve 的 id');
    if (args.confirm === undefined || args.confirm === null || args.confirm === '') {
      throw new UsageError('缺少肯定操作标志：--confirm <分歧编号>（必须和要拍的分歧编号一致，防止拍错）');
    }
    const confirm = toId(args.confirm, 'dilemmas resolve 的 confirm');
    if (confirm !== id) throw new UsageError(`肯定操作标志（--confirm）要和分歧编号一致：这条分歧是 #${id}，收到的是「${String(args.confirm)}」`);
    const choice = typeof args.choice === 'string' ? args.choice.trim().toUpperCase() : '';
    if (choice !== 'A' && choice !== 'B') throw new UsageError('dilemmas resolve 需要 --choice A（保留现有原则）或 B（用新原则接替）');
    const dilemma = this.store.getDilemma(id);
    if (dilemma.scope !== scope) throw new UsageError(`分歧 #${id} 属于「${dilemma.scope}」，不在当前作用域「${scope}」里，不能跨作用域处理`);
    if (dilemma.status !== 'open') {
      throw new UsageError(`分歧 #${id} 已经是「${dilemma.status}」了（结论：${dilemma.resolution ?? '无'}）；同一条分歧不重复执行`);
    }
    const at = this.now();
    // 纯配置问题在落库前拒绝（这时分歧还是 open，什么都没改）
    const retriever = this.retrieverFor('分歧拍板');
    if (choice === 'A') {
      const resolved = this.store.transaction(() =>
        this.store.setDilemmaResolution(id, { status: 'resolved', note: `用户选择 A：${dilemma.optionA}。保留现有原则，没有改动任何原则。`, resolvedAt: at }),
      );
      const snapshot = this.snapshotSafe(scope);
      return {
        resolved: { id: resolved.id, status: resolved.status, resolution: resolved.resolution },
        choice: 'A',
        principle: null,
        superseded: null,
        vectors: { status: 'ok', indexed: 0, failed: 0, scanned: 0, model: this.retriever.modelId, health: null, reason: null, note: '选 A 不改原则，不需要重建向量' },
        snapshot,
        committed: true,
        post_failures: snapshot.status === 'failed' ? 1 : 0,
        notice: snapshot.status === 'failed' ? `分歧已按选择 A 解决并落库（不是回滚）；只是可读快照没刷新：${snapshot.error}。重试：${snapshot.retry}` : null,
      };
    }

    let target: PrincipleRow | null = null;
    if (dilemma.relatedPrincipleIds.length > 0) {
      const targetId = toId(args.targetId, 'dilemmas resolve 选 B 时的 target_id');
      if (!dilemma.relatedPrincipleIds.includes(targetId)) {
        throw new UsageError(`target_id 只能是这条分歧关联的原则之一：${dilemma.relatedPrincipleIds.join('、')}`);
      }
      target = this.store.getPrinciple(targetId);
      if (target.scope !== scope) throw new UsageError(`原则 #${targetId} 不在当前作用域`);
      if (target.status !== 'active') throw new UsageError(`原则 #${targetId} 已经是「${target.status}」，不能被接替`);
    } else if (args.targetId !== undefined) {
      throw new UsageError('这条分歧没有关联任何原则，不要给 target_id；选 B 只会新增一条原则');
    }
    if (args.triggerWhen === undefined || args.rule === undefined) {
      throw new UsageError('选 B 必须由用户逐字段给出新原则：--trigger（触发场景）、--rule（行动准则），可选 --rationale、--core；不接受一段自由文本');
    }
    const triggerWhen = text(args.triggerWhen, '新原则的 trigger', 4, 200);
    const rule = text(args.rule, '新原则的 rule', 6, 600);
    const rationale = optionalText(args.rationale, '新原则的 rationale', 300);
    const isCore = args.isCore === true;
    const capacity = this.store.capacity(scope);
    if (isCore && capacity.coreCount + 1 > capacity.maxCore) {
      throw new UsageError(`常驻核心原则最多 ${capacity.maxCore} 条，已经满了；去掉 --core`);
    }
    const newText = `${triggerWhen}\n${rule}`;
    for (const other of this.store.listPrinciples(scope, { status: 'active' })) {
      if (target && other.id === target.id) continue;
      if (isNearDuplicate(newText, `${other.triggerWhen}\n${other.rule}`)) {
        throw new UsageError(`新原则和现有的原则 #${other.id} 说的是同一件事（或几乎一样），请改用别的方式处理这条分歧`);
      }
    }
    const sources = dilemma.sourceExperienceIds.filter((expId) => {
      const exp = this.store.getExperience(expId);
      return exp !== null && exp.scope === scope;
    });
    const outcome = this.store.transaction(() => {
      const row = this.store.insertPrinciple({
        scope,
        triggerWhen,
        rule,
        rationale,
        isCore,
        parentIds: target ? [target.id] : [],
        sourceExperienceIds: sources,
        now: at,
      });
      if (target) {
        this.store.setPrincipleStatus(target.id, 'superseded', { retireReason: `被原则 #${row.id} 替代：用户在分歧 #${dilemma.id} 里选了 B`, now: at });
      }
      const after = this.store.capacity(scope);
      if (after.activeCount > after.hardCount || after.activeChars > after.hardChars) {
        throw new UsageError(`接替后生效原则会超过这个作用域的硬上限（${after.activeCount}/${after.hardCount} 条，${after.activeChars}/${after.hardChars} 字）；什么都没改`);
      }
      const resolved = this.store.setDilemmaResolution(id, {
        status: 'resolved',
        note:
          `用户选择 B：${dilemma.optionB}。` +
          (target ? `新原则 #${row.id} 接替 #${target.id}（旧条目标为已被替代，历史保留）。` : `新增原则 #${row.id}。`),
        resolvedAt: at,
      });
      return { row, resolved };
    });
    const vectors = await this.reindexSafe(scope, retriever);
    const snapshot = this.snapshotSafe(scope);
    return {
      resolved: { id: outcome.resolved.id, status: outcome.resolved.status, resolution: outcome.resolved.resolution },
      choice: 'B',
      principle: { id: outcome.row.id, trigger_when: outcome.row.triggerWhen, rule: outcome.row.rule, rationale: outcome.row.rationale },
      superseded: target ? { id: target.id, status: 'superseded' } : null,
      vectors,
      snapshot,
      committed: true,
      post_failures: (vectors.status === 'failed' ? 1 : 0) + (snapshot.status === 'failed' ? 1 : 0),
      notice:
        vectors.status === 'failed' || snapshot.status === 'failed'
          ? `分歧已按选择 B 解决并落库（新原则 #${outcome.row.id} 已写入，旧条目已标为被替代，不是回滚）；只是后置步骤没全部完成，见 vectors / snapshot。不用再拍一次板；重试：${RETRY_IMPORT}`
          : null,
    };
  }

  /* ---------- 凝结 ---------- */

  async concresce(args: { scope?: string }) {
    const scope = this.scope(args.scope);
    const llm = this.llmConfig();
    const model = this.options.model ?? (llm ? new OpenAiCompatibleCondenseModel(llm, this.options.fetchImpl) : undefined);
    if (!model) {
      throw new NotConfiguredError(
        '没有配置后台模型，这次凝结没有执行（也没有调用任何外部服务）。' +
          '要启用：设置 MEMLOOM_LLM_BASE_URL（任意 OpenAI 兼容端点，含 /v1）和 MEMLOOM_LLM_MODEL，需要凭据时再加 MEMLOOM_LLM_API_KEY；' +
          '启用即表示凝结时会把待处理经历、现有原则和铁律发给这个端点。',
      );
    }
    const pendingBefore = this.store.countPendingExperiences(scope);
    const result = await condense({ store: this.store, scope, model, reason: 'manual', judge: this.options.judge, now: () => this.now() });
    return { scope, model: model.id, pendingBefore, result };
  }

  /* ---------- 导出 / 导入 ---------- */

  exportArchive(args: { scope?: string; outPath?: string }) {
    const scope = this.scope(args.scope);
    const at = this.now();
    const outPath = args.outPath ? resolve(args.outPath) : join(this.ctx.home, 'exports', defaultArchiveName(scope, at));
    if (!args.outPath) mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
    const report = exportArchive({ store: this.store, scope, outPath, projectDir: this.ctx.projectDir, now: () => at });
    return {
      ...report,
      note: '包里只有纯文本：没有 SQLite、向量字节、模型和缓存；常见格式的凭据已掩蔽（见 masked），但 memloom 不能保证识别所有秘密，建议人手目检一遍',
    };
  }

  async importArchive(args: { scope?: string; archivePath: string; mode?: string }) {
    const scope = this.scope(args.scope);
    const mode: ImportMode = args.mode === undefined || args.mode === 'merge' ? 'merge' : args.mode === 'replace' ? 'replace' : (() => {
      throw new UsageError(`import 的 mode 只能是 merge（默认）或 replace，收到的是「${args.mode}」`);
    })();
    // 纯配置问题（例如只给了 API 地址却没给模型名）在落库前就拒绝：这时库里什么都没写
    const retriever = this.retrieverFor('导入');
    const report = await importArchive({ store: this.store, scope, archivePath: args.archivePath, mode, projectDir: this.ctx.projectDir, projectId: this.ctx.projectId, judge: this.options.judge, now: () => this.now() });
    // 事务已提交：下面每一步都单独保护，失败只报告、不改写已落库的事实
    const vectors = await this.reindexSafe(scope, retriever);
    const snapshot = this.snapshotSafe(scope);
    const post = { team: { ...report.team }, vectors, snapshot };
    const post_failures = report.team.failed.length + (vectors.status === 'failed' ? 1 : 0) + (snapshot.status === 'failed' ? 1 : 0);
    const notice =
      post_failures > 0
        ? `数据库已提交（铁律新增 ${report.iron_rules.added}、原则新增 ${report.principles.added}、经历新增 ${report.experiences.added}，不是回滚，请勿误以为没导入）；有 ${post_failures} 处后置步骤没完成，见 post。重试：${RETRY_IMPORT}`
        : null;
    return { ...report, committed: true, post, post_failures, notice, vectors, snapshot, retry: post_failures > 0 ? RETRY_IMPORT : null };
  }

  /** 落库前先把检索器造出来：纯配置无效就在这里拒绝（此时什么都没写） */
  private retrieverFor(what: string): Retriever {
    try {
      return this.retriever;
    } catch (error) {
      throw new UsageError(`${what}前的配置检查没过，什么都没写：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 导入 / 拍板已经落库之后的向量重建：出错只报告，不抛 */
  private async reindexSafe(scope: string, retriever: Retriever): Promise<VectorReport> {
    try {
      return await this.reindex(scope, retriever);
    } catch (error) {
      return {
        status: 'failed',
        indexed: 0,
        failed: 0,
        scanned: 0,
        model: retriever.modelId,
        health: null,
        reason: error instanceof Error ? error.message : String(error),
        note: `向量重建这一步出错（记录已经落库，不是回滚）。重试：${RETRY_IMPORT}`,
      };
    }
  }

  /** 导入 / 拍板已经落库之后的可读快照：出错只报告，不抛 */
  private snapshotSafe(scope: string): SnapshotReport {
    try {
      return { status: 'ok', error: null, retry: null, ...this.writeSnapshot(scope) };
    } catch (error) {
      return {
        status: 'failed',
        dir: this.snapshotDir(scope),
        files: [],
        error: error instanceof Error ? error.message : String(error),
        retry: `可读快照只是数据库的单向视图，不影响记忆本身；修好目录权限后${RETRY_IMPORT}`,
      };
    }
  }

  /** 导入 / 接替之后按作用域补建缺失的向量；没有模型就如实说没有建，并给出重试办法。 */
  async reindex(scope: string, retriever: Retriever = this.retriever): Promise<VectorReport> {
    const health = await retriever.health();
    if (retriever.dimensions <= 0) {
      return {
        status: 'degraded',
        indexed: 0,
        failed: 0,
        scanned: 0,
        model: retriever.modelId,
        health,
        reason: health.detail ?? '当前没有可用的向量模型（fts-only）',
        note: '记录已经落库，但向量没有建：当前没有可用的向量模型，召回只有字面结果。配好模型后重新执行 memloom import <同一个包> 即可补建（重复导入不会产生重复记录）',
      };
    }
    const result = await rebuildVectors({ store: this.store, scope, retriever, maxRows: 5000 });
    return {
      status: result.reason || result.failed > 0 ? 'failed' : 'ok',
      indexed: result.embedded,
      failed: result.failed,
      scanned: result.scanned,
      model: result.modelId,
      health,
      reason: result.reason,
      note:
        result.reason || result.failed > 0
          ? `向量没有全部建完（${result.reason ?? `失败 ${result.failed} 条`}）。记录已经落库；修好检索服务后重新执行 memloom import <同一个包> 即可补建（重复导入不会产生重复记录）`
          : null,
    };
  }

  /** 快照目录：个人 / 项目按作用域；角色带项目编号（两个项目的同名角色各写各的，不互相覆盖）。 */
  private snapshotDir(scope: string): string {
    if (scope.startsWith('role:')) return join(this.ctx.home, 'readable', scopeSlug(`project:${this.ctx.projectId ?? 'none'}`), scopeSlug(scope));
    return join(this.ctx.home, 'readable', scopeSlug(scope));
  }

  /** 重新生成人可读的 Markdown 快照（不写进项目目录，项目联动写视图留给 M4）。 */
  writeSnapshot(scope: string): { dir: string; files: string[] } {
    const dir = this.snapshotDir(scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const standing = join(dir, 'STANDING.md');
    const principles = join(dir, 'PRINCIPLES.md');
    writeFileSync(standing, renderStanding(scope, this.store.listIronRules(scope, { activeOnly: false })));
    writeFileSync(principles, renderPrinciples(scope, this.store.listPrinciples(scope, { status: 'all' })));
    return { dir, files: [standing, principles] };
  }

  /* ---------- 共享检索服务：只探测、安全停止 ---------- */

  async daemon(args: { action: string }) {
    if (args.action === 'status') return { action: 'status', status: await daemonStatus(this.ctx.stateDir) };
    if (args.action === 'stop') return { action: 'stop', ...(await daemonStop(this.ctx.stateDir)) };
    throw new UsageError(`daemon 的 action 只能是 status 或 stop，收到的是「${args.action}」`);
  }

  /* ---------- 体检（不启动模型、不建库） ---------- */

  async doctor() {
    const ctx = this.ctx;
    const retriever = this.retriever;
    const health = await retriever.health();
    const llm = this.llmConfig();
    const daemonState: DaemonStatus = await daemonStatus(ctx.stateDir);
    const db: { path: string; exists: boolean; bytes: number | null } = { path: ctx.dbPath, exists: existsSync(ctx.dbPath), bytes: null };
    let integrity: Record<string, unknown> | null = null;
    let counts: Record<string, unknown> | null = null;
    if (db.exists) {
      const stats = statSync(ctx.dbPath);
      db.bytes = stats.size;
      const store = this.store;
      const scope = ctx.scope;
      const capacity = store.capacity(scope);
      const missing = {
        principles: retriever.dimensions > 0 ? store.listPrinciplesNeedingEmbedding(scope, retriever.modelId, retriever.dimensions * 4, 5000).length : null,
        experiences: retriever.dimensions > 0 ? store.listExperiencesNeedingEmbedding(scope, retriever.modelId, retriever.dimensions * 4, 5000).length : null,
      };
      integrity = { journal_mode: store.pragma('journal_mode'), foreign_keys: store.pragma('foreign_keys'), quick_check: store.pragma('quick_check') };
      counts = {
        scope,
        iron_rules_active: store.listIronRules(scope).length,
        iron_rules_total: store.listIronRules(scope, { activeOnly: false }).length,
        principles_active: capacity.activeCount,
        principles_history: store.listPrinciples(scope, { status: 'all' }).length - capacity.activeCount,
        principle_chars: capacity.activeChars,
        capacity: { soft_count: capacity.softCount, hard_count: capacity.hardCount, hard_chars: capacity.hardChars, core: `${capacity.coreCount}/${capacity.maxCore}`, near_limit: capacity.nearLimit },
        experiences: store.listExperiences(scope, { limit: 1_000_000 }).length,
        experiences_pending: store.countPendingExperiences(scope),
        dilemmas_open: store.listDilemmas(scope).length,
        embeddings_missing: missing,
      };
    }
    return {
      version: VERSION,
      platform: `${process.platform} ${process.arch} node ${process.version}`,
      home: ctx.home,
      state_dir: ctx.stateDir,
      db,
      integrity,
      counts,
      retriever: { mode: health.mode, ok: health.ok, detail: health.detail ?? null, config: describeRetrieverConfig(this.retrieverConfig()) },
      daemon: daemonState,
      llm: llm
        ? { configured: true, endpoint: describeLlm(llm), notice: '启用即表示凝结时会把待处理经历、现有原则和铁律发给这个端点；凭据只在内存里' }
        : { configured: false, notice: '未配置：concresce 会明确拒绝执行，不会调用任何外部服务' },
    };
  }
}

/** 配置说明里只露主机、模型名和「有没有凭据」，绝不带凭据本身。 */
function describeRetrieverConfig(config: RetrieverConfig): Record<string, unknown> {
  switch (config.mode) {
    case 'local-onnx':
      return { mode: config.mode, state_dir: config.stateDir, model_dir: config.modelDir, idle_ms: config.idleMs ?? null };
    case 'api':
      return {
        mode: config.mode,
        endpoint: new URL(config.baseUrl).host,
        embed_model: config.embedModel,
        rerank_model: config.rerankModel,
        dimensions: config.dimensions,
        has_key: Boolean(config.apiKey),
      };
    case 'fts-only':
      return { mode: config.mode };
    case 'auto': {
      const api = config.api;
      return {
        mode: config.mode,
        state_dir: config.stateDir ?? null,
        model_dir: config.modelDir ?? null,
        api: api ? { endpoint: new URL(api.baseUrl).host, embed_model: api.embedModel, rerank_model: api.rerankModel, has_key: Boolean(api.apiKey) } : null,
      };
    }
  }
}
