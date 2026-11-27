#!/usr/bin/env node
/**
 * memloom 命令行入口（规格 §8）：recall / capture / iron-rules / dilemmas / concresce / export / import / daemon / doctor。
 * 只做参数解析和把结果排成大白话中文；业务全在 core / retriever / portable，命令行和 MCP 共用 src/app/ops.ts 这一层。
 * 退出码：0 正常；1 用法错或失败；2 「没配置后台模型」这类什么都没做的情况。
 */
import { resolveContext } from '../app/context.js';
import { Memloom, NotConfiguredError, UsageError } from '../app/ops.js';
import { projectCraft, refreshBrief, trustedCrewCli } from '../host/crew.js';
import { hookCliMain } from '../host/hook-cli.js';

const USAGE = `memloom —— 把 AI Agent 干活攒下的经历织成工作原则

用法：memloom <命令> [参数]

  recall <查询文字> [--limit N]            按语义 + 字面召回相关的原则与经历
  capture --kind <类型> --summary <一句话> [--evidence <原话>] [--session <会话>]
                                           手动记一条经历（类型：correction / preference / pitfall / decision / fact）
  capture --message <用户原话> --session <会话> --turn <轮数>
                                           按原话检测纠错信号，命中就记一条 correction
  iron-rules list | add <铁律正文> | disable <编号>
                                           置顶铁律：只有这些显式的人工入口能改
  dilemmas list [--all]                    看真分歧队列
  dilemmas resolve <编号> --choice A|B --confirm <编号>
        [--target <原则编号> --trigger <场景> --rule <准则> [--rationale <来由>] [--core]]
                                           用户拍板：A 保留现有原则；B 用你逐字段给出的新原则接替目标原则
  concresce                                手动凝结一次（需要配置后台模型）
  export [--out <文件.tar.gz>]             打包成纯文本归档（默认写到 <home>/exports/）
  import <文件.tar.gz> [--mode merge|replace]
                                           导入归档（默认 merge；replace 会把包里没有的生效原则软退役留底）
  daemon status | stop                     查看或安全停止共享检索服务（不启动、不杀未知进程）
  doctor                                   体检：配置、库、检索模式、容量（不启动模型）
  hook --event                            宿主子进程入口：stdin 读一条 HostEvent 的 JSON，stdout 写一条 HostResponse 的 JSON（Pi 进程内常驻请直接用 src/host/index.ts 的 HostCore）；永远退出 0
  craft sync [--brief]                     把当前项目 / 角色作用域的生效原则单向投到 .team/CRAFT.md 的 memloom 管理区（需要 --project [--role]）；
                                           --brief 再用 MEMLOOM_CREW_CLI 指定的可信 agent-crew CLI 刷新 .team/BRIEF.md，没配置就提示手动

通用参数：--home <目录>（默认 ~/.memloom）、--db <库文件>、--project <项目目录>、--role <角色名>、
          --state-dir <状态目录>、--scope <作用域>、--json（按 JSON 输出）
环境变量：MEMLOOM_HOME / MEMLOOM_DB / MEMLOOM_PROJECT / MEMLOOM_ROLE / MEMLOOM_STATE_DIR / MEMLOOM_SCOPE、
          检索配置见 README「本地运行（M2）」、后台模型 MEMLOOM_LLM_BASE_URL / MEMLOOM_LLM_MODEL / MEMLOOM_LLM_API_KEY
`;

interface Args {
  words: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'all', 'core', 'brief', 'event']);

function parseArgs(argv: readonly string[]): Args {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      const next = argv[index + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        index += 1;
      }
    } else {
      words.push(token);
    }
  }
  return { words, flags };
}

