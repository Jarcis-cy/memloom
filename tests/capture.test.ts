import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CorrectionThrottle,
  REVIEW_DEFAULTS,
  ReviewTrigger,
  captureCorrection,
  detectCorrection,
  extractExperiences,
  isReviewDue,
  openStore,
  selectFlushWindow,
  type ConversationMessage,
  type ExtractionModel,
  type Store,
} from '../src/core/index.js';

const T0 = '2026-11-27T10:00:00.000Z';

async function withDb(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'memloom-capture-'));
  const store = openStore(join(dir, 'test.db'));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('中文纠错强信号：规格列出的说法和用户常用的同义说法都能命中', () => {
  const positives: Array<[string, string]> = [
    ['不对，我说的是先检查再删除，不是直接删。', '不对'],
    ['停下来，不要自作主张删文件。', '停下来'],
    ['说人话，别跟我讲一堆术语。', '说人话'],
    ['别乱改我的配置文件。', '别乱改'],
    ['我不是这个意思，我要的是先 dry-run。', '我不是这个意思'],
    ['谁让你直接 push 的？', '谁让你'],
    ['搞错了，应该是 B 不是 A。', '搞错了'],
    ['把刚才的改动回滚一下。', '回滚'],
    ['不许动那个目录。', '不许'],
  ];
  for (const [message, signal] of positives) {
    const hit = detectCorrection(message);
    assert.ok(hit, message);
    assert.equal(hit.lang, 'zh');
    assert.equal(hit.signal, signal);
    assert.ok(hit.excerpt.length > 0);
  }
});

test('中文非纠错上下文不算：疑问、假设、叙述过去、报错原文、引用和代码里的词都不触发', () => {
  const negatives = [
    '这个方案对不对？',
    '是不是这样理解？',
    '之前不对的地方已经改好了，现在都通过了。',
    '如果结果不对就重试一次。',
    '原来不对的假设现在被推翻了。',
    '报错了，截图在下面。',
    '出错了，但是我自己改好了。',
    '日志里写着 Error: something went wrong，你看看。',
    '你说的「不对」是什么意思？',
    '你在引用里写的“停下来”是哪来的？',
    '```python\nif x != y:\n    print("不对")\n```',
    '运行 `git status` 看看状态。',
    '今天天气不错。',
    'Please hold on.',
    '这里的 wrong number 是参数个数的问题。',
    '哪里不对？我觉得挺合理的。',
  ];
  for (const message of negatives) {
    assert.equal(detectCorrection(message), null, message);
  }
});

test('英文纠错强信号：命令停止、否定、撤销都命中；疑问、叙述故障、普通等待不触发', () => {
  const positives: Array<[string, string]> = [
    ["Stop, don't delete that file.", "don't delete"],
    ["That's not what I asked for.", "that's not what"],
    ['I didn\'t ask you to push it.', "i didn't ask"],
    ['You misunderstood, I meant the test file.', 'you misunderstood'],
    ['Revert that change now.', 'revert that'],
    ['Do not touch the lock file.', 'do not touch'],
  ];
  for (const [message, signal] of positives) {
    const hit = detectCorrection(message);
    assert.ok(hit, message);
    assert.equal(hit.lang, 'en');
    assert.ok(signal.length === 0 || hit.signal.includes(signal), `${message} → ${hit.signal}`);
  }
  const negatives = [
    "What's wrong with the build?",
    'Something went wrong when I ran the tests.',
    'The build failed with the wrong number of args.',
    'Please wait for the build to finish.',
    'Run the stopword filter first.',
    'The `stop` command in this script is documented below.',
  ];
  for (const message of negatives) assert.equal(detectCorrection(message), null, message);
});

test('限频：同一个会话最多每 3 轮记一次，不同会话互不影响，满 3 轮后再次允许', () => {
  const throttle = new CorrectionThrottle(3);
  assert.equal(throttle.tryAcquire('a', 1), true);
  assert.equal(throttle.tryAcquire('a', 2), false);
  assert.equal(throttle.tryAcquire('a', 3), false);
  assert.equal(throttle.tryAcquire('b', 3), true, '别的会话不受影响');
  assert.equal(throttle.tryAcquire('a', 4), true, '第 4 轮距离第 1 轮已满 3 轮');
  assert.equal(throttle.tryAcquire('a', 6), false);
});

