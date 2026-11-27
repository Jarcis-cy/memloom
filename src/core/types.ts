/**
 * memloom 核心类型：作用域、四张表的行结构、可注入的模型接口、凝结计划的动作白名单。
 * 这里只放类型和纯函数，不碰数据库。
 */

export type ScopeKind = 'personal' | 'project' | 'role';

export interface ParsedScope {
  /** 原样作用域字符串，例如 `personal`、`project:code-audit`、`role:reviewer` */
  scope: string;
  kind: ScopeKind;
  /** personal 时就是 `personal`，否则是项目名或角色名 */
  name: string;
}

const PROJECT_SCOPE = /^project:([^\s:]+)$/;
const ROLE_SCOPE = /^role:([^\s:]+)$/;

export function parseScope(scope: string): ParsedScope | null {
  if (scope === 'personal') return { scope, kind: 'personal', name: 'personal' };
  const project = PROJECT_SCOPE.exec(scope);
  if (project?.[1]) return { scope, kind: 'project', name: project[1] };
  const role = ROLE_SCOPE.exec(scope);
  if (role?.[1]) return { scope, kind: 'role', name: role[1] };
  return null;
}

export function assertScope(scope: string): ParsedScope {
  const parsed = parseScope(scope);
  if (!parsed) {
    throw new Error(`作用域写法不正确：「${scope}」。只能写 personal、project:<项目名> 或 role:<角色名>`);
  }
  return parsed;
}

/* ---------- 经历 ---------- */

export const EXPERIENCE_KINDS = ['correction', 'preference', 'pitfall', 'decision', 'fact'] as const;
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number];

export const EXPERIENCE_SOURCES = ['review', 'correction', 'flush', 'manual', 'import'] as const;
export type ExperienceSource = (typeof EXPERIENCE_SOURCES)[number];


export interface ExperienceInput {
  scope: string;
  kind: ExperienceKind;
  /** 大白话中文一句话总结，完整句子 */
  summary: string;
  /** 对话原文短摘录，用于溯源与纠偏；手动记录时可以不给 */
  evidence?: string | null;
  source: ExperienceSource;
  sourceSession?: string | null;
  /** 发生时间（ISO-8601）；不给就用写入时间 */
  occurredAt?: string;
  /** 写入时间（ISO-8601）；不给就用当前时间，测试里可以固定 */
  createdAt?: string;
}

export interface ExperienceRow {
  id: number;
  scope: string;
  kind: ExperienceKind;
  summary: string;
  evidence: string | null;
  source: ExperienceSource;
  sourceSession: string | null;
  embedding: Uint8Array | null;
  embeddingModel: string | null;
  occurredAt: string;
  createdAt: string;
  processedAt: string | null;
  hitCount: number;
  lastHitAt: string | null;
}

/* ---------- 铁律 ---------- */