function flag(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function has(args: Args, name: string): boolean {
  return args.flags[name] === true;
}

/** 排版用的键：带子命令的命令里，只有 dilemmas resolve 要单独排 */
function renderKey(command: string): string {
  return command === 'dilemmas resolve' ? command : (command.split(' ')[0] as string);
}

/** 事务提交之后的三个后置步骤分别报：成功 / 正常退化 / 失败（原因 + 重试）；有失败时先写明「已落库，不是回滚」。 */
function postLines(r: Record<string, unknown>): string {
  const post = (r.post ?? {}) as { team?: { failed?: Array<{ path: string; reason: string }> }; vectors?: Record<string, unknown>; snapshot?: Record<string, unknown> };
  const lines: string[] = [];
  for (const item of post.team?.failed ?? []) lines.push(`  .team 文件没能写：${item.path}：${item.reason}`);
  const vectors = post.vectors ?? (r.vectors as Record<string, unknown> | undefined);
  if (vectors) lines.push(`  向量：${String(vectors.note ?? `已补建 ${String(vectors.indexed)} 条，失败 ${String(vectors.failed)} 条（模型 ${String(vectors.model)}）`)}`);
  const snapshot = post.snapshot ?? (r.snapshot as Record<string, unknown> | undefined);
  if (snapshot?.status === 'failed') lines.push(`  可读快照没刷新：${String(snapshot.error)}。重试：${String(snapshot.retry)}`);
  else lines.push(`  可读快照已刷新：${(snapshot?.files as string[] | undefined)?.join('，') ?? ''}`);
  if (((r.post_failures as number | undefined) ?? 0) > 0) lines.push(`  注意：${String(r.notice)}`);
  return lines.join('\n');
}

/** 把结果排成大白话；--json 时直接打印原始数据。 */
function render(command: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  switch (renderKey(command)) {
    case 'recall': {
      const mode = r.mode as Record<string, unknown>;
      const items = r.items as Array<Record<string, unknown>>;
      const head = `召回「${String(r.query)}」（${String(r.scope)}）：${items.length} 条；检索档位 ${String(mode.retriever)}，阶段 ${String(mode.stage)}${mode.reranked ? '，经过模型精排' : '，没经过模型精排（字面分或向量余弦，不冒充语义分）'}，耗时 ${String((r.elapsedMs as Record<string, unknown>).total)} 毫秒`;
      const body = items.map((item) =>
        item.type === 'principle'
          ? `  [P${String(item.id)}] 分 ${String(item.score)}（强度 ${String(item.strength)}）${String(item.trigger_when)}：${String(item.rule)}`
          : `  [E${String(item.id)}] 分 ${String(item.score)} ${String(item.summary)}`,
      );
      const extra = mode.vectorReason ? [`  向量粗排没做：${String(mode.vectorReason)}`] : [];
      return [head, ...body, ...extra].join('\n');
    }
    case 'capture': {
      if (r.captured === false) return `没有记录：${String(r.message)}`;
      const exp = r.experience as Record<string, unknown>;
      return [`已记下经历 #${String(exp.id)}（${String(exp.kind)}）：${String(exp.summary)}`, `当前待凝结 ${String(r.pending)} 条。${String(r.next)}`].join('\n');
    }
    case 'iron-rules': {
      if (r.rules) {
        const rules = r.rules as Array<Record<string, unknown>>;
        if (rules.length === 0) return `「${String(r.scope)}」还没有置顶铁律`;
        return [`「${String(r.scope)}」的置顶铁律：`, ...rules.map((rule) => `  #${String(rule.id)}${rule.active ? ' ' : '（已停用）'}${String(rule.content)}`)].join('\n');
      }
      if (r.added) {
        const added = r.added as Record<string, unknown>;
        return `已加铁律 #${String(added.id)}：${String(added.content)}。${String(r.note)}`;
      }
      const disabled = r.disabled as Record<string, unknown>;
      return `已停用铁律 #${String(disabled.id)}：${String(disabled.content)}。${String(r.note)}`;
    }
    case 'dilemmas': {
      const list = r.dilemmas as Array<Record<string, unknown>>;
      if (list.length === 0) return `「${String(r.scope)}」没有待拍板的分歧`;
      return [`「${String(r.scope)}」待拍板 ${String(r.open)} 条（共列出 ${list.length} 条）：`, ...list.map((d) => [`  #${String(d.id)} [${String(d.status)}] ${String(d.kind)}：${String(d.summary)}`, `      A：${String(d.option_a)}`, `      B：${String(d.option_b)}${d.related_principle_ids ? `（关联原则 ${JSON.stringify(d.related_principle_ids)}）` : ''}${d.resolution ? `\n      结论：${String(d.resolution)}` : ''}`].join('\n'))].join('\n');
    }
    case 'dilemmas resolve': {
      const out = [`分歧 #${String((r.resolved as Record<string, unknown>).id)} 已按选择 ${String(r.choice)} 解决：${String((r.resolved as Record<string, unknown>).resolution)}`];
      if (r.principle) {
        const p = r.principle as Record<string, unknown>;
        out.push(`新原则 #${String(p.id)}：${String(p.trigger_when)}：${String(p.rule)}`);
      }
      if (r.superseded) out.push(`被接替的旧原则 #${String((r.superseded as Record<string, unknown>).id)} 标为「已被替代」，历史保留`);
      const vectors = r.vectors as Record<string, unknown>;
      out.push(...postLines(r).split('\n').map((line) => line.replace(/^  /, '')));
      return out.join('\n');
    }
    case 'concresce': {
      const result2 = r.result as Record<string, unknown>;
      if (result2.ran === false) return `这次没有凝结：${result2.reason === 'nothing_pending' ? '没有待处理的经历' : `待处理经历 ${String(result2.pendingCount)} 条，不到阈值 ${String(result2.threshold)}`}（模型 ${String(r.model)}）`;
      if (result2.ok === false) return `凝结没有落库：${String(result2.error)}\n（经历保持待处理，修正后可以重试；模型 ${String(result2.modelId)}）`;
      const actions = result2.actions as Array<Record<string, unknown>>;
      return [`凝结完成（模型 ${String(result2.modelId)}，处理经历 ${(result2.processedExperienceIds as number[]).length} 条）：`, ...actions.map((a) => `  ${String(a.action)}${a.principleId ? ` → 原则 #${String(a.principleId)}` : ''}${a.dilemmaId ? ` → 分歧 #${String(a.dilemmaId)}` : ''}`)].join('\n');
    }
    case 'export': {
      const counts = r.counts as Record<string, unknown>;
      return [
        `已导出到 ${String(r.outPath)}（${String(r.bytes)} 字节，作用域 ${String(r.scope)}）`,
        `  铁律 ${String(counts.iron_rules)} 条，原则 ${String(counts.principles)} 条，经历 ${String(counts.experiences)} 条，.team 文件 ${String(counts.team_files)} 个`,
        (r.masked as unknown[]).length > 0 ? `  掩蔽了常见凭据：${JSON.stringify(r.masked)}` : '  记录里没有发现常见格式的凭据',
        (r.excluded as unknown[]).length > 0 ? `  .team 里排除的文件：\n${(r.excluded as Array<{ path: string; reason: string }>).map((e) => `    ${e.path}：${e.reason}`).join('\n')}` : '',
        String(r.omittedReferences) !== '0' ? `  有 ${String(r.omittedReferences)} 处来源经历没被选进包里，引用已省略` : '',
        `  ${String(r.note)}`,
      ]
        .filter((line) => line !== '')
        .join('\n');
    }
    case 'import': {
      const iron = r.iron_rules as Record<string, unknown>;
      const p = r.principles as Record<string, unknown>;
      const e = r.experiences as Record<string, unknown>;
      const team = r.team as { written: string[]; identical: number; conflicts: Array<{ path: string; reason: string }> };
      const vectors = r.vectors as Record<string, unknown>;
      const out = [
        `导入完成（${String(r.mode)}，作用域 ${String(r.scope)}；归档导出于 ${String((r.archive as Record<string, unknown>).exported_at)}）`,
        `  铁律：新增 ${String(iron.added)}，已有跳过 ${String(iron.skipped)}（本地铁律从不被改动）${(iron.state_conflicts as unknown[] | undefined)?.length ? `，其中 ${(iron.state_conflicts as unknown[]).length} 条启停状态和归档不同、以本地为准` : ''}`,
        `  原则：新增 ${String(p.added)}，同一件事合并血缘 ${String(p.merged)}${Number(p.merged_semantic) > 0 ? `（语义判定 ${String(p.merged_semantic)}）` : ''}，软退役 ${String(p.retired_by_replace)}，常驻核心降级 ${String(p.core_demoted)}，冲突未导 ${String((p.conflicts as unknown[]).length)}`,
        `  经历：新增 ${String(e.added)}，已有跳过 ${String(e.skipped)}；省略的引用 ${String(r.omitted_references)} 处`,
      ];
      for (const c of p.conflicts as Array<Record<string, unknown>>) out.push(`  冲突：归档 ${String(c.ref)} ↔ 本地原则 #${String(c.local_id)}：${String(c.reason)}`);
      if (team.written.length > 0 || team.identical > 0 || team.conflicts.length > 0) {
        out.push(`  .team 文件：新写 ${team.written.length}，已有一致 ${team.identical}，内容不同未覆写 ${team.conflicts.length}`);
        for (const c of team.conflicts) out.push(`    ${c.path}：${c.reason}`);
      }
      out.push(postLines(r));
      if ((r.masked as unknown[]).length > 0) out.push(`  导入时又掩蔽了凭据：${JSON.stringify(r.masked)}`);
      return out.join('\n');
    }
    case 'daemon': {
      const status = (r.status ?? r) as Record<string, unknown>;
      const state = String(status.state);
      const head =
        state === 'running'
          ? `共享检索服务在运行：pid=${String(status.pid)}（${status.identity === 'memloom-retriever' ? 'memloom 自己的服务' : '身份认不出'}），${String(status.note)}；模型 ${String(status.modelId)}，驻留约 ${String(status.rssMiB)} MiB，闲置 ${String(status.idleSeconds)} 秒后退出，在途请求 ${String(status.inFlight)}`
          : state === 'starting-or-busy'
            ? `共享检索服务正在启动或正忙${status.pid ? `（pid=${String(status.pid)}）` : ''}：${String(status.note)}`
            : state === 'stale'
              ? `共享检索服务没有在运行；${String(status.note)}`
              : '共享检索服务没有在运行（下一次检索会按需自动拉起）';
      return r.message ? `${String(r.message)}\n${head}` : `${head}\n状态目录 ${String(status.stateDir ?? '')}`;
    }
    case 'craft': {
      const craft = r.craft as Record<string, unknown>;
      const brief = r.brief as Record<string, unknown> | null;
      const lines = [`CRAFT（${String(craft.scope)}）：${craft.status === 'ok' ? `已写入 ${String(craft.written)} 条到 ${String(craft.path)}` : craft.status === 'unchanged' ? '内容和数据库一致，没有改动' : String(craft.note)}`];
      if (craft.note && craft.status !== 'skipped') lines.push(`  ${String(craft.note)}`);
      if (brief) lines.push(`速览：${brief.status === 'ok' ? String(brief.note) : brief.status === 'manual' ? `${String(brief.note)}；${String(brief.manual)}` : String(brief.note)}`);
      else lines.push('速览：没有加 --brief，BRIEF.md 没有刷新（它只由 agent-crew 的 crew brief --write 渲染）');
      return lines.join('\n');
    }
    case 'doctor': {
      const db = r.db as Record<string, unknown>;
      const retriever = r.retriever as Record<string, unknown>;
      const daemon = r.daemon as Record<string, unknown>;
      const llm = r.llm as Record<string, unknown>;
      const counts = r.counts as Record<string, unknown> | null;
      const out = [
        `memloom ${String(r.version)}，${String(r.platform)}`,
        `库：${String(db.path)}（${db.exists ? `${String(db.bytes)} 字节` : '还不存在，第一次写入时会建'}）`,
      ];
      if (r.integrity) {
        const integrity = r.integrity as Record<string, unknown>;
        out.push(`  完整性：journal_mode=${String(integrity.journal_mode)}，foreign_keys=${String(integrity.foreign_keys)}，quick_check=${String(integrity.quick_check)}`);
      }
      if (counts) {
        const capacity = counts.capacity as Record<string, unknown>;
        const missing = counts.embeddings_missing as Record<string, unknown>;
        out.push(
          `  作用域 ${String(counts.scope)}：铁律 ${String(counts.iron_rules_active)}/${String(counts.iron_rules_total)} 条生效，原则 ${String(counts.principles_active)} 条生效（${String(counts.principle_chars)}/${String(capacity.hard_chars)} 字，${String(capacity.core)} 常驻核心${capacity.near_limit ? '，接近上限' : ''}），历史 ${String(counts.principles_history)} 条；经历 ${String(counts.experiences)} 条（待凝结 ${String(counts.experiences_pending)}）；待拍板分歧 ${String(counts.dilemmas_open)} 条`,
        );
        out.push(`  缺向量：原则 ${String(missing.principles ?? '（当前模式不产生向量）')}，经历 ${String(missing.experiences ?? '（当前模式不产生向量）')}`);
      }
      out.push(`检索：${String(retriever.mode)}${retriever.ok ? '（可用）' : '（不可用，召回只有字面结果）'}；${String(retriever.detail ?? '')}`);
      out.push(`  配置：${JSON.stringify(retriever.config)}`);
      const daemonText =
        daemon.state === 'running'
          ? `在运行（pid=${String(daemon.pid)}，${String(daemon.note)}）`
          : daemon.state === 'starting-or-busy'
            ? `正在启动或正忙：${String(daemon.note)}`
            : daemon.state === 'stale'
              ? `没有在运行；${String(daemon.note)}`
              : '没有在运行（下一次检索会按需自动拉起）';
      out.push(`共享检索服务：${daemonText}`);
      out.push(`后台模型：${llm.configured ? `已配置 → ${String(llm.endpoint)}。${String(llm.notice)}` : String(llm.notice)}`);
      out.push(`状态目录 ${String(r.state_dir)}，home ${String(r.home)}`);
      return out.join('\n');
    }
    default:
      return JSON.stringify(result, null, 1);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.words.length === 0 || has(args, 'help') || args.flags.h === true) {
    process.stdout.write(`${USAGE}\n`);
    return has(args, 'help') || args.flags.h === true ? 0 : 1;
  }
  const command = args.words[0] as string;
  const sub = args.words[1];
  const commandKey = (command === 'iron-rules' || command === 'dilemmas' || command === 'daemon' || command === 'craft') && sub ? `${command} ${sub}` : command;
  const json = has(args, 'json');
  if (command === 'hook') {
    // 原样把 hook 之后的参数交给 hook 入口（--event 之类），stdin / stdout 不经过这里的排版
    const raw = process.argv.slice(process.argv.indexOf('hook') + 1);
    return hookCliMain(raw, process.stdin, process.stdout, process.stderr);
  }
  const ctx = resolveContext({
    home: flag(args, 'home'),
    db: flag(args, 'db'),
    project: flag(args, 'project'),
    role: flag(args, 'role'),
    stateDir: flag(args, 'state-dir'),
  });
  const scopeArg = flag(args, 'scope') ?? process.env.MEMLOOM_SCOPE;
  const app = new Memloom(ctx);
  try {
    let result: unknown;
    switch (commandKey) {
      case 'recall': {
        const query = flag(args, 'query') ?? args.words.slice(1).join(' ');
        result = await app.recall({ scope: scopeArg, query, limit: Number(flag(args, 'limit') ?? 10) });
        break;
      }
      case 'capture': {
        const message = flag(args, 'message');
        result = app.capture({
          scope: scopeArg,
          kind: flag(args, 'kind'),
          summary: flag(args, 'summary') ?? (message === undefined ? args.words.slice(1).join(' ') || undefined : undefined),
          evidence: flag(args, 'evidence'),
          sourceSession: flag(args, 'session', 'source-session'),
          message,
          sessionId: flag(args, 'session'),
          turn: flag(args, 'turn') === undefined ? undefined : Number(flag(args, 'turn')),
        });
        break;
      }
      case 'iron-rules list':
      case 'iron-rules add':
      case 'iron-rules disable': {
        const action = (commandKey as string).split(' ')[1] as string;
        result = app.ironRules({ scope: scopeArg, action, content: flag(args, 'content') ?? args.words[2], id: flag(args, 'id') ?? args.words[2] });
        break;
      }
      case 'dilemmas list':
        result = app.dilemmasList({ scope: scopeArg, all: has(args, 'all') });
        break;
      case 'dilemmas resolve':
        result = await app.dilemmaResolve({
          scope: scopeArg,
          id: flag(args, 'id') ?? args.words[2] ?? '',
          choice: flag(args, 'choice'),
          confirm: flag(args, 'confirm') ?? '',
          targetId: flag(args, 'target', 'target-id'),
          triggerWhen: flag(args, 'trigger', 'trigger-when'),
          rule: flag(args, 'rule'),
          rationale: flag(args, 'rationale'),
          isCore: has(args, 'core'),
        });
        break;
      case 'concresce':
        result = await app.concresce({ scope: scopeArg });
        break;
      case 'export':
        result = app.exportArchive({ scope: scopeArg, outPath: flag(args, 'out') });
        break;
      case 'import':
        if (!sub) throw new UsageError('import 需要归档文件路径：memloom import <文件.tar.gz> [--mode merge|replace]');
        result = await app.importArchive({ scope: scopeArg, archivePath: sub, mode: flag(args, 'mode') });
        break;
      case 'daemon status':
      case 'daemon stop':
        result = await app.daemon({ action: (commandKey as string).split(' ')[1] as string });
        break;
      case 'doctor':
        result = await app.doctor();
        break;
      case 'craft sync': {
        const scope = app.scope(scopeArg);
        if (app.ctx.projectDir === null) throw new UsageError('craft sync 只对项目 / 角色作用域有意义：请加 --project <项目目录>（角色再加 --role <角色名>）；个人库不往任何 Markdown 投影');
        const craft = projectCraft({ projectDir: app.ctx.projectDir, store: app.store, scope });
        const brief = has(args, 'brief') ? await refreshBrief({ crewCliPath: process.env.MEMLOOM_CREW_CLI?.trim() || null, projectDir: app.ctx.projectDir }) : null;
        result = { craft, brief };
        break;
      }
      case 'craft':
        throw new UsageError('「craft」后面要跟子命令：craft sync [--brief]');
      case 'iron-rules':
      case 'dilemmas':
      case 'daemon':
        throw new UsageError(`「${command}」后面要跟子命令（${command === 'iron-rules' ? 'list / add / disable' : command === 'dilemmas' ? 'list / resolve' : 'status / stop'}）`);
      default:
        throw new UsageError(`不认识的命令「${command}」；运行 memloom --help 看用法`);
    }
    const output = json ? `${JSON.stringify(result, null, 1)}\n` : `${render(commandKey, result)}\n`;
    // 模型给了计划但没通过校验：如实算失败（经历保持待处理），不报成功
    const condense = result as { result?: { ran?: boolean; ok?: boolean } } | undefined;
    const failed = commandKey === 'concresce' && condense?.result?.ran === true && condense.result.ok === false;
    (failed ? process.stderr : process.stdout).write(output);
    if (failed) return 1;
    // 已落库但后置步骤有失败：用非零退出表示「部分失败」，回执里已经先写明「已落库，不是回滚」
    const flow = result as { committed?: boolean; post_failures?: number } | undefined;
    return flow?.committed === true && (flow.post_failures ?? 0) > 0 ? 1 : 0;
    return 0;
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`出错：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`出错：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