test('复盘扳机：默认 10 轮或 15 次工具调用任一到阈值就该复盘；宿主自己的计数也能直接判', () => {
  assert.deepEqual(REVIEW_DEFAULTS, { turnThreshold: 10, toolThreshold: 15 });
  assert.equal(isReviewDue({ turns: 0, toolCalls: 0 }), false);
  assert.equal(isReviewDue({ turns: 9, toolCalls: 14 }), false);
  assert.equal(isReviewDue({ turns: 10, toolCalls: 0 }), true, '轮数到了');
  assert.equal(isReviewDue({ turns: 0, toolCalls: 15 }), true, '工具调用次数到了');
  assert.equal(isReviewDue({ turns: 3, toolCalls: 4 }, { turnThreshold: 3, toolThreshold: 4 }), true, '阈值可以改');

  const trigger = new ReviewTrigger();
  assert.equal(trigger.due, false);
  trigger.recordTurn(9);
  trigger.recordToolCall(14);
  assert.equal(trigger.due, false);
  trigger.recordToolCall();
  assert.equal(trigger.due, true);
  trigger.reset();
  assert.equal(trigger.due, false);
});

test('抢救窗口：只取最近 20 条未覆盖消息，锚点找不到就从头取最近 20 条，不足 20 条就全要', () => {
  const messages = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: `第 ${i} 条` }));
  const first = selectFlushWindow(messages, null);
  assert.equal(first.window.length, 20);
  assert.equal(first.window[0]!.id, 'm5');
  assert.equal(first.lastMessageId, 'm24');

  const next = selectFlushWindow(messages, 'm24');
  assert.deepEqual(next.window, []);
  assert.equal(next.lastMessageId, 'm24');

  const partial = selectFlushWindow(messages, 'm10');
  assert.equal(partial.window.length, 14);
  assert.equal(partial.window[0]!.id, 'm11');
  assert.equal(partial.lastMessageId, 'm24');

  const lostAnchor = selectFlushWindow(messages, '已不存在的消息');
  assert.equal(lostAnchor.window.length, 20, '宿主裁掉历史找不到锚点：宁多勿漏，写入时按总结去重');
  const small = selectFlushWindow(messages.slice(0, 3), null);
  assert.deepEqual(small.window.map((m) => m.id), ['m0', 'm1', 'm2']);
});

