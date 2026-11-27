import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/core/index.js';
import { LocalRetriever, indexVectors } from '../src/retriever/index.js';
import { HostCore } from '../src/host/index.js';

/**
 * 人工主动跑的真实模型证据（默认跳过；MEMLOOM_TEST_MODEL_DIR=~/.memloom/models npm run test:real-model 之类）：
 * 临时库 + 临时状态目录（socket 在临时目录），温态下中文正例要在前台预算内出提醒、反例静默；冷启动另计。
 * 数字只说明这台机器这一次，不是保证。测完安全停掉共享检索服务。
 */
const MODEL_DIR = process.env.MEMLOOM_TEST_MODEL_DIR;
const BUDGET_MS = Number(process.env.MEMLOOM_TEST_HINT_BUDGET_MS ?? 2000);

test('真实模型温态：中文正例在预算内提醒、反例静默；冷启动与首次精排另计', { skip: !MODEL_DIR && '没给 MEMLOOM_TEST_MODEL_DIR' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'memloom-host-real-'));
  const dbPath = join(root, 'personal.db');
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  const store = openStore(dbPath);
  store.addIronRule({ scope: 'personal', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。', now: '2026-01-01T00:00:00.000Z' });
  store.insertPrinciple({ scope: 'personal', triggerWhen: '当你向用户汇报进展的时候', rule: '先说结论，再用大白话展开，不要先铺背景。', isCore: true, now: '2026-01-01T00:00:00.000Z' });
  store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf，防止顺着链接误删目标目录', isCore: false, now: '2026-01-01T00:00:00.000Z' });
  store.insertPrinciple({ scope: 'personal', triggerWhen: '当你准备提交代码的时候', rule: '先跑一遍定向测试再 commit，不要把没验证的东西推上去', isCore: false, now: '2026-01-01T00:00:00.000Z' });
  store.addExperience({ scope: 'personal', kind: 'pitfall', summary: '构建报 ENOENT 时先看路径里的目录是不是被软链到别处，再检查权限。', evidence: 'ENOENT: no such file or directory', source: 'manual', createdAt: '2026-01-02T00:00:00.000Z' });
  store.close();
  const retriever = new LocalRetriever({ stateDir, modelDir: MODEL_DIR as string, idleMs: 60_000, requestTimeoutMs: BUDGET_MS * 4, startupTimeoutMs: 120_000 });
  const timings: Record<string, number> = {};
  try {
    const coldStart = Date.now();
    await retriever.warmup();
    timings.coldStartMs = Date.now() - coldStart;
    const indexStart = Date.now();
    const db = openStore(dbPath);
    const indexed = await indexVectors({ store: db, retriever, scope: 'personal', limit: 50 });
    db.close();
    timings.indexMs = Date.now() - indexStart;
    assert.equal(indexed.failed, 0);

    const core = new HostCore({ home, dbPath, scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir, llm: null, warmupOnStart: false, hint: { budgetMs: BUDGET_MS } }, { retriever, jobMode: 'inline' });
    try {
      const started = Date.now();
      await core.handle({ type: 'session_start', sessionId: 'real' });
      timings.sessionStartMs = Date.now() - started;
      const rounds: Array<{ label: string; text: string }> = [
        { label: '首次精排（含精排模型首跑）', text: '递归删文件夹的时候把快捷方式指到的那份也删了，怎么办' },
        { label: '温态正例二', text: '用 rm -rf 清掉一个目录结果把别处的东西也删了' },
        { label: '温态正例三（报错）', text: 'Bash exit code 1: enoent ENOENT: no such file or directory, open config.yaml' },
        { label: '温态反例一', text: '帮我看一下这段 TypeScript 的泛型推断为什么会报错' },
        { label: '温态反例二', text: '下周的排期怎么安排比较合理' },
      ];
      const results: Array<Record<string, unknown>> = [];
      for (const round of rounds) {
        const r = await core.handle({ type: 'user_message', sessionId: 'real', text: round.text });
        results.push({ label: round.label, hintState: r.hintState, hintMs: r.elapsedMs.hint, totalMs: r.elapsedMs.total, hint: r.hint.split('\n').slice(2, -1).join(' | '), reason: r.hintReason ?? null });
      }
      console.log(JSON.stringify({ model: retriever.modelId, budgetMs: BUDGET_MS, timings, results }, null, 1));
      const warmPositives = results.slice(1, 3);
      assert.ok(warmPositives.some((r) => r.hintState === 'hinted'), '至少一个温态中文正例出提醒');
      for (const r of warmPositives) if (r.hintState === 'hinted') assert.ok((r.hintMs as number) <= BUDGET_MS, `温态正例 ${String(r.hintMs)} 毫秒超过预算 ${BUDGET_MS}`);
      for (const r of results.slice(3)) assert.equal(r.hintState !== 'hinted', true, '反例不出提醒');
    } finally {
      await core.settle();
      core.close();
    }
  } finally {
    await retriever.stop('真实模型证据收尾');
    rmSync(root, { recursive: true, force: true });
  }
});
