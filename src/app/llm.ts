/**
 * 后台凝结模型的可配置实现：任意 OpenAI 兼容的 /chat/completions 端点（MEMLOOM_LLM_BASE_URL + MEMLOOM_LLM_MODEL，凭据 MEMLOOM_LLM_API_KEY）。
 * - 没配置就返回 null，调用方必须如实说「没有配置后台模型」，绝不假装成功，也绝不偷偷连任何默认服务；
 * - 配置了就意味着凝结时会把待处理经历、现有原则、铁律发给这个端点，doctor 里会把这一点写明；
 * - 凭据只留在内存里的 Authorization 头，不进日志、不进报错、不进任何回执。
 * 模型返回的整段内容当不可信数据：这里只负责把它解析成 JSON，所有校验仍在凝结核心里做。
 */
import type { CondenseContext, CondenseModel } from '../core/types.js';

export interface LlmConfig {
  /** 完整前缀，含 /v1，例如 https://api.siliconflow.cn/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

/** 三个变量一个都没设 = 没配置（返回 null）；设了一部分 = 配置错误，直接说清楚缺什么。 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv): LlmConfig | null {
  const baseUrl = env.MEMLOOM_LLM_BASE_URL?.trim() ?? '';
  const model = env.MEMLOOM_LLM_MODEL?.trim() ?? '';
  const apiKey = env.MEMLOOM_LLM_API_KEY?.trim() ?? '';
  if (baseUrl === '' && model === '' && apiKey === '') return null;
  if (baseUrl === '') throw new LlmConfigError('后台模型配置不完整：设了 MEMLOOM_LLM_MODEL 或 MEMLOOM_LLM_API_KEY，却没有 MEMLOOM_LLM_BASE_URL');
  if (model === '') throw new LlmConfigError('后台模型配置不完整：设了 MEMLOOM_LLM_BASE_URL，却没有 MEMLOOM_LLM_MODEL');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LlmConfigError(`MEMLOOM_LLM_BASE_URL 不是合法的网址：${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LlmConfigError(`MEMLOOM_LLM_BASE_URL 只支持 http / https：${baseUrl}`);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKey: apiKey === '' ? undefined : apiKey };
}

/** 回执和 doctor 里描述端点用：只露主机和模型名，不带凭据、不带路径里的查询串。 */
export function describeLlm(config: LlmConfig): string {
  const host = new URL(config.baseUrl).host;
  return `${host}（模型 ${config.model}，${config.apiKey ? '带凭据' : '不带凭据'}）`;
}

/** 从模型回复里把 JSON 抠出来：允许整段就是 JSON，也允许裹在 ```json 代码块里或夹着解释文字。 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // 退一步：找最外层的方括号或花括号
  }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start < 0 || end <= start) throw new Error('模型回复里找不到 JSON');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export class OpenAiCompatibleCondenseModel implements CondenseModel {
  readonly id: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `openai-compatible:${new URL(config.baseUrl).host}:${config.model}`;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async plan(input: CondenseContext): Promise<unknown> {
    const payload = {
      作用域: input.scope,
      触发原因: input.reason,
      待处理经历: input.experiences,
      现有生效原则: input.principles,
      置顶铁律: input.ironRules,
      未解决的分歧: input.openDilemmas,
      原则池容量: input.capacity,
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.1,
          messages: [
            { role: 'system', content: input.instructions },
            { role: 'user', content: JSON.stringify(payload, null, 1) },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`连不上后台模型端点：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`后台模型端点返回 HTTP ${response.status}：${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('后台模型端点返回的不是 JSON');
    }
    const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('后台模型端点的回复里没有 choices[0].message.content');
    return extractJson(content);
  }
}
