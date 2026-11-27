#!/usr/bin/env node
/**
 * 标准 MCP Server（stdio 传输，规格 §8）：工具与命令行一一对应，共用 src/app/ops.ts 这一层，不重复业务。
 * - stdout 只写 MCP 协议（SDK 的 StdioServerTransport），任何诊断只走 stderr；
 * - 工具参数里的 scope 只能是当前库该管的作用域（见 app/context.ts），个人 / 项目 / 角色不串；
 * - 分歧只能由用户明确选择（choice + confirm=分歧编号）后才改；后台模型没有任何改铁律的入口。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { resolveContext } from '../app/context.js';
import { Memloom, NotConfiguredError, UsageError } from '../app/ops.js';

const SERVER_INFO = { name: 'memloom', version: '0.1.0' };
const INSTRUCTIONS =
  'memloom 是跟人走的个人记忆与工作原则引擎。recall 按语义 + 字面找相关的原则和经历；capture 手动记一条经历；' +
  'iron-rules 是用户亲口钉死的底线（只有用户明确要求时才 add / disable）；dilemmas 只在用户明确说出选 A 还是 B、并确认编号后才 resolve；' +
  'concresce 需要用户配置过后台模型。个人数据和项目数据按库隔离，scope 参数只能用当前库该管的作用域。';

type Schema = Record<string, unknown>;
type Handler = (app: Memloom, args: Record<string, unknown>) => Promise<unknown> | unknown;

interface ToolSpec {
  tool: Tool;
  run: Handler;
}

const SCOPE: Schema = { type: 'string', description: '作用域：personal / project:<id> / role:<名字>；不填用当前库的默认作用域' };

function str(description: string, extra: Schema = {}): Schema {
  return { type: 'string', description, ...extra };
}

function tools(): ToolSpec[] {
  return [
    {
      tool: {
        name: 'memloom_recall',
        description: '按语义 + 字面召回与查询相关的原则与经历（返回检索档位，没经过模型精排会如实说明）',
        inputSchema: { type: 'object', properties: { query: str('一句查询'), scope: SCOPE, limit: { type: 'integer', minimum: 1, maximum: 25, description: '最多返回几条，默认 10' } }, required: ['query'] },
      },
      run: (app, args) => app.recall({ scope: args.scope as string | undefined, query: args.query as string, limit: args.limit as number | undefined }),
    },
    {
      tool: {
        name: 'memloom_capture',
        description: '手动记录一条经历（不改原则；凝结由 concresce 另行触发）',
        inputSchema: {
          type: 'object',
          properties: {
            scope: SCOPE,
            kind: str('经历类型', { enum: ['correction', 'preference', 'pitfall', 'decision', 'fact'] }),
            summary: str('一句完整自然的中文总结'),
            evidence: str('对话原文短摘录（可选）'),
            source_session: str('来源会话编号（可选）'),
          },
          required: ['kind', 'summary'],
        },
      },
      run: (app, args) =>
        app.capture({
          scope: args.scope as string | undefined,
          kind: args.kind as string,
          summary: args.summary as string,
          evidence: args.evidence as string | undefined,
          sourceSession: args.source_session as string | undefined,
        }),
    },
    {
      tool: {
        name: 'memloom_iron_rules',
        description: '置顶铁律：list 查看；add / disable 只有用户明确要求时才用（后台永远不能擅自改铁律）',
        inputSchema: {
          type: 'object',
          properties: { action: str('list / add / disable', { enum: ['list', 'add', 'disable'] }), scope: SCOPE, content: str('add 时的铁律正文（大白话中文）'), id: { type: 'integer', minimum: 1, description: 'disable 时的铁律编号' } },
          required: ['action'],
        },
      },
      run: (app, args) => app.ironRules({ scope: args.scope as string | undefined, action: args.action as string, content: args.content as string | undefined, id: args.id as number | undefined }),
    },
    {
      tool: {
        name: 'memloom_dilemmas',
        description: '真分歧队列：list 列出；resolve 必须由用户明确选择 A（保留现有原则）或 B（用用户逐字段给出的新原则接替），并带上 confirm=分歧编号',
        inputSchema: {
          type: 'object',
          properties: {
            action: str('list / resolve', { enum: ['list', 'resolve'] }),
            scope: SCOPE,
            all: { type: 'boolean', description: 'list 时是否连已解决的也列出来' },
            id: { type: 'integer', minimum: 1, description: 'resolve：分歧编号' },
            choice: str('resolve：A 或 B', { enum: ['A', 'B'] }),
            confirm: { type: 'integer', minimum: 1, description: 'resolve：肯定操作标志，必须等于分歧编号' },
            target_id: { type: 'integer', minimum: 1, description: 'resolve 选 B：被接替的原则编号（必须是这条分歧关联的原则）' },
            trigger_when: str('resolve 选 B：用户给出的新原则触发场景（4~200 字中文）'),
            rule: str('resolve 选 B：用户给出的新原则行动准则（6~600 字中文）'),
            rationale: str('resolve 选 B：来由（可选）'),
            is_core: { type: 'boolean', description: 'resolve 选 B：是否常驻核心（可选）' },
          },
          required: ['action'],
        },
      },
      run: (app, args) => {
        if (args.action === 'list') return app.dilemmasList({ scope: args.scope as string | undefined, all: args.all === true });
        return app.dilemmaResolve({
          scope: args.scope as string | undefined,
          id: args.id as number,
          choice: args.choice as string | undefined,
          confirm: args.confirm as number | undefined,
          targetId: args.target_id as number | undefined,
          triggerWhen: args.trigger_when as string | undefined,
          rule: args.rule as string | undefined,
          rationale: args.rationale as string | undefined,
          isCore: args.is_core === true,
        });
      },
    },
    {
      tool: {
        name: 'memloom_resolve_dilemma',
        description: '兼容入口（规格 §5.3）：等同于 memloom_dilemmas 的 resolve，参数相同；同样必须由用户明确选择并确认编号',
        inputSchema: {
          type: 'object',
          properties: {
            scope: SCOPE,
            id: { type: 'integer', minimum: 1, description: '分歧编号' },
            choice: str('A 或 B', { enum: ['A', 'B'] }),
            confirm: { type: 'integer', minimum: 1, description: '肯定操作标志，必须等于分歧编号' },
            target_id: { type: 'integer', minimum: 1 },
            trigger_when: str('选 B：新原则触发场景'),
            rule: str('选 B：新原则行动准则'),
            rationale: str('选 B：来由（可选）'),
            is_core: { type: 'boolean' },
          },
          required: ['id', 'choice', 'confirm'],
        },
      },
      run: (app, args) =>
        app.dilemmaResolve({
          scope: args.scope as string | undefined,
          id: args.id as number,
          choice: args.choice as string | undefined,
          confirm: args.confirm as number | undefined,
          targetId: args.target_id as number | undefined,
          triggerWhen: args.trigger_when as string | undefined,
          rule: args.rule as string | undefined,
          rationale: args.rationale as string | undefined,
          isCore: args.is_core === true,
        }),
    },
    {
      tool: {
        name: 'memloom_concresce',
        description: '手动触发一次凝结与瘦身；没有配置后台模型时会明确拒绝，不会假装成功',
        inputSchema: { type: 'object', properties: { scope: SCOPE } },
      },
      run: (app, args) => app.concresce({ scope: args.scope as string | undefined }),
    },
    {
      tool: {
        name: 'memloom_export',
        description: '把当前作用域打成纯文本归档 .tar.gz（不含数据库、向量、模型；常见凭据会掩蔽）',
        inputSchema: { type: 'object', properties: { scope: SCOPE, out_path: str('输出文件路径；不填就写到 <home>/exports/ 下并按日期命名') } },
      },
      run: (app, args) => app.exportArchive({ scope: args.scope as string | undefined, outPath: args.out_path as string | undefined }),
    },
    {
      tool: {
        name: 'memloom_import',
        description: '导入归档：先校验再一个事务写库（重复导入不产生重复记录，不覆盖本地较新文本、不改本地铁律），然后按作用域补建向量并刷新可读快照，结果分别报告',
        inputSchema: {
          type: 'object',
          properties: { archive_path: str('归档文件路径'), mode: str('merge（默认，安全增量）或 replace（把包里没有的生效原则软退役留底）', { enum: ['merge', 'replace'] }), scope: SCOPE },
          required: ['archive_path'],
        },
      },
      run: (app, args) => app.importArchive({ scope: args.scope as string | undefined, archivePath: args.archive_path as string, mode: args.mode as string | undefined }),
    },
  ];
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

async function main(): Promise<void> {
  const app = new Memloom(resolveContext({}));
  const specs = tools();
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.onerror = (error) => process.stderr.write(`memloom-mcp：${error.message}\n`);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: specs.map((spec) => spec.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const spec = specs.find((item) => item.tool.name === request.params.name);
    if (!spec) return { isError: true, content: [{ type: 'text', text: `没有这个工具：${request.params.name}` }] };
    try {
      const value: unknown = await spec.run(app, (request.params.arguments ?? {}) as Record<string, unknown>);
      // 已提交但后置步骤有失败：回执照给（结构分开标明），同时标成错误，免得调用方当成全部成功
      const flow = value as { committed?: boolean; post_failures?: number; notice?: string | null } | null;
      if (flow && flow.committed === true && (flow.post_failures ?? 0) > 0) {
        return { isError: true, content: [{ type: 'text', text: `${flow.notice ?? '已落库，但有后置步骤没完成'}\n${JSON.stringify(value, null, 1)}` }] };
      }
      return textResult(value);
    } catch (error) {
      const prefix = error instanceof NotConfiguredError ? '没有配置：' : error instanceof UsageError ? '用法不对：' : '出错：';
      return { isError: true, content: [{ type: 'text', text: `${prefix}${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`memloom-mcp 已就绪（${specs.length} 个工具，库 ${app.ctx.dbPath}，作用域 ${app.ctx.scope}）\n`);
  const shutdown = (): void => {
    app.close();
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  transport.onclose = () => {
    app.close();
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`memloom-mcp 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
