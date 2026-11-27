/**
 * memloom 的 Pi 扩展入口（Pi 1.4.0 实测；加载与说明见 adapters/README.md）：pi -e <memloom 仓库>/adapters/pi/index.ts
 * 只把 Pi 的事件接到 memloom.ts 的纯映射上。核心入口默认是 <仓库>/dist/src/host/index.js（先 npm run build），
 * 可用环境变量 MEMLOOM_HOST_ENTRY 指到别的 file URL。这里不打印任何东西：核心没起来、处理出错都由胶水安静放行。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemloomPiGlue, type Core, type PiSessionFacts, type ToolOutcome } from "./memloom.ts";

async function loadCore(): Promise<Core> {
  const mod = await import(process.env.MEMLOOM_HOST_ENTRY ?? new URL("../../dist/src/host/index.js", import.meta.url).href);
  return new mod.HostCore(mod.resolveHostConfig({}, process.env)) as Core;
}

/** 消息内容可能是字符串，也可能是分块数组，只取文字 */
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part) => (part?.type === "text" ? [String(part.text ?? "")] : [])).join("\n") : "";
/** 工具自己的结构化结果里带退出码就带上；Pi 1.4.0 的 turn_end 实测为空，这时成败由 isError 决定 */
const exitCodeOf = (result: { structuredContent?: unknown }): number | null => {
  const code = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
  return typeof code === "number" ? code : null;
};

export default function memloom(pi: ExtensionAPI) {
  const glue = new MemloomPiGlue(loadCore);

  pi.on("session_start", async (_event, ctx) => {
    // 会话号只认宿主当前会话；续接与否看有没有 user / assistant 消息：不看 reason（`pi -p -c` 是 startup），
    // 也不看条目数（新会话一开始就有 model_change / thinking_level_change 两条非消息条目）
    const talked = ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
    const facts: PiSessionFacts = { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, hasHistory: talked };
    await glue.sessionStart(facts);
  });

  pi.on("before_agent_start", async (event) => {
    glue.applySections(event.systemPromptOptions.sections);
    if (event.messageType === "user") return glue.beforeAgentStart(event.prompt);
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: unknown; content?: unknown };
    glue.messageEnded(typeof message.role === "string" ? message.role : null, textOf(message.content));
  });

  pi.on("turn_end", async (event) => {
    // 每条工具结果原样翻译：成败、退出码、输出文本
    const tools: ToolOutcome[] = event.toolResults.map((result) => ({
      toolName: result.toolName, isError: result.isError, exitCode: exitCodeOf(result as { structuredContent?: unknown }), output: textOf(result.content),
    }));
    return glue.turnEnd(tools);
  });

  pi.on("session_before_compact", async () => glue.compact());
  pi.on("session_shutdown", async () => glue.shutdown());
}
