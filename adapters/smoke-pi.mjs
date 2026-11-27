#!/usr/bin/env node
/**
 * memloom Pi 适配的回环冒烟（可重复）：真实 pi 进程 + 只听 127.0.0.1 的模拟模型端点 + 全部落在临时目录的隔离环境。
 *   node adapters/smoke-pi.mjs [--core real|fixture|both] [--keep] [--pi <pi 可执行文件>]
 * - real   ：接真实核心 dist/src/host/index.js（先 npm run build）。没有语义模型时提醒保持安静，这里验证的是：
 *            静态区在真实模型请求里字节稳定、`-c` 续会话沿用同一会话号、真实工具失败、中文纠错经真实核心即时入库。
 * - fixture：MEMLOOM_HOST_ENTRY 指向按脚本回话的夹具核心，验证提醒在真实模型请求里的落点（紧跟用户话 / 紧跟工具结果）
 *            和压缩、关会话事件确实被胶水映射；夹具不是核心，不能代替 real 那一档。
 * 不发外网（模型端点就是本脚本起的回环服务），不碰真实 ~/.pi、~/.memloom 和真实密钥（子进程环境是重新拼的），退出前删临时目录。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const keep = argv.includes('--keep');
const mode = option('--core', 'both');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const piBin = option('--pi', 'pi');
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
/** 请求消息的 content 可能是字符串，也可能是 [{type:'text',text}] 分块数组 */
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n') : String(content ?? ''));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '通过' : '没过'}  ${name}${detail ? `  —— ${detail}` : ''}`);
};

