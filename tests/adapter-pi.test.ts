import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HINT_TYPE, MemloomPiGlue, NOTICE_SECTION, SECTION, type PiSessionFacts } from '../adapters/pi/memloom.js';
import type { HostCore } from '../src/host/index.js';
import type { HostEvent, HostResponse } from '../src/host/types.js';

/** 按脚本回话的核心替身：只记事件、按 reply 补字段，不碰数据库（映射回归不依赖核心实现） */
class FakeCore implements Pick<HostCore, 'handle' | 'close'> {
  readonly events: HostEvent[] = [];
  closed = 0;
  failNext = false;
  reply: (event: HostEvent) => Partial<HostResponse>;

  constructor(reply: (event: HostEvent) => Partial<HostResponse> = () => ({})) {
    this.reply = reply;
  }

  async handle(event: HostEvent): Promise<HostResponse> {
    this.events.push(event);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('模拟核心出错');
    }
    return {
      event: event.type,
      sessionId: event.sessionId,
      scope: 'personal',
      hint: '',
      hintState: 'off',
      dilemmaNotice: '',
      correction: { captured: false, experienceId: null, reason: null },
      background: [],
      elapsedMs: { total: 0, hint: null },
      ...this.reply(event),
    };
  }

  close(): void {
    this.closed += 1;
  }
}

const STANDING = '<memloom-standing>\n<iron-rules>\n- 没有明说就不擅自动手。\n</iron-rules>\n<tools>x</tools>\n</memloom-standing>';
const NOTICE = '顺带一提：记忆系统里目前有 3 处拿不准的规则分歧。';
const HINT = '<memory-hint>\n- [P12] 递归删除目录前先检查是不是软链接。\n</memory-hint>';

function fresh(hasHistory = false, sessionId = 'pi-session-1'): PiSessionFacts {
  return { sessionId, cwd: '/tmp/proj', hasHistory };
}

