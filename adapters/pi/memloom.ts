/**
 * memloom 的 Pi 胶水（纯映射，不 import Pi 的包，离线测试直接驱动）：Pi 事件 → 契约 HostEvent；HostResponse 的三段文字 → Pi 允许的位置。
 * - 静态区：每次运行把 session_start 拿到的那份原字节写回同一个 system section，整场不变；分歧提醒另起一段，也不逐轮变。
 * - 当轮提醒：只在用户原话起的运行里作为一条独立消息紧跟用户话；没有高分命中就什么都不加。
 * - 工具失败：不改工具结果；提醒在 turn_end 作为独立消息追加在这一轮工具结果之后，每个工具批次最多一段（只有首个实际失败参与）。
 * SQL、检索、提示词、去重限频全在 src/host/；这里任何失败都安静放行，绝不拦宿主。
 */
import type { HostCore } from '../../src/host/index.js';
import type { HostEvent, HostResponse } from '../../src/host/types.js';

export type Core = Pick<HostCore, 'handle' | 'close'>;
type ToolEvent = Extract<HostEvent, { type: 'tool_result' }>;
type HintMessage = { type: 'custom_message'; customType: string; content: string; display: false; details: unknown };
/** Pi 这边要用到的宿主事实，在 session_start 时取一次 */
export type PiSessionFacts = { sessionId: string; cwd: string; /** 会话里已有 user / assistant 消息：`pi -p -c` 续接时 reason 仍是 startup，只能靠这个认出 */ hasHistory: boolean };
/** 一条工具结果里胶水用得到的事实 */
export type ToolOutcome = { toolName: string; isError: boolean; exitCode?: number | null; output: string };
/** 一场会话：开场成功才有；核心随会话留着，换会话就换掉。standing / notice 是 session_start 算一次就固定的两段文字 */
type Session = { core: Core; sessionId: string; standing: string; notice: string; /** 这次运行开头交给核心的原话，用来认出 message_end 里的同一条 */ runPrompt?: string };

export const SECTION = 'memloom';
export const NOTICE_SECTION = 'memloom_notice';
export const HINT_TYPE = 'memloom-hint';

/** 宿主明说出错，或退出码是真正的非零数字 */
const failed = (tool: ToolOutcome): boolean => tool.isError === true || (typeof tool.exitCode === 'number' && tool.exitCode !== 0);
const hintMessage = (reply: HostResponse): HintMessage => ({
  type: 'custom_message', customType: HINT_TYPE, content: reply.hint, display: false,
  details: { memloom: { event: reply.event, hintState: reply.hintState } },
});

export class MemloomPiGlue {
  /** 核心按需加载、整场只建一次；加载失败就清掉，下次 session_start 再试 */
  private core: Promise<Core> | undefined;
  private current: Session | undefined;

  constructor(private readonly loadCore: () => Promise<Core>) {}

  /** 每次都向核心要一次（新开、续接、重载一个样）：同一会话号第二次拿到的是核心存下来的那份原字节 */
  async sessionStart(facts: PiSessionFacts): Promise<void> {
    await this.endSession();
    let core: Core;
    try {
      core = await (this.core ??= this.loadCore());
    } catch {
      this.core = undefined; // 核心没起来：这次没有会话，宿主照常运行
      return;
    }
    const reply = await core.handle({ type: 'session_start', sessionId: facts.sessionId, resume: facts.hasHistory, cwd: facts.cwd }).catch(() => undefined);
    if (reply) this.current = { core, sessionId: facts.sessionId, standing: reply.staticBlock ?? '', notice: reply.dilemmaNotice ?? '' };
  }

  /** 每次运行都写回同一份字节；没有会话就清掉自己的 section，不留旧字节 */
  applySections(sections: Record<string, string>): void {
    const { standing, notice } = this.current ?? { standing: '', notice: '' };
    if (standing === '') delete sections[SECTION];
    else sections[SECTION] = standing;
    if (notice === '') delete sections[NOTICE_SECTION];
    else sections[NOTICE_SECTION] = notice;
  }

  /** 交给当前会话的核心；没有会话、处理出错都安静放行 */
  private async send(event: HostEvent): Promise<HostResponse | undefined> {
    return this.current?.core.handle(event).catch(() => undefined);
  }

  /** 用户原话起的运行：原话交给核心（计数、纠错即时入库、检索提醒）；有提醒才作为一条独立消息跟着用户话 */
  async beforeAgentStart(prompt: string): Promise<{ message: HintMessage } | undefined> {
    const session = this.current;
    if (!session) return undefined;
    session.runPrompt = prompt;
    const reply = await this.send({ type: 'user_message', sessionId: session.sessionId, text: prompt });
    return reply?.hint ? { message: hintMessage(reply) } : undefined;
  }

  /**
   * message_end：运行开头的原话已在 before_agent_start 交过，不重复；中途插进来的 steer / followUp 原话只记录（纠错照样即时入库，
   * 提醒没有合适的位置挂）；assistant 最终回复留给复盘。不等核心，占不住宿主的消息流；别的角色直接忽略。
   */
  messageEnded(role: string | null, text: string): void {
    const session = this.current;
    if (!session || text === '') return;
    if (role === 'user' && text === session.runPrompt) {
      session.runPrompt = undefined;
      return;
    }
    if (role === 'user' || role === 'assistant') void this.send(role === 'user' ? { type: 'user_message', sessionId: session.sessionId, text } : { type: 'assistant_message', sessionId: session.sessionId, text });
  }

  /**
   * 一轮工具调用结束：每条结果都报给核心（计数、复盘，字段不变）；同一个批次只有首个实际失败参与提醒，其余失败带 skipHint。
   * 提醒作为独立消息追加在这一轮工具结果之后，一批最多一段，不拼字符串、不碰工具结果。
   */
  async turnEnd(tools: readonly ToolOutcome[]): Promise<{ entries: HintMessage[] } | undefined> {
    const session = this.current;
    if (!session || tools.length === 0) return undefined;
    const firstFailure = tools.findIndex(failed);
    const replies = await Promise.all(
      tools.map((tool, index) => {
        const event: ToolEvent = { type: 'tool_result', sessionId: session.sessionId, toolName: tool.toolName, isError: tool.isError, exitCode: tool.exitCode ?? null, output: tool.output };
        if (failed(tool) && index !== firstFailure) event.skipHint = true;
        return this.send(event);
      }),
    );
    const hinted = replies.find((reply) => reply?.hint);
    return hinted && { entries: [hintMessage(hinted)] };
  }

  /** 压缩前只把事件交给核心，不返回任何东西 = 不取消、不改压缩 */
  async compact(): Promise<void> {
    if (this.current) await this.send({ type: 'compact', sessionId: this.current.sessionId });
  }

  /** 关会话 / 重载 / 换会话：有会话就先 session_end（抢救 + 清对话），再关核心；可重复执行 */
  async shutdown(): Promise<void> {
    await this.endSession();
    const core = await this.core?.catch(() => undefined);
    this.core = undefined;
    core?.close();
  }

  private async endSession(): Promise<void> {
    const session = this.current;
    this.current = undefined;
    if (session) await session.core.handle({ type: 'session_end', sessionId: session.sessionId }).catch(() => undefined);
  }
}
