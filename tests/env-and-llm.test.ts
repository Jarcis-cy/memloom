import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMemloomEnv, parseEnvText } from '../src/app/env.js';
import { buildChatBody, describeLlm, extractJson, llmConfigFromEnv, OpenAiCompatibleCondenseModel } from '../src/app/llm.js';
import { jobSpec } from '../src/host/background.js';
import { resolveHostConfig } from '../src/host/crew.js';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'memloom-env-'));
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

test('env 文件解析：支持 export / 引号 / 行尾注释，只接受 MEMLOOM_* 与 HF_ENDPOINT，忽略危险变量', () => {
  const parsed = parseEnvText(`
# 注释行
export MEMLOOM_LLM_BASE_URL="https://example.invalid/v1"
MEMLOOM_LLM_MODEL='demo-flash'
MEMLOOM_LLM_REASONING_EFFORT=max # 思考强度
HF_ENDPOINT=https://hf-mirror.com
PATH=/tmp/evil
NODE_OPTIONS=--require=/tmp/evil.js
`);
  assert.deepEqual(parsed, {
    MEMLOOM_LLM_BASE_URL: 'https://example.invalid/v1',
    MEMLOOM_LLM_MODEL: 'demo-flash',
    MEMLOOM_LLM_REASONING_EFFORT: 'max',
    HF_ENDPOINT: 'https://hf-mirror.com',
  });
  assert.equal('PATH' in parsed, false);
  assert.equal('NODE_OPTIONS' in parsed, false);
  assert.throws(() => parseEnvText('INVALID_LINE_WITHOUT_EQ'), /第 1 行格式不对/);
});