/** 等胶水里「不等核心」的那几条（message_end）送达替身 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function types(core: FakeCore): HostEvent['type'][] {
  return core.events.map((event) => event.type);
}

test('Pi 胶水：静态区每次运行都是同一份字节，分歧提醒另起一段且不进静态区', async () => {
  const core = new FakeCore((event) => (event.type === 'session_start' ? { staticBlock: STANDING, dilemmaNotice: NOTICE } : {}));
  const glue = new MemloomPiGlue(async () => core);
  await glue.sessionStart(fresh());
  const seen = new Set<string>();
  const seenNotice = new Set<string>();
  for (let run = 0; run < 4; run += 1) {
    core.reply = (event) => (event.type === 'user_message' && run % 2 === 0 ? { hint: HINT, hintState: 'hinted' } : { hintState: 'silent' });
    const sections: Record<string, string> = { preamble: 'pi 自己的' };
    glue.applySections(sections);
    seen.add(sections[SECTION] ?? '');
    seenNotice.add(sections[NOTICE_SECTION] ?? '');
    const reply = await glue.beforeAgentStart(`第 ${run + 1} 轮的问题`);
    if (run % 2 === 0) {
      assert.deepEqual(reply, { message: { type: 'custom_message', customType: HINT_TYPE, content: HINT, display: false, details: { memloom: { event: 'user_message', hintState: 'hinted' } } } });
    } else {
      assert.equal(reply, undefined, '没有高分命中就不追加任何东西');
    }
    assert.equal(sections.preamble, 'pi 自己的', '别的 section 原样保留');
  }
  assert.deepEqual([...seen], [STANDING], '四轮里静态区一个字节都没变');
  assert.deepEqual([...seenNotice], [NOTICE], '分歧提醒是独立的一段，整场也不变');
  assert.equal(STANDING.includes('<memory-hint>'), false);
  assert.equal(NOTICE.includes(STANDING), false);
  assert.equal(core.events.filter((event) => event.type === 'session_start').length, 1, '静态区只向核心要一次');
});

test('Pi 胶水：用户当轮动态是独立追加，原话原样交给核心；无高分空串不追加', async () => {
  const core = new FakeCore();
  const glue = new MemloomPiGlue(async () => core);
  await glue.sessionStart(fresh());
  const prompt = '删目录之前要做什么？';
  assert.equal(await glue.beforeAgentStart(prompt), undefined);
  core.reply = (event) => (event.type === 'user_message' ? { hint: HINT, hintState: 'hinted' } : {});
  const reply = await glue.beforeAgentStart('换个话题：说说软链接');
  assert.equal(reply?.message.type, 'custom_message');
  assert.equal(reply?.message.display, false);
  assert.deepEqual(
    core.events.filter((event) => event.type === 'user_message').map((event) => (event as { text: string }).text),
    [prompt, '换个话题：说说软链接'],
    '每轮原话各交一次，文本不改写、不截断、不包装');
});

test('Pi 胶水：工具结果每条都报，只有失败的出提醒；提醒是独立消息，不碰工具结果本身', async () => {
  const hints = (event: HostEvent): Partial<HostResponse> => (event.type === 'tool_result' && (event as { isError?: boolean }).isError === true && (event as { skipHint?: boolean }).skipHint !== true ? { hint: HINT, hintState: 'hinted' } : {});
  const core = new FakeCore(hints);
  const glue = new MemloomPiGlue(async () => core);
  await glue.sessionStart(fresh());
  const ok = { toolName: 'bash', isError: false, exitCode: null, output: 'total 0' };
  const bad = { toolName: 'bash', isError: true, exitCode: 7, output: '(no output)\n\nCommand exited with code 7' };
  const failed = { toolName: 'read', isError: true, output: 'ENOENT: no such file' };

  assert.equal(await glue.turnEnd([]), undefined, '这一轮没有工具调用就什么都不做');
  assert.equal(await glue.turnEnd([ok]), undefined, '成功的工具只计数，不提醒');
  assert.equal(core.events.filter((event) => event.type === 'tool_result').length, 1, '成功的也报给核心计数');

  const reply = await glue.turnEnd([ok, bad, failed]);
  assert.deepEqual(reply?.entries.map((entry) => [entry.type, entry.customType, entry.content, entry.display]), [
    ['custom_message', HINT_TYPE, HINT, false],
  ], '同一个批次只有首个失败（bad）参与提醒，第二批的 failed 被跳过');
  assert.deepEqual(
    core.events.filter((event) => event.type === 'tool_result').map((event) => {
      const tool = event as { toolName: string; isError?: boolean; exitCode?: number | null; output?: string | null; skipHint?: boolean };
      return [tool.toolName, tool.isError, tool.exitCode, tool.skipHint === true, tool.output];
    }),
    [
      ['bash', false, null, false, 'total 0'],
      ['bash', false, null, false, 'total 0'],
      ['bash', true, 7, false, '(no output)\n\nCommand exited with code 7'],
      ['read', true, null, true, 'ENOENT: no such file'],
    ],
    '工具名、成败、退出码、输出原样翻译；没给退出码就是 null，由核心自己判成败',
  );
  assert.equal(bad.output.includes('<memory-hint>'), false, '提醒没有写进工具输出（不假冒工具结果）');
});

test('Pi 胶水：同一批次多个失败只让首个实际失败参与提醒，其余照报但带 skipHint；状态不丢，下一批重新算', async () => {
  const hints = (event: HostEvent): Partial<HostResponse> =>
    event.type === 'session_start'
      ? { staticBlock: STANDING }
      : event.type === 'tool_result' && (event as { isError?: boolean }).isError === true && (event as { skipHint?: boolean }).skipHint !== true
        ? { hint: HINT, hintState: 'hinted' }
        : {};
  const core = new FakeCore(hints);
  const glue = new MemloomPiGlue(async () => core);
  await glue.sessionStart(fresh());
  const ok = { toolName: 'bash', isError: false, exitCode: 0, output: 'total 0' };
  const bad = (code: number) => ({ toolName: 'bash', isError: true, exitCode: code, output: `Command exited with code ${code}` });
  const nonzeroOnly = { toolName: 'bash', isError: false, exitCode: 3, output: '' }; // 没标 isError，但退出码是非零数字

  const first = await glue.turnEnd([ok, bad(7), nonzeroOnly, bad(1)]);
  assert.equal(first?.entries.length, 1, '一批最多挂一段提醒，不拼多段');
  assert.equal(first?.entries[0]?.content, HINT);
  const batch = core.events.filter((event) => event.type === 'tool_result').map((event) => {
    const tool = event as { isError?: boolean; exitCode?: number | null; output?: string | null; skipHint?: boolean };
    return [tool.isError, tool.exitCode, tool.skipHint === true, tool.output];
  });
  assert.deepEqual(
    batch,
    [
      [false, 0, false, 'total 0'],
      [true, 7, false, 'Command exited with code 7'],
      [false, 3, true, ''],
      [true, 1, true, 'Command exited with code 1'],
    ],
    '真假错误、退出码、文本一条不少；首个实际失败不带 skipHint，其余失败带 skipHint:true，成功的不带',
  );

  // 状态没丢：会话事实、静态区、当轮提醒照常
  const sections: Record<string, string> = {};
  glue.applySections(sections);
  assert.deepEqual(sections, { [SECTION]: STANDING });
  core.reply = (event) => (event.type === 'user_message' ? { hint: HINT, hintState: 'hinted' } : {});
  assert.equal((await glue.beforeAgentStart('继续'))?.message.content, HINT);

  // 下一批重新算：单个失败照常提醒；核心对它不提醒时什么都不挂（不拼、不凑）
  core.reply = hints;
  assert.equal((await glue.turnEnd([bad(2)]))?.entries.length, 1, '下一批的首个失败照常提醒');
  assert.equal('skipHint' in (core.events.at(-1) ?? {}), false);
  core.reply = () => ({});
  assert.equal(await glue.turnEnd([bad(5), bad(6)]), undefined);
  assert.equal(core.events.filter((event) => event.type === 'tool_result').length, 7, '被跳过提醒的失败照样报给核心计数');
});

test('Pi 胶水：会话号只认宿主当前会话；续接看历史记录不看 reason；关闭 / 换会话先 session_end 再关核心', async () => {
  const core = new FakeCore((event) => (event.type === 'session_start' ? { staticBlock: STANDING } : {}));
  let loads = 0;
  const glue = new MemloomPiGlue(async () => {
    loads += 1;
    return core;
  });
  assert.equal(loads, 0, '扩展加载时不开库、不起服务；第一个事件到了才创建核心');

  await glue.sessionStart(fresh(false, 'pi-new'));
  assert.deepEqual(core.events[0], { type: 'session_start', sessionId: 'pi-new', resume: false, cwd: '/tmp/proj' });

  await glue.shutdown();
  assert.deepEqual(types(core), ['session_start', 'session_end'], '关会话只映射成 session_end（抢救 + 删会话临时状态）');
  assert.equal(core.closed, 1);
  const sections: Record<string, string> = { [SECTION]: STANDING, [NOTICE_SECTION]: NOTICE };
  glue.applySections(sections);
  assert.deepEqual(sections, {}, '会话关了就不留旧字节');

  // `pi -p -c`：宿主给的 reason 还是 startup，但会话里已经有历史记录
  await glue.sessionStart(fresh(true, 'pi-new'));
  assert.deepEqual(core.events.at(-1), { type: 'session_start', sessionId: 'pi-new', resume: true, cwd: '/tmp/proj' });
  assert.equal(loads, 2, '关会话时核心已经关了，再开会场重建一次；同一场会话里不会重复建');

  // 交互界面里 /resume：先 session_shutdown，再 session_start 指到另一份会话
  await glue.sessionStart(fresh(true, 'pi-other'));
  assert.deepEqual(types(core).slice(-2), ['session_end', 'session_start'], '换会话 = 旧的收尾 + 新的开场');
  assert.equal((core.events.at(-1) as { sessionId: string }).sessionId, 'pi-other');

  await glue.shutdown();
  await glue.shutdown();
  assert.equal(core.closed, 2, 'session_shutdown 可重复执行，核心只关一次');
  assert.equal(types(core).filter((type) => type === 'session_end').length, 3);
});

test('Pi 胶水：压缩前只映射，不取消、不改压缩', async () => {
  const core = new FakeCore();
  const glue = new MemloomPiGlue(async () => core);
  await glue.sessionStart(fresh());
  assert.equal(await glue.compact(), undefined);
  assert.deepEqual(core.events.at(-1), { type: 'compact', sessionId: 'pi-session-1' });
  await glue.shutdown();
  await glue.compact();
  assert.equal(types(core).filter((type) => type === 'compact').length, 1, '没有会话就不发');
});

test('Pi 胶水：运行开头的原话不重复计数；中途插进来的 steer 原话照样即时交给核心；assistant 最终回复留给复盘', async () => {
  const core = new FakeCore();
  const glue = new MemloomPiGlue(async () => core);
  await glue.sessionStart(fresh());
  await glue.beforeAgentStart('帮我删掉 build 目录');
  glue.messageEnded('user', '帮我删掉 build 目录');
  await flush();
  assert.equal(core.events.filter((event) => event.type === 'user_message').length, 1, '同一条原话只交一次');

  glue.messageEnded('user', '不对，删目录之前先 ls -la 看一眼是不是软链接。');
  glue.messageEnded('assistant', '好的，我先看一眼。');
  glue.messageEnded('toolResult', 'total 0');
  glue.messageEnded(null, '');
  await flush();
  assert.deepEqual(
    core.events.filter((event) => event.type === 'user_message' || event.type === 'assistant_message').map((event) => [event.type, (event as { text: string }).text]),
    [
      ['user_message', '帮我删掉 build 目录'],
      ['user_message', '不对，删目录之前先 ls -la 看一眼是不是软链接。'],
      ['assistant_message', '好的，我先看一眼。'],
    ],
  );
  // 用户紧接着把同一句话再发一遍（另一次运行）：仍然是新一轮，不算重复
  await glue.beforeAgentStart('不对，删目录之前先 ls -la 看一眼是不是软链接。');
  assert.equal(core.events.filter((event) => event.type === 'user_message').length, 3);
});

test('Pi 胶水：核心加载失败 / 出错 / 关闭都安静放行，不向宿主抛错，下次事件再试', async () => {
  let loads = 0;
  let core: FakeCore | undefined;
  const glue = new MemloomPiGlue(async () => {
    loads += 1;
    if (loads === 1) throw new Error('dist 还没编译');
    core ??= new FakeCore((event) => (event.type === 'session_start' ? { staticBlock: STANDING } : {}));
    return core;
  });

  await glue.sessionStart(fresh());
  assert.equal(await glue.beforeAgentStart('第一轮'), undefined);
  assert.equal(await glue.turnEnd([{ toolName: 'bash', isError: true, output: 'x' }]), undefined);
  const none: Record<string, string> = { [SECTION]: '旧字节' };
  glue.applySections(none);
  assert.deepEqual(none, {}, '核心没起来就没有会话：后面的事件直接放行，也不留旧字节');


  await glue.sessionStart(fresh());
  assert.equal(loads, 2, '下次事件重新加载');
  core!.failNext = true;
  assert.equal(await glue.beforeAgentStart('第二轮'), undefined, '核心处理出错也不追加半截提醒');
  assert.equal(core!.closed, 0, '处理出错不等于关闭：核心还留着给下一场用');
  const sections: Record<string, string> = {};
  glue.applySections(sections);
  assert.deepEqual(sections, { [SECTION]: STANDING }, '静态区仍是 session_start 拿到的那份，不因为某一轮出错而变');
  await glue.shutdown();
  assert.equal(core!.closed, 1);
});