export interface IronRuleRow {
  id: number;
  scope: string;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ---------- 原则 ---------- */

export const PRINCIPLE_STATUSES = ['active', 'merged', 'superseded', 'retired'] as const;
export type PrincipleStatus = (typeof PRINCIPLE_STATUSES)[number];

export interface PrincipleRow {
  id: number;
  scope: string;
  triggerWhen: string;
  rule: string;
  rationale: string | null;
  status: PrincipleStatus;
  isCore: boolean;
  /** 合并或替代了哪些旧原则（完整血缘） */
  parentIds: number[];
  sourceExperienceIds: number[];
  embedding: Uint8Array | null;
  embeddingModel: string | null;
  strength: number;
  appliedCount: number;
  violatedCount: number;
  retireReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface PrincipleInput {
  scope: string;
  triggerWhen: string;
  rule: string;
  rationale?: string | null;
  isCore?: boolean;
  parentIds?: number[];
  sourceExperienceIds?: number[];
  now: string;
}

/** 原则池容量：软上限的 80% 开始提醒模型优先抽象与淘汰，硬上限直接拒绝。 */
export interface PrincipleLimits {
  softCount: number;
  hardCount: number;
  hardChars: number;
  maxCore: number;
}

export const PRINCIPLE_LIMITS: Record<ScopeKind, PrincipleLimits> = {
  personal: { softCount: 100, hardCount: 120, hardChars: 25_000, maxCore: 8 },
  // 规格只给了 personal 与 role 两档；project 作用域暂按角色档处理，等规格补齐再调。
  project: { softCount: 30, hardCount: 40, hardChars: 8_000, maxCore: 8 },
  role: { softCount: 30, hardCount: 40, hardChars: 8_000, maxCore: 8 },
};

export interface CapacityReport {
  scope: string;
  activeCount: number;
  softCount: number;
  hardCount: number;
  activeChars: number;
  hardChars: number;
  coreCount: number;
  maxCore: number;
  /** 生效条数或字数任一达到软上限的 80% */
  nearLimit: boolean;
}

/* ---------- 分歧 ---------- */

export const DILEMMA_KINDS = ['iron_rule_collision', 'value_conflict'] as const;
export type DilemmaKind = (typeof DILEMMA_KINDS)[number];

export const DILEMMA_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type DilemmaStatus = (typeof DILEMMA_STATUSES)[number];

export interface DilemmaInput {
  scope: string;
  kind: DilemmaKind;
  summary: string;
  optionA: string;
  optionB: string;
  relatedPrincipleIds?: number[];
  sourceExperienceIds?: number[];
  now: string;
}

export interface DilemmaRow {
  id: number;
  scope: string;
  kind: DilemmaKind;
  summary: string;
  optionA: string;
  optionB: string;
  relatedPrincipleIds: number[];
  sourceExperienceIds: number[];
  status: DilemmaStatus;
  resolution: string | null;
  surfacedCount: number;
  createdAt: string;
  resolvedAt: string | null;
}

/* ---------- 可注入的模型接口（M1 只有接口，不自带任何外部模型） ---------- */

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface ExtractionInput {
  /** 自然中文的系统提示词（见 src/prompts/m1.ts） */
  instructions: string;
  scope: string;
  sessionId: string | null;
  messages: ReadonlyArray<ConversationMessage>;
}

/** 后台抽取模型：返回值一律当不可信数据，由采集核心逐条校验。 */
export interface ExtractionModel {
  readonly id: string;
  extract(input: ExtractionInput): Promise<unknown>;
}

export type CondenseReason = 'scheduled' | 'timer' | 'manual' | 'correction' | 'new_fact';


export interface CondenseContext {
  /** 自然中文的系统提示词（见 src/prompts/m1.ts） */
  instructions: string;
  scope: string;
  reason: CondenseReason;
  experiences: Array<{
    id: number;
    kind: ExperienceKind;
    summary: string;
    evidence: string | null;
    occurred_at: string;
    source: ExperienceSource;
  }>;
  principles: Array<{
    id: number;
    trigger_when: string;
    rule: string;
    rationale: string | null;
    is_core: boolean;
    strength: number;
    source_experience_ids: number[];
  }>;
  ironRules: Array<{ id: number; content: string }>;
  openDilemmas: Array<{ id: number; kind: DilemmaKind; summary: string }>;
  capacity: CapacityReport;
}

/** 后台凝结模型：返回的整个计划当不可信数据，由凝结核心整体校验后才落库。 */
export interface CondenseModel {
  readonly id: string;
  plan(input: CondenseContext): Promise<unknown>;
}

/** 可注入的语义查重判断：告诉凝结核心这条新原则是否和某条已有原则说的是同一件事。 */
export interface DuplicateJudge {
  readonly id: string;
  findDuplicate(
    candidate: { trigger_when: string; rule: string },
    existing: ReadonlyArray<{ id: number; trigger_when: string; rule: string }>,
  ): Promise<number | null>;
}

/* ---------- 凝结计划的六个动作（校验后的形态） ---------- */

export interface AddAction {
  action: 'add';
  trigger_when: string;
  rule: string;
  rationale: string | null;
  is_core: boolean;
  source_experience_ids: number[];
}

export interface ReinforceAction {
  action: 'reinforce';
  target_id: number;
  rationale: string | null;
  source_experience_ids: number[];
}

export interface AbstractMergeAction {
  action: 'abstract_merge';
  target_ids: number[];
  trigger_when: string;
  rule: string;
  rationale: string | null;
  is_core: boolean;
  source_experience_ids: number[];
}

export interface ReplaceAction {
  action: 'replace';
  target_id: number;
  trigger_when: string;
  rule: string;
  rationale: string | null;
  is_core: boolean;
  source_experience_ids: number[];
}

export interface RetireAction {
  action: 'retire';
  target_id: number;
  reason: string;
}

export interface DilemmaAction {
  action: 'dilemma';
  kind: DilemmaKind;
  summary: string;
  option_a: string;
  option_b: string;
  related_principle_ids: number[];
  source_experience_ids: number[];
}

export type PlanAction =
  | AddAction
  | ReinforceAction
  | AbstractMergeAction
  | ReplaceAction
  | RetireAction
  | DilemmaAction;

export type ActionOutcome =
  | { action: 'add'; principleId: number }
  | { action: 'reinforce'; principleId: number }
  | { action: 'abstract_merge'; principleId: number; mergedIds: number[] }
  | { action: 'replace'; principleId: number; supersededId: number }
  | { action: 'retire'; principleId: number }
  | { action: 'dilemma'; dilemmaId: number };

export type CondenseResult =
  | { ran: false; reason: 'nothing_pending'; pendingCount: number }
  | { ran: false; reason: 'below_threshold'; pendingCount: number; threshold: number }
  | { ran: true; ok: false; error: string; modelId: string }
  | {
      ran: true;
      ok: true;
      modelId: string;
      actions: ActionOutcome[];
      processedExperienceIds: number[];
    };
