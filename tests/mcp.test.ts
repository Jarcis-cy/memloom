import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * 标准 stdio MCP 端到端：用官方 SDK 的 Client + StdioClientTransport 拉起 memloom 的 MCP 进程（临时库、临时 home），
 * 列工具、调捕获 / 召回 / 铁律 / 分歧 / 凝结（无模型如实拒绝）/ 导出；再用第二个 MCP 进程（另一个库）导入并召回。
 * 客户端能完整解析子进程 stdout，就证明 stdout 上只有协议。
 */

const MCP = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
const TOOL_NAMES = ['memloom_recall', 'memloom_capture', 'memloom_iron_rules', 'memloom_dilemmas', 'memloom_resolve_dilemma', 'memloom_concresce', 'memloom_export', 'memloom_import'];

interface Session {
  client: Client;
  transport: StdioClientTransport;
  stderr: string;
}

async function start(dbPath: string, home: string, extra: Record<string, string> = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: { ...process.env, MEMLOOM_HOME: home, MEMLOOM_DB: dbPath, ...extra },
    stderr: 'pipe',
  });
  const session: Session = { client: new Client({ name: 'memloom-test-client', version: '0.0.0' }), transport, stderr: '' };
  transport.stderr?.on('data', (chunk: Buffer) => {
    session.stderr += chunk.toString('utf8');
  });
  await session.client.connect(transport);
  return session;
}

async function call(session: Session, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: unknown }> {
  const result = (await session.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 60_000 })) as CallToolResult;
  const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 错误回执是纯文字
  }
  return { isError: result.isError === true, text, json };
}

test('标准 stdio MCP：列工具 → 捕获 / 召回 / 铁律 / 分歧 / 凝结（无模型如实拒绝）/ 导出 → 第二个进程导入并召回；stdout 只有协议', async () => {
  const home = mkdtempSync(join(tmpdir(), 'memloom-mcp-'));
  const a = join(home, 'a.db');
  const b = join(home, 'b.db');
  const first = await start(a, home);
  try {
    const tools = await first.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), TOOL_NAMES);
    assert.ok(tools.tools.every((tool) => (tool.inputSchema as { type?: string }).type === 'object'));
    assert.match(first.client.getInstructions() ?? '', /dilemmas 只在用户明确说出选 A 还是 B/);

    const captured = await call(first, 'memloom_capture', { kind: 'correction', summary: '删目录之前先 ls -la 看一眼是不是软链接，确认后再删。', evidence: '不对，先看看是不是软链接' });
    assert.equal(captured.isError, false, captured.text);
    assert.equal((captured.json as { captured: boolean; experience: { id: number } }).experience.id, 1);
    const badKind = await call(first, 'memloom_capture', { kind: 'guess', summary: '随便记一条' });
    assert.equal(badKind.isError, true);
    assert.match(badKind.text, /kind 只能是/);

    const rule = await call(first, 'memloom_iron_rules', { action: 'add', content: '没有明说怎么处理就不许擅自动手改用户的项目文件。' });
    assert.equal((rule.json as { added: { id: number } }).added.id, 1);
    const listed = await call(first, 'memloom_iron_rules', { action: 'list' });
    assert.equal((listed.json as { rules: unknown[] }).rules.length, 1);

    const recalled = await call(first, 'memloom_recall', { query: '软链接', limit: 5 });
    assert.equal(recalled.isError, false, recalled.text);
    const items = (recalled.json as { items: Array<{ type: string; summary: string }>; mode: { retriever: string } }).items;
    assert.equal(items[0]?.type, 'experience');
    assert.match(items[0]?.summary ?? '', /软链接/);
    assert.equal((recalled.json as { mode: { retriever: string } }).mode.retriever, 'fts-only');

    const dilemmas = await call(first, 'memloom_dilemmas', { action: 'list' });
    assert.equal((dilemmas.json as { open: number }).open, 0);
    const refused = await call(first, 'memloom_resolve_dilemma', { id: 7, choice: 'B', confirm: 7, trigger_when: '当你准备删除一个目录的时候', rule: '先 ls -la 看一眼是不是软链接，确认后再删，不要带尾斜杠' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /找不到编号为 7 的分歧/);
    const crossScope = await call(first, 'memloom_dilemmas', { action: 'list', scope: 'project:x' });
    assert.equal(crossScope.isError, true);
    assert.match(crossScope.text, /只能用 personal/);

    const noModel = await call(first, 'memloom_concresce', {});
    assert.equal(noModel.isError, true);
    assert.match(noModel.text, /没有配置后台模型，这次凝结没有执行/);

    const archive = join(home, 'personal.tar.gz');
    const exported = await call(first, 'memloom_export', { out_path: archive });
    assert.equal(exported.isError, false, exported.text);
    assert.equal(existsSync(archive), true);
    const defaultExport = await call(first, 'memloom_export', {});
    assert.equal(defaultExport.isError, false, defaultExport.text);
    assert.ok((defaultExport.json as { outPath: string }).outPath.includes(`${join(home, 'exports')}`), '缺省写到 <home>/exports/ 下');
    assert.equal((exported.json as { counts: { experiences: number } }).counts.experiences, 1);
    const unknown = await call(first, 'memloom_nothing', {});
    assert.equal(unknown.isError, true);
  } finally {
    await first.client.close();
  }
  assert.match(first.stderr, /memloom-mcp 已就绪（8 个工具/);

  const second = await start(b, home);
  try {
    const imported = await call(second, 'memloom_import', { archive_path: join(home, 'personal.tar.gz') });
    assert.equal(imported.isError, false, imported.text);
    const report = imported.json as { committed: boolean; post_failures: number; iron_rules: { added: number }; experiences: { added: number }; vectors: { indexed: number; note: string; status: string } };
    assert.equal(report.iron_rules.added, 1);
    assert.equal(report.experiences.added, 1);
    assert.equal(report.committed, true);
    assert.equal(report.post_failures, 0, '无模型只是正常退化，不算后置失败');
    assert.equal(report.vectors.status, 'degraded');
    assert.equal(report.vectors.indexed, 0);
    assert.match(report.vectors.note, /没有可用的向量模型/);
    const recalled = await call(second, 'memloom_recall', { query: '软链接' });
    assert.equal(((recalled.json as { items: unknown[] }).items).length, 1);
    const tampered = await call(second, 'memloom_import', { archive_path: join(home, 'nope.tar.gz') });
    assert.equal(tampered.isError, true);
    assert.match(tampered.text, /找不到归档文件/);
  } finally {
    await second.client.close();
  }
  assert.equal(existsSync(join(home, 'readable', 'personal', 'STANDING.md')), true);
  assert.match(readFileSync(join(home, 'readable', 'personal', 'STANDING.md'), 'utf8'), /没有明说怎么处理就不许擅自动手改用户的项目文件。/);
  rmSync(home, { recursive: true, force: true });
});