test('模型抽取：只收原话里找得到证据的候选，坏候选只丢它自己；采集不凝结，flush 来源标记清楚', async () => {
  await withDb(async (store) => {
    const messages: ConversationMessage[] = [
      { id: 'u1', role: 'user', text: '以后汇报先说结论，再说细节，别绕。' },
      { id: 'a1', role: 'assistant', text: '好的，明白了。' },
      { id: 'u2', role: 'user', text: '删目录之前记得先看一眼是不是软链接。' },
      { id: 't1', role: 'tool', text: 'rm -rf /tmp/demo/  removed 3 files' },
    ];
    const model: ExtractionModel = {
      id: 'offline-extractor',
      async extract(input) {
        assert.ok(input.instructions.includes('逐字摘录'), '提示词里带着原话摘录的要求');
        assert.deepEqual(input.messages, messages);
        return [
          { kind: 'preference', summary: '用户要求汇报先说结论，再说细节，不要绕圈子。', evidence: '以后汇报先说结论，再说细节' },
          { kind: 'pitfall', summary: '删目录之前要先看一眼它是不是软链接。', evidence: '先看一眼是不是软链接' },
          { kind: 'fact', summary: '凭空编造的一条经历。', evidence: '这句话用户从来没有说过' },
          { kind: 'decision', summary: 'Only english summary here.', evidence: '别绕' },
          { kind: 'preference', summary: '多了字段的一条。', evidence: '别绕', extra: 1 },
          { kind: 'preference', summary: '用户要求汇报先说结论，再说细节，不要绕圈子。', evidence: '以后汇报先说结论' },
        ];
      },
    };
    const result = await extractExperiences({ store, scope: 'personal', source: 'flush', sessionId: 's1', messages, model, now: () => T0 });
    assert.equal(result.inserted.length, 2);
    assert.deepEqual(result.rejected.map((r) => r.index), [2, 3, 4, 5]);
    assert.match(result.rejected[0]!.reason, /找不到原话/);
    assert.match(result.rejected[1]!.reason, /自然中文/);
    assert.match(result.rejected[2]!.reason, /多了不允许的字段/);
    assert.match(result.rejected[3]!.reason, /已经记过了/);
    for (const row of result.inserted) {
      assert.equal(row.source, 'flush');
      assert.equal(row.sourceSession, 's1');
      assert.equal(row.processedAt, null, '采集不凝结');
      assert.equal(row.createdAt, T0);
    }
    assert.equal(store.listPrinciples('personal', { status: 'all' }).length, 0, '抢救采集不会产生原则');

    // 复盘来源同理，已存在的总结不再重复写
    const again = await extractExperiences({
      store,
      scope: 'personal',
      source: 'review',
      sessionId: 's1',
      messages,
      model: { id: 'again', async extract() { return [{ kind: 'preference', summary: '用户要求汇报先说结论，再说细节，不要绕圈子。', evidence: '以后汇报先说结论' }]; } },
      now: () => T0,
    });
    assert.equal(again.inserted.length, 0);
    assert.equal(again.rejected[0]!.reason, '同样的经历已经记过了');

    // 模型返回不是数组：采集整体报错，不会写进半截
    await assert.rejects(
      extractExperiences({ store, scope: 'personal', source: 'review', sessionId: 's1', messages, model: { id: 'bad', async extract() { return { nope: true }; } } }),
      /返回的不是数组/,
    );
    assert.equal(store.listExperiences('personal').length, 2);

    // 超过 20 条的候选：前 20 条照常处理，其余标记拒收
    const many = Array.from({ length: 23 }, (_, i) => ({ kind: 'preference', summary: `第 ${i} 条不重复的偏好总结。`, evidence: '别绕' }));
    const bulk = await extractExperiences({ store, scope: 'role:x', source: 'flush', sessionId: null, messages, model: { id: 'bulk', async extract() { return many; } } });
    assert.equal(bulk.inserted.length, 20);
    assert.equal(bulk.rejected.length, 3);
    assert.match(bulk.rejected[0]!.reason, /超出单批 20 条上限/);
  });
});

test('纠错即时路径：命中就记一条 correction 样本并给出「马上凝结」入口；无信号不记；限频期内也不记', async () => {
  await withDb(async (store) => {
    assert.deepEqual(captureCorrection(store, { scope: 'personal', sessionId: 's1', turn: 1, message: '这个思路挺好的。', now: T0 }), { skipped: 'no_signal' });
    assert.equal(store.listExperiences('personal').length, 0);

    const throttle = new CorrectionThrottle(3);
    const first = captureCorrection(store, { scope: 'personal', sessionId: 's1', turn: 1, message: '不对，先别删，让我确认一下路径。', throttle, now: T0 });
    assert.ok('experience' in first);
    assert.equal(first.experience.kind, 'correction');
    assert.equal(first.experience.source, 'correction');
    assert.equal(first.experience.summary, '用户纠正了助手：「不对，先别删，让我确认一下路径。」');
    assert.equal(first.experience.evidence, '不对，先别删，让我确认一下路径。');
    assert.equal(first.experience.sourceSession, 's1');
    assert.deepEqual(first.condense, { reason: 'correction', experienceIds: [first.experience.id] });

    assert.deepEqual(captureCorrection(store, { scope: 'personal', sessionId: 's1', turn: 2, message: '停下来，别乱改。', throttle, now: T0 }), { skipped: 'throttled' });
    assert.equal(store.listExperiences('personal').length, 1, '限频期内不再记录');
    const later = captureCorrection(store, { scope: 'personal', sessionId: 's1', turn: 4, message: '搞错了，应该是另一个文件。', throttle, now: T0 });
    assert.ok('experience' in later);
    assert.equal(store.listExperiences('personal').length, 2);
    assert.equal(store.countPendingExperiences('personal'), 2);
  });
});
