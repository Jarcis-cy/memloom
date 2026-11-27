/**
 * 双区注入的「静态区」（规格 §4.1）和「去掉自己的注入」：
 * - 静态区只放当前作用域生效的铁律 + 至多 8 条常驻核心原则 + 一句工具说明，整块（含包装）≤ 3,000 字符；
 *   放不下按强度从低到高整条舍弃并写明「还有 N 条」，绝不截半句、绝不把动态提醒揉进来。
 * - 动态提醒块（<memory-hint>）和静态块都是 memloom 自己写进对话的文字：送给后台抽取前要原样去掉，不让模型从自己的注入里学。
 */
import type { IronRuleRow, PrincipleRow } from '../core/types.js';

export const STATIC_START = '<memloom-standing>';
export const STATIC_END = '</memloom-standing>';
export const HINT_START = '<memory-hint>';
export const HINT_END = '</memory-hint>';
export const STATIC_BUDGET = 3_000;
export const MAX_CORE = 8;

/** 一句工具说明（≤ 200 字）：告诉模型怎么按需深查历史、怎么处理分歧。 */
export const TOOL_NOTE =
  '需要翻更久的历史时，用命令 memloom recall <关键词>（或 MCP 工具 memloom_recall）按需深查；想处理拿不准的规则分歧时，对新会话说一句「处理记忆分歧」。';

export interface StaticInput {
  ironRules: ReadonlyArray<Pick<IronRuleRow, 'id' | 'content'>>;
  corePrinciples: ReadonlyArray<Pick<PrincipleRow, 'id' | 'triggerWhen' | 'rule' | 'strength'>>;
  budget?: number;
}

export interface StaticResult {
  /** 空串 = 这个作用域现在没有任何可注入内容 */
  block: string;
  /** 进了静态区的原则键（P12），动态提醒据此去重 */
  keys: string[];
  droppedCore: number;
  droppedIron: number;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function assemble(iron: readonly string[], core: readonly string[], droppedIron: number, droppedCore: number): string {
  const lines: string[] = [STATIC_START];
  if (iron.length > 0 || droppedIron > 0) {
    lines.push('<iron-rules>', ...iron.map((rule) => `- ${rule}`));
    if (droppedIron > 0) lines.push(`- 还有 ${droppedIron} 条铁律因为常驻区放不下没列进来，用 memloom recall 查`);
    lines.push('</iron-rules>');
  }
  if (core.length > 0 || droppedCore > 0) {
    lines.push('<core-principles>', ...core.map((line) => `- ${line}`));
    if (droppedCore > 0) lines.push(`- 还有 ${droppedCore} 条常驻核心原则因为放不下没列进来，用 memloom recall 查`);
    lines.push('</core-principles>');
  }
  lines.push('<tools>', TOOL_NOTE, '</tools>', STATIC_END);
  return lines.join('\n');
}

/** 常驻核心按强度降序、同强度编号小者在前；铁律按编号。 */
export function buildStaticBlock(input: StaticInput): StaticResult {
  const budget = input.budget ?? STATIC_BUDGET;
  const iron = input.ironRules.filter((rule) => rule.content.trim() !== '').map((rule) => oneLine(rule.content));
  const sorted = [...input.corePrinciples]
    .filter((p) => `${p.triggerWhen}${p.rule}`.trim() !== '')
    .sort((a, b) => b.strength - a.strength || a.id - b.id)
    .slice(0, MAX_CORE)
    .map((p) => `${oneLine(p.triggerWhen)}：${oneLine(p.rule)}`);
  if (iron.length === 0 && sorted.length === 0) return { block: '', keys: [], droppedCore: 0, droppedIron: 0 };
  let coreCount = sorted.length;
  let ironCount = iron.length;
  let block = assemble(iron.slice(0, ironCount), sorted.slice(0, coreCount), iron.length - ironCount, sorted.length - coreCount);
  while (block.length > budget && coreCount > 0) {
    coreCount -= 1;
    block = assemble(iron.slice(0, ironCount), sorted.slice(0, coreCount), iron.length - ironCount, sorted.length - coreCount);
  }
  while (block.length > budget && ironCount > 0) {
    ironCount -= 1;
    block = assemble(iron.slice(0, ironCount), sorted.slice(0, coreCount), iron.length - ironCount, sorted.length - coreCount);
  }
  const keptIds = [...input.corePrinciples]
    .filter((p) => `${p.triggerWhen}${p.rule}`.trim() !== '')
    .sort((a, b) => b.strength - a.strength || a.id - b.id)
    .slice(0, coreCount)
    .map((p) => `P${p.id}`);
  return { block, keys: keptIds, droppedCore: sorted.length - coreCount, droppedIron: iron.length - ironCount };
}

/** 去掉 memloom 自己注入的文字：静态块整块、提醒块整块（都是多行标签，非贪婪匹配到对应的结束标签）。 */
export function stripInjections(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(/<memory-hint>[\s\S]*?<\/memory-hint>/g, '')
    .replace(/<memloom-standing>[\s\S]*?<\/memloom-standing>/g, '')
    .trim();
}