/** 临时项目：`.team/manifest.json` + 已经有的角色目录（memloom 不替项目建 .team，这里手工搭） */
function makeProject(home: string, projectId: string, roles: string[]): string {
  const project = join(home, `proj-${projectId}`);
  mkdirSync(join(project, '.team', 'roles'), { recursive: true });
  writeFileSync(
    join(project, '.team', 'manifest.json'),
    `${JSON.stringify({ schema_version: 1, project_id: projectId, project_name: '假项目', domain: 'custom', created_at: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
  );
  for (const role of roles) {
    mkdirSync(join(project, '.team', 'roles', role), { recursive: true });
    writeFileSync(join(project, '.team', 'roles', role, 'ROLE.md'), `# ${role}\n`);
  }
  return project;
}

test('MCP 和命令行共用同一层：角色作用域的 memloom_export 成功；另一个项目的同名角色 memloom_import 被拒绝', async () => {
  const home = mkdtempSync(join(tmpdir(), 'memloom-mcp-role-'));
  const project = makeProject(home, 'demo-proj', ['reviewer']);
  const archive = join(home, 'reviewer.tar.gz');
  const first = await start(join(project, '.team', '.mind.db'), home, { MEMLOOM_PROJECT: project, MEMLOOM_ROLE: 'reviewer' });
  try {
    const captured = await call(first, 'memloom_capture', { kind: 'pitfall', summary: '删目录之前先 ls -la 看一眼是不是软链接，不要顺着链接把目标目录删了。', evidence: '上次就是带尾斜杠 rm -rf 误删的' });
    assert.equal(captured.isError, false, captured.text);
    // 以前这里必报「导出角色归档必须给项目编号」：命令行和 MCP 走的是同一个 exportArchive，漏传的是它
    const exported = await call(first, 'memloom_export', { out_path: archive });
    assert.equal(exported.isError, false, `角色导出失败：${exported.text}`);
    const report = exported.json as { scope: string; counts: { experiences: number } };
    assert.equal(report.scope, 'role:reviewer');
    assert.equal(report.counts.experiences, 1);
    assert.equal(existsSync(archive), true);
  } finally {
    await first.client.close();
  }
  const other = makeProject(home, 'other-proj', ['reviewer']);
  const second = await start(join(other, '.team', '.mind.db'), home, { MEMLOOM_PROJECT: other, MEMLOOM_ROLE: 'reviewer' });
  try {
    const refused = await call(second, 'memloom_import', { archive_path: archive });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /来自项目「demo-proj」，当前目标是「other-proj」.*角色备份不能迁进另一个项目的同名角色/);
  } finally {
    await second.client.close();
  }
  rmSync(home, { recursive: true, force: true });
});