/* ---------- 回环模拟模型端点（OpenAI 兼容 /v1/chat/completions）：只听 127.0.0.1，记录每个请求 ---------- */
function startMock(logPath) {
  let requestCount = 0; // 保险：超过 60 个请求就不再调工具，免得脚本判定有误时无限循环
  const server = createServer((req, res) => {
    requestCount += 1;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let request = {};
      try { request = JSON.parse(body); } catch { /* 不是 JSON 就当空请求 */ }
      const messages = request.messages ?? [];
      const content = (message) => textOf(message.content);
      // 宿主自己的压缩摘要请求：首条用户话是它整理的对话转录（# Conversation … / <conversation> …），不带主 system。
      // 不能按正文关键词判：压缩后的主请求正文里也带着摘要文字
      const firstUser = messages.find((m) => m.role === 'user');
      const summary = /^(# Conversation|<conversation>)/.test(content(firstUser ?? {}));
      appendFileSync(logPath, `${JSON.stringify({ path: req.url, summary, messages })}\n`);
      // 最后一条「不是 memloom 注入」的用户话说要跑会失败的命令，就让模型去调一次 bash（真实失败：exit 7）；
      // 这轮原话之后已经出现过工具结果就只回复——提醒会作为 user 消息排在工具结果后面，不能靠「最后一条是不是 tool」判断
      const promptIndex = messages.findLastIndex((m) => m.role === 'user' && !/^<(memory-hint|memloom-standing)/.test(content(m)));
      const toolAnswered = messages.slice(promptIndex + 1).some((m) => m.role === 'tool');
      const wantsFailure = promptIndex >= 0 && /会失败的命令/.test(content(messages[promptIndex]));
      // 首轮一次发 3 个会失败的调用，造出「同一个工具批次多个失败」；以后各轮只回复
      const toolCalls = !summary && !toolAnswered && wantsFailure && requestCount < 60
        ? [7, 8, 9].map((code) => ({ id: `call_${code}_ ${createHash('sha1').update(String(messages.length)).digest('hex').slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `exit ${code}` }) } }))
        : undefined;
      const text = toolCalls ? null : summary ? '模拟摘要：之前只是几轮探针对话。' : '模拟回复：收到。';
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        if (toolCalls) {
          toolCalls.forEach((call, index) => res.write(chunk({ role: 'assistant', tool_calls: [{ index, ...call }] }, null)));
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: text }, null));
          res.write(chunk({}, 'stop'));
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: request.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text, tool_calls: toolCalls }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/* ---------- 夹具核心：按契约形状回话，并把它收到的每条事件落日志 ---------- */
const FIXTURE_CORE = `
import { appendFileSync } from 'node:fs';
const LOG = process.env.FIXTURE_LOG;
const STANDING = '<memloom-standing>\\n<iron-rules>\\n- 夹具铁律：没有明说就不擅自动手。\\n</iron-rules>\\n<tools>夹具</tools>\\n</memloom-standing>';
const HINT = '<memory-hint>\\n- [P12] 递归删除目录前先检查是不是软链接。\\n</memory-hint>';
export function resolveHostConfig() { return {}; }
export class HostCore {
  handle(event) {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...event }) + '\\n');
    const base = { event: event.type, sessionId: event.sessionId, scope: 'personal', hint: '', hintState: 'off', dilemmaNotice: '',
      correction: { captured: false, experienceId: null, reason: null }, background: [], elapsedMs: { total: 0, hint: null } };
    if (event.type === 'session_start') return Promise.resolve({ ...base, staticBlock: STANDING, dilemmaNotice: '顺带一提（夹具）：记忆里有 3 处拿不准的规则分歧。' });
    if (event.type === 'user_message') { const hit = /软链接/.test(event.text); return Promise.resolve({ ...base, hint: hit ? HINT : '', hintState: hit ? 'hinted' : 'silent' }); }
    if (event.type === 'tool_result') { const eligible = event.isError === true && event.skipHint !== true; return Promise.resolve({ ...base, hint: eligible ? HINT : '', hintState: eligible ? 'hinted' : 'off' }); }
    return Promise.resolve(base);
  }
  close() { appendFileSync(LOG, JSON.stringify({ t: Date.now(), closed: true }) + '\\n'); }
}
`;

const FIRST_IRON_RULE = '没有明说怎么处理就不许擅自动手改用户的项目文件。';
const SECOND_IRON_RULE = '第二条铁律：改完要先跑测试再提交。';
const TURNS = [
  '帮我跑一个会失败的命令，然后说说软链接要注意什么。',
  '不对，删目录之前要先看一眼是不是软链接，别直接删。',
  '换个小话题：今天先到这，谢谢。',
  '最后再确认一下软链接的事。',
];

async function run(modeName) {
  console.log(`\n========== ${modeName === 'real' ? '真实核心' : '夹具核心'} ==========`);
  const root = mkdtempSync(join(tmpdir(), `memloom-m4-pi-${modeName}-`));
  const home = join(root, 'memloom');
  const agentDir = join(root, 'agent');
  const sessions = join(root, 'sessions');
  const work = join(root, 'work');
  const logs = join(root, 'logs');
  for (const dir of [home, agentDir, sessions, work, logs]) mkdirSync(dir, { recursive: true });
  const requestLog = join(logs, 'model-requests.log');
  const mock = await startMock(requestLog);
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { mockloop: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, api: 'openai-completions', apiKey: 'dummy-not-a-real-key',
    models: [{ id: 'mock-m', name: 'loopback mock', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }] } } }));

  let store = null;
  let afterFirstRun = null;
  const entry = join(repo, 'dist/src/host/index.js');
  if (modeName === 'real') {
    if (!readdirSync(join(repo, 'dist/src/host')).includes('index.js')) throw new Error('先在 memloom 仓库里 npm run build（缺 dist/src/host/index.js）');
    const { openStore } = await import(pathToFileURL(join(repo, 'dist/src/core/index.js')).href);
    store = openStore(join(home, 'personal.db'));
    const now = new Date().toISOString();
    store.addIronRule({ scope: 'personal', content: FIRST_IRON_RULE, now });
    store.insertPrinciple({ scope: 'personal', now, triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf', isCore: true });
    store.close();
    // 第 1 个进程正常退出后往同一个库加第二条铁律：续接（-c）时静态区必须还是第一份，不能悄悄重算
    afterFirstRun = () => {
      const again = openStore(join(home, 'personal.db'));
      again.addIronRule({ scope: 'personal', content: SECOND_IRON_RULE, now: new Date().toISOString() });
      again.close();
    };
  }
  const fixtureLog = join(logs, 'fixture-events.log');
  let hostEntry = entry;
  if (modeName === 'fixture') {
    hostEntry = join(root, 'fixture-core.mjs');
    writeFileSync(hostEntry, FIXTURE_CORE);
  }

  const env = {
    HOME: root, PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'dumb',
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1',
    MEMLOOM_HOME: home, MEMLOOM_WARMUP: '0', MEMLOOM_ADAPTER_DEBUG: '1', MEMLOOM_HOST_ENTRY: pathToFileURL(hostEntry).href,
    ...(modeName === 'fixture' ? { FIXTURE_LOG: fixtureLog } : {}),
  };
  // 异步起 pi：模拟模型端点和冒烟脚本在同一个进程里，同步等子进程会把事件循环堵住、回环服务就没人应答了
  const runPi = (turn, index) => {
    if (index === TURNS.length - 1) {
      // 最后一轮前把压缩阈值抬到几乎必触发，让真实宿主真的走一次压缩前事件（会话很小，所以 keepRecentTokens 也调小）
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { reserveTokens: 199900, keepRecentTokens: 20 } }));
    }
    const args = ['-ne', '-ns', '-nc', '-np', '--no-mcp', '--offline', '--mode', 'json', '--session-dir', sessions, '--tools', 'bash', '--model', 'mockloop/mock-m',
      '-e', join(repo, 'adapters/pi/index.ts'), ...(index > 0 ? ['-c'] : []), '-p', turn];
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(piBin, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (status) => {
        clearTimeout(timer);
        writeFileSync(join(logs, `pi-turn-${index + 1}.out`), `${out}\n--- stderr ---\n${err}`);
        console.log(`第 ${index + 1} 轮  pi ${index > 0 ? '-c ' : ''}-p 退出码 ${status}，用时 ${Date.now() - started} 毫秒${err.trim() ? `；stderr ${err.trim().split('\n').length} 行` : ''}`);
        resolve({ status, output: out, stderr: err });
      });
    });
  };
  const runs = [];
  for (let index = 0; index < TURNS.length; index += 1) {
    runs.push(await runPi(TURNS[index], index));
    if (index === 0 && afterFirstRun) afterFirstRun();
  }
  mock.server.close();

  /* ---------- 读模型端点实际收到的请求 ---------- */
  const logged = readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  // 宿主自己的压缩摘要调用用的是另一份 system（不带主提示），验证静态区时排除，只单独计数
  const summaries = logged.filter((entry) => entry.summary).length;
  const requests = logged.filter((entry) => !entry.summary).map((entry) => entry.messages);
  console.log(`  主对话请求 ${requests.length} 个；宿主压缩摘要请求 ${summaries} 个（不带主 system，不计入静态区比对）`);
  const tag = (message) => {
    const text = textOf(message.content);
    if (message.role === 'assistant') return message.tool_calls?.length ? 'assistant(调工具)' : 'assistant(回复)';
    if (message.role === 'tool') return /exited with code [1-9]/.test(text) ? 'tool(真实失败)' : 'tool';
    if (/^<memory-hint>/.test(text)) return '提醒(<memory-hint>)';
    if (/^<memloom-standing>/.test(text)) return '静态块(落在 user 消息)';
    return `user:「${text.slice(0, 14)}${text.length > 14 ? '…' : ''}」`;
  };
  const systemOf = (messages) => messages.find((m) => m.role === 'system');
  const systemText = (messages) => textOf(systemOf(messages)?.content);
  const section = (text, name) => text.match(new RegExp(`<${name}>\\n[\\s\\S]*?\\n</${name}>`))?.[0] ?? null;
  const layout = requests.map((messages, i) => `  请求 ${i + 1}: ${messages.filter((m) => m.role !== 'system').map(tag).join(' → ')}`);
  console.log(layout.join('\n'));

  check('每次主对话模型请求的 system 里都有 memloom 的静态 section', requests.length > 0 && requests.every((m) => section(systemText(m), 'memloom') !== null), `共 ${requests.length} 个请求`);
  const shas = new Set(requests.map((m) => sha(section(systemText(m), 'memloom') ?? '')));
  const firstStanding = section(textOf(systemOf(requests[0])?.content) ?? '', 'memloom-standing');
  check('静态 section 在全部请求里字节相同（同一会话跨 4 个进程、含工具失败与压缩之后）', shas.size === 1, `sha256 前 16 位：${[...shas].join(', ') || '无'}`);
  check('4 轮都是同一个宿主会话（-c 续接）', readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).length === 1, `会话文件：${readdirSync(sessions).join(', ') || '无'}`);
  check('pi 四次都正常退出', runs.every((run) => run.status === 0), runs.map((run) => run.status).join(','));
  const failedToolSeen = requests.some((m) => m.filter((message) => tag(message) === 'tool(真实失败)').length >= 3);
  check('同一个工具批次里有 3 个真实失败（bash exit 7 / 8 / 9）', failedToolSeen);
  check('真实工具失败确实发生并回到了模型请求（bash exit 7）', failedToolSeen);

  /** 这个请求里第一条 / 最后一条「不是 memloom 注入」的用户话后面，紧跟的是不是提醒 */
  const hintAfterUser = (index, which = 'first') => {
    const messages = requests[index] ?? [];
    const users = messages.flatMap((m, i) => (m.role === 'user' && !/^<(memory-hint|memloom-standing)/.test(textOf(m.content)) ? [i] : []));
    const userAt = which === 'last' ? users.at(-1) : users[0];
    return userAt !== undefined && tag(messages[userAt + 1] ?? {}) === '提醒(<memory-hint>)';
  };
  const hintAfterTool = () => requests.some((messages) => messages.some((m, i) => tag(m) === 'tool(真实失败)' && tag(messages[i + 1] ?? {}) === '提醒(<memory-hint>)'));
  const hintCount = requests.flat().filter((m) => tag(m) === '提醒(<memory-hint>)').length;

  if (modeName === 'real') {
    check('没有语义模型（fts-only）时提醒保持安静：请求里没有任何 <memory-hint>', hintCount === 0, `提醒条数 ${hintCount}`);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(home, 'personal.db'), { readOnly: true });
    const corrections = db.prepare("SELECT id, kind, summary, source_session FROM experiences WHERE kind = 'correction'").all();
    db.close();
    check('中文纠错经真实核心即时入库（第 2 轮原话 → experiences 里一条 correction）', corrections.length === 1 && corrections[0].id > 0, corrections.map((row) => `#${row.id} ${row.summary}（来源会话 ${String(row.source_session).slice(0, 8)}…）`).join('；') || '一条都没有');
    const firstRuleOnly = requests.every((m) => systemText(m).includes(FIRST_IRON_RULE) && !systemText(m).includes(SECOND_IRON_RULE));
    check('第 1 个进程退出后往库里加了第二条铁律，-c 续接的静态段仍是第一份（不含第二条）', shas.size === 1 && firstRuleOnly, firstRuleOnly ? '' : '续接时静态区被重算了（核心在 session_end 时仍删会话状态？）');
    // 关会话后：对话已清，只留静态区 / 去重游标这类必要小状态到 TTL；文件和目录只有本人可读
    const dir = join(home, 'sessions');
    const entries = readdirSync(dir);
    const sessionId = readdirSync(sessions).find((name) => name.endsWith('.jsonl'))?.replace(/^.*_/, '').replace(/\.jsonl$/, '');
    const stateName = entries.find((name) => name.startsWith(`${sessionId}.`) && name.endsWith('.json'));
    const state = stateName ? JSON.parse(readFileSync(join(dir, stateName), 'utf8')) : null;
    const privateModes = (statSync(dir).mode & 0o077) === 0 && entries.every((name) => (statSync(join(dir, name)).mode & 0o077) === 0);
    check('关会话后会话状态不再整份删：无对话、静态区原样保留、去重游标还在', state !== null && Array.isArray(state.messages) && state.messages.length === 0 && typeof state.staticBlock === 'string' && state.staticBlock === firstStanding && Array.isArray(state.remindedKeys), state === null ? '会话状态文件不存在（核心在 session_end 时仍删状态？）' : `messages=${state.messages?.length} staticBlock=${typeof state.staticBlock} remindedKeys=${state.remindedKeys?.length}`);
    check('会话状态目录与文件只有本人可读（0700 / 0600），没有残留锁文件', privateModes && !entries.some((name) => name.endsWith('.lock')), entries.join(', '));
  } else {
    check('当轮提醒紧跟在用户话之后（第 1 轮首个请求）', hintAfterUser(0));
    check('工具失败后的提醒紧跟在工具结果之后，且下一次模型请求才看得到', hintAfterTool());
    const events = readFileSync(fixtureLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const toolEvents = events.filter((e) => e.type === 'tool_result');
    check('同一批次的 3 个真实失败都报到核心：首个不带 skipHint，后两个带 skipHint:true，输出一条不少', toolEvents.length === 3 && toolEvents.map((e) => e.skipHint === true).join() === 'false,true,true' && toolEvents.every((e) => e.isError === true && /exited with code [1-9]/.test(e.output ?? '')), toolEvents.map((e) => `${e.output?.match(/code (\d+)/)?.[1]}:${e.skipHint === true ? '跳过提醒' : '参与'}`).join(' '));
    const toolRequest = requests.find((m) => m.some((x) => tag(x) === 'tool(真实失败)'));
    const lastTool = toolRequest?.findLastIndex((x) => tag(x) === 'tool(真实失败)') ?? -1;
    const afterTools = toolRequest?.slice(lastTool + 1).map(tag) ?? [];
    check('一批最多挂一段提醒：3 个失败之后只跟一条提醒，不拼多段', afterTools.length === 1 && afterTools[0] === '提醒(<memory-hint>)', afterTools.join(' → ') || '工具结果之后没有提醒');
    const fullest = requests.reduce((longest, m) => (m.length > longest.length ? m : longest), []);
    const inTranscript = fullest.filter((m) => tag(m) === '提醒(<memory-hint>)').length;
    check('压缩前的完整对话里一共只有 3 段提醒（第 1 轮原话 1 + 工具批次 1 + 第 2 轮纠错 1）', inTranscript === 3, `最长主请求里 ${inTranscript} 段`);
    const smallTalk = requests.findIndex((m) => m.some((x) => tag(x).startsWith('user:「换个小话题')));
    check('没有命中关键词的那一轮不追加提醒（第 3 轮）', smallTalk >= 0 && !hintAfterUser(smallTalk, 'last'), smallTalk >= 0 ? '' : '没找到第 3 轮的请求');
    const notice = requests.map((m) => section(systemText(m), 'memloom_notice'));
    check('分歧提醒是另起的一段、也在 system 里，且整场字节不变', notice.every(Boolean) && new Set(notice).size === 1);
    const starts = events.filter((e) => e.type === 'session_start');
    check('夹具收到 4 次 session_start：首场 resume=false，-c 续接的三场 resume=true', starts.length === 4 && starts[0].resume === false && starts.slice(1).every((e) => e.resume === true), starts.map((e) => `${e.sessionId.slice(0, 8)}… resume=${e.resume}`).join('；'));
    check('夹具收到的会话号只有一个（4 个进程同一会话）', new Set(starts.map((e) => e.sessionId)).size === 1);
    const kinds = events.map((e) => e.type ?? 'closed');
    check('每轮用户原话只到核心一次；关会话映射成 session_end + 关核心', events.filter((e) => e.type === 'user_message').length === 4 && events.filter((e) => e.type === 'session_end').length === 4 && events.filter((e) => e.closed).length === 4, kinds.join(' → '));
    check('真实工具失败映射成 isError=true 的 tool_result，assistant 最终回复映射成 assistant_message', events.some((e) => e.type === 'tool_result' && e.isError === true && /code 7/.test(e.output ?? '')) && events.some((e) => e.type === 'assistant_message'));
    const compacted = events.some((e) => e.type === 'compact');
    console.log(`  说明  ${compacted ? '最后一轮真实触发了压缩前事件，胶水映射成 compact' : '真实压缩前事件这一轮没有触发（阈值已抬高仍没触发，见 pi-turn-4.out）'}`);
    results.push({ name: '压缩前事件真实触发并映射（仅记录，不计入通过/没过）', ok: null, detail: compacted });
  }
  if (keep) console.log(`临时目录保留：${root}`);
  else rmSync(root, { recursive: true, force: true });
}

try {
  if (mode === 'real' || mode === 'both') await run('real');
  if (mode === 'fixture' || mode === 'both') await run('fixture');
} catch (error) {
  console.error(`冒烟没跑完：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 2;
}
const failed = results.filter((result) => result.ok === false).length;
console.log(`\n合计：${results.filter((r) => r.ok === true).length} 项通过，${failed} 项没过，${results.filter((r) => r.ok === null).length} 项仅记录`);
process.exitCode = failed === 0 ? 0 : 1;