test('loadMemloomEnv：默认读 $XDG_CONFIG_HOME/memloom/env；进程环境变量永远优先；拒绝符号链接；支持禁用', () => {
  const root = temp();
  try {
    const configDir = join(root, 'cfg', 'memloom');
    mkdirSync(configDir, { recursive: true });
    const envPath = join(configDir, 'env');
    writeFileSync(
      envPath,
      [
        'MEMLOOM_LLM_BASE_URL=https://example.invalid/v1',
        'MEMLOOM_LLM_MODEL=file-model',
        'MEMLOOM_LLM_REASONING_EFFORT=max',
        'MEMLOOM_LLM_THINKING_FORMAT=deepseek',
      ].join('\n'),
    );

    const loaded = loadMemloomEnv({ XDG_CONFIG_HOME: join(root, 'cfg') });
    assert.equal(loaded.file.loaded, true);
    assert.equal(loaded.file.path, envPath);
    assert.equal(loaded.file.keys, 4);
    assert.equal(loaded.env.MEMLOOM_LLM_MODEL, 'file-model');
    assert.equal(loaded.env.MEMLOOM_LLM_REASONING_EFFORT, 'max');

    // 显式环境变量优先（含传空串显式覆盖）
    const overridden = loadMemloomEnv({
      XDG_CONFIG_HOME: join(root, 'cfg'),
      MEMLOOM_LLM_MODEL: 'cli-model',
      MEMLOOM_LLM_REASONING_EFFORT: '',
    });
    assert.equal(overridden.env.MEMLOOM_LLM_MODEL, 'cli-model');
    assert.equal(overridden.env.MEMLOOM_LLM_REASONING_EFFORT, '');

    // MEMLOOM_NO_ENV_FILE=1 完全跳过
    const disabled = loadMemloomEnv({ XDG_CONFIG_HOME: join(root, 'cfg'), MEMLOOM_NO_ENV_FILE: '1' });
    assert.equal(disabled.file.disabled, true);
    assert.equal(disabled.env.MEMLOOM_LLM_MODEL, undefined);

    // 默认文件不存在时安静跳过
    const missingDefault = loadMemloomEnv({ XDG_CONFIG_HOME: join(root, 'no-such-dir') });
    assert.equal(missingDefault.file.loaded, false);

    // 显式 MEMLOOM_ENV_FILE 不存在时明确报错
    assert.throws(() => loadMemloomEnv({ MEMLOOM_ENV_FILE: join(root, 'missing.env') }), /指定的环境配置文件不存在/);

    // 符号链接拒绝
    const linkPath = join(root, 'link.env');
    symlinkSync(envPath, linkPath);
    assert.throws(() => loadMemloomEnv({ MEMLOOM_ENV_FILE: linkPath }), /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LLM 思考参数：openai 与 deepseek 协议请求体、<think> 剥离、校验、describeLlm 与脱离任务说明', () => {
  const ds = llmConfigFromEnv({
    MEMLOOM_LLM_BASE_URL: 'https://example.invalid/v1',
    MEMLOOM_LLM_MODEL: 'deepseek-flash',
    MEMLOOM_LLM_API_KEY: 'secret-token-xyz',
    MEMLOOM_LLM_REASONING_EFFORT: 'max',
    MEMLOOM_LLM_THINKING_FORMAT: 'deepseek',
    MEMLOOM_LLM_TIMEOUT_MS: '180000',
  });
  assert.ok(ds);
  assert.equal(ds.reasoningEffort, 'max');
  assert.equal(ds.thinkingFormat, 'deepseek');
  assert.equal(ds.timeoutMs, 180_000);
  assert.equal(describeLlm(ds), 'example.invalid（模型 deepseek-flash，思考 max（deepseek），带凭据）');
  assert.ok(!describeLlm(ds).includes('secret-token-xyz'));

  const dsBody = buildChatBody(ds, 'sys', { k: 1 });
  assert.deepEqual(dsBody.thinking, { type: 'enabled' });
  assert.equal(dsBody.reasoning_effort, 'max');

  const dsOff = buildChatBody({ ...ds, reasoningEffort: 'off' }, 'sys', { k: 1 });
  assert.deepEqual(dsOff.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in dsOff, false);

  const openai = llmConfigFromEnv({
    MEMLOOM_LLM_BASE_URL: 'https://example.invalid/v1',
    MEMLOOM_LLM_MODEL: 'gpt-demo',
    MEMLOOM_LLM_REASONING_EFFORT: 'high',
  });
  assert.ok(openai);
  const openaiBody = buildChatBody(openai, 'sys', { k: 1 });
  assert.equal(openaiBody.reasoning_effort, 'high');
  assert.equal('thinking' in openaiBody, false);
  assert.equal(describeLlm(openai), 'example.invalid（模型 gpt-demo，思考 high，不带凭据）');

  // 无思考参数时保持原有文案与请求体
  const plain = llmConfigFromEnv({ MEMLOOM_LLM_BASE_URL: 'https://example.invalid/v1', MEMLOOM_LLM_MODEL: 'plain-model' });
  assert.ok(plain);
  assert.equal(describeLlm(plain), 'example.invalid（模型 plain-model，不带凭据）');
  const plainBody = buildChatBody(plain, 'sys', { k: 1 });
  assert.equal('thinking' in plainBody, false);
  assert.equal('reasoning_effort' in plainBody, false);

  // 带 <think> 思考段（内部 even 含方括号）时准确提取正文 JSON
  assert.deepEqual(extractJson('<think>先想一下 [步骤 1] 和 {候选}</think>\n[{"action":"skip"}]'), [{ action: 'skip' }]);

  // 脱离任务说明保留思考参数，但不带凭据
  const spec = jobSpec(
    { kind: 'flush', sessionId: 's1', messages: [] },
    { home: '/tmp/h', dbPath: '/tmp/h/p.db', scope: 'personal', projectDir: null, projectId: null, roleName: null, stateDir: '/tmp/h', llm: ds, crewCliPath: null },
  );
  assert.equal(spec.config.llm?.reasoningEffort, 'max');
  assert.equal(spec.config.llm?.thinkingFormat, 'deepseek');
  assert.equal(spec.config.llm?.timeoutMs, 180_000);
  assert.equal('apiKey' in (spec.config.llm ?? {}), false);

  // 非法参数报错
  assert.throws(
    () => llmConfigFromEnv({ MEMLOOM_LLM_BASE_URL: 'https://example.invalid/v1', MEMLOOM_LLM_MODEL: 'm', MEMLOOM_LLM_THINKING_FORMAT: 'unknown' }),
    /只支持 openai 或 deepseek/,
  );
  assert.throws(
    () => llmConfigFromEnv({ MEMLOOM_LLM_BASE_URL: 'https://example.invalid/v1', MEMLOOM_LLM_MODEL: 'm', MEMLOOM_LLM_TIMEOUT_MS: '50' }),
    /1000 到 600000/,
  );
});

test('端到端 CLI 与 resolveHostConfig：自动读 $XDG_CONFIG_HOME/memloom/env 并把 deepseek max 思考参数送到回环端点', async () => {
  const root = temp();
  let receivedBody: Record<string, unknown> | null = null;
  let receivedAuth: string | undefined;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      receivedBody = JSON.parse(raw) as Record<string, unknown>;
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                reasoning_content: '内部推理过程',
                content: '[{"action":"add","trigger_when":"当你准备删除一个目录的时候","rule":"先 ls -la 看一眼是不是软链接，确认后再删，不要带尾斜杠","rationale":"用户纠正过","is_core":false,"source_experience_ids":[1]}]',
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const xdg = join(root, 'xdg');
    const cfgDir = join(xdg, 'memloom');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'env'),
      [
        `MEMLOOM_LLM_BASE_URL=http://127.0.0.1:${port}/v1`,
        'MEMLOOM_LLM_MODEL=deepseek-flash',
        'MEMLOOM_LLM_API_KEY=loopback-secret-key',
        'MEMLOOM_LLM_REASONING_EFFORT=max',
        'MEMLOOM_LLM_THINKING_FORMAT=deepseek',
      ].join('\n'),
    );

    const homeDir = join(root, 'home');
    const db = join(homeDir, 'personal.db');
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: xdg,
      MEMLOOM_HOME: homeDir,
      MEMLOOM_AUTO_DOWNLOAD: '0',
    };

    // resolveHostConfig 也自动吃进同一个配置文件
    const hostCfg = resolveHostConfig({}, childEnv);
    assert.equal(hostCfg.llm?.model, 'deepseek-flash');
    assert.equal(hostCfg.llm?.reasoningEffort, 'max');
    assert.equal(hostCfg.llm?.thinkingFormat, 'deepseek');

    // doctor 显示配置文件已加载且不泄露密钥
    const doc = await runCli(['--db', db, 'doctor'], childEnv);
    assert.equal(doc.code, 0, doc.stderr);
    assert.match(doc.stdout, /配置文件：已加载/);
    assert.match(doc.stdout, /模型 deepseek-flash，思考 max（deepseek），带凭据/);
    assert.ok(!doc.stdout.includes('loopback-secret-key'));

    // capture + concresce 真实走配置文件和回环端点
    const cap = await runCli(['--db', db, 'capture', '--kind', 'correction', '--summary', '删目录之前先 ls -la 看一眼是不是软链接，确认后再删。'], childEnv);
    assert.equal(cap.code, 0, cap.stderr);
    const con = await runCli(['--db', db, 'concresce'], childEnv);
    assert.equal(con.code, 0, con.stderr);
    assert.match(con.stdout, /add → 原则 #1/);
    assert.equal(receivedAuth, 'Bearer loopback-secret-key');
    assert.deepEqual((receivedBody as Record<string, unknown> | null)?.thinking, { type: 'enabled' });
    assert.equal((receivedBody as Record<string, unknown> | null)?.reasoning_effort, 'max');

    // OpenAiCompatibleCondenseModel 也直接可用
    const direct = new OpenAiCompatibleCondenseModel(hostCfg.llm!);
    assert.match(direct.id, /deepseek-flash/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
