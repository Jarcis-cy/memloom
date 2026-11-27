import { condenseInstructions } from '../prompts/m1.js';
import type { Store } from './store.js';
import {
  DILEMMA_KINDS,
  assertScope,
  type ActionOutcome,
  type AddAction,
  type CapacityReport,
  type CondenseContext,
  type CondenseModel,
  type CondenseReason,
  type CondenseResult,
  type DilemmaKind,
  type DuplicateJudge,
  type ExperienceRow,
  type PlanAction,
  type PrincipleRow,
} from './types.js';

export const CONDENSE_DEFAULTS = { batchSize: 15, maxBatch: 20, threshold: 15 } as const;

/** 计划或落库环节发现模型输出不对时抛出；整个动作组回滚，经历保持未处理，可以重试。 */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

const HAN = /\p{Script=Han}/u;
const MAX_ACTIONS = 40;
const REINFORCE_DELTA = 0.5;

/* ====================== 动作白名单与字段校验 ====================== */

type FieldType = 'text' | 'ids' | 'id' | 'bool' | 'kind';

interface FieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
  min?: number;
  max?: number;
  minCount?: number;
  maxCount?: number;
}

const text = (name: string, min: number, max: number, required = true): FieldSpec => ({
  name,
  type: 'text',
  required,
  min,
  max,
});
const ids = (name: string, minCount = 0, maxCount = 20): FieldSpec => ({
  name,
  type: 'ids',
  required: minCount > 0,
  minCount,
  maxCount,
});
const id = (name: string): FieldSpec => ({ name, type: 'id', required: true });
const bool = (name: string): FieldSpec => ({ name, type: 'bool', required: false });

/** 六个动作各自允许的字段；多一个字段都算坏输出。 */
const ACTION_SPECS: Record<PlanAction['action'], FieldSpec[]> = {
  add: [text('trigger_when', 4, 200), text('rule', 6, 600), text('rationale', 0, 300, false), bool('is_core'), ids('source_experience_ids', 1)],
  reinforce: [id('target_id'), text('rationale', 0, 300, false), ids('source_experience_ids', 1)],
  abstract_merge: [
    ids('target_ids', 2, 4),
    text('trigger_when', 4, 200),
    text('rule', 6, 600),
    text('rationale', 0, 300, false),
    bool('is_core'),
    ids('source_experience_ids', 1),
  ],
  replace: [id('target_id'), text('trigger_when', 4, 200), text('rule', 6, 600), text('rationale', 0, 300, false), bool('is_core'), ids('source_experience_ids', 1)],
  retire: [id('target_id'), text('reason', 2, 300)],
  dilemma: [
    { name: 'kind', type: 'kind', required: true },
    text('summary', 4, 300),
    text('option_a', 2, 300),
    text('option_b', 2, 300),
    ids('related_principle_ids'),
    ids('source_experience_ids', 1),
  ],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateText(value: unknown, spec: FieldSpec, where: string): string | null {
  if (typeof value !== 'string') throw new PlanError(`${where} 的「${spec.name}」必须是文字`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (spec.required) throw new PlanError(`${where} 的「${spec.name}」不能为空`);
    return null;
  }
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.POSITIVE_INFINITY;
  if (trimmed.length < min || trimmed.length > max) {
    throw new PlanError(`${where} 的「${spec.name}」长度要在 ${min} 到 ${max} 个字之间`);
  }
  if (!HAN.test(trimmed)) throw new PlanError(`${where} 的「${spec.name}」必须用自然中文写，不能只有英文或符号`);
  return trimmed;
}

function validateIdList(value: unknown, spec: FieldSpec, where: string): number[] {
  if (!Array.isArray(value)) throw new PlanError(`${where} 的「${spec.name}」必须是编号数组`);
  const out: number[] = [];
  for (const item of value) {
    if (!Number.isSafeInteger(item) || (item as number) <= 0) {
      throw new PlanError(`${where} 的「${spec.name}」里有不合法的编号：${String(item)}`);
    }
    if (!out.includes(item as number)) out.push(item as number);
  }
  const minCount = spec.minCount ?? 0;
  const maxCount = spec.maxCount ?? Number.POSITIVE_INFINITY;
  if (out.length < minCount || out.length > maxCount) {
    throw new PlanError(`${where} 的「${spec.name}」要给 ${minCount} 到 ${maxCount} 个编号`);
  }
  return out;
}

function validateField(value: unknown, spec: FieldSpec, where: string): unknown {
  switch (spec.type) {
    case 'text':
      return validateText(value, spec, where);
    case 'ids':
      return validateIdList(value, spec, where);
    case 'id':
      if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new PlanError(`${where} 的「${spec.name}」必须是正整数编号`);
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') throw new PlanError(`${where} 的「${spec.name}」只能是 true 或 false`);
      return value;
    case 'kind':
      if (typeof value !== 'string' || !(DILEMMA_KINDS as readonly string[]).includes(value)) {
        throw new PlanError(`${where} 的「kind」只能是 iron_rule_collision 或 value_conflict`);
      }
      return value;
  }
}

function validateAction(raw: unknown, index: number): PlanAction {
  const where = `第 ${index + 1} 个动作`;
  if (!isPlainObject(raw)) throw new PlanError(`${where}不是对象`);
  const action = raw.action;
  if (typeof action !== 'string' || !(action in ACTION_SPECS)) {
    throw new PlanError(`${where}不在白名单里：${String(action)}（只能用 add / reinforce / abstract_merge / replace / retire / dilemma，模型不能碰铁律）`);
  }
  const spec = ACTION_SPECS[action as PlanAction['action']];
  const allowed = new Set<string>(['action', ...spec.map((f) => f.name)]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new PlanError(`${where}（${action}）多了不允许的字段「${key}」`);
  }
  const out: Record<string, unknown> = { action };
  for (const field of spec) {
    const value = raw[field.name];
    if (value === undefined || value === null) {
      if (field.required) throw new PlanError(`${where}（${action}）缺字段「${field.name}」`);
      out[field.name] = field.type === 'bool' ? false : field.type === 'ids' ? [] : field.type === 'text' ? null : undefined;
      if (out[field.name] === undefined) throw new PlanError(`${where}（${action}）缺字段「${field.name}」`);
      continue;
    }
    out[field.name] = validateField(value, field, where);
  }
  if (action === 'dilemma' && out.option_a === out.option_b) {
    throw new PlanError(`${where} 的两个选项一模一样，没法让用户选`);
  }
  return out as unknown as PlanAction;
}

/** 模型返回的整个计划当普通数据：数组或 { actions: [...] }，每个动作按白名单校验。 */
export function validatePlanShape(raw: unknown): PlanAction[] {
  const list = isPlainObject(raw) && Array.isArray(raw.actions) ? raw.actions : raw;
  if (!Array.isArray(list)) throw new PlanError('模型返回的不是动作数组');
  if (list.length > MAX_ACTIONS) throw new PlanError(`动作太多（${list.length} 个，一次最多 ${MAX_ACTIONS} 个）`);
  return list.map(validateAction);
}

/* ====================== 去重、容量、冲突的确定性判断 ====================== */

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '');
}

function trigramSet(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i += 1) out.add(text.slice(i, i + 3));
  return out;
}

/** 确定性近重复：去掉标点空格后一样，或者三字窗口的 Jaccard 相似度过线（默认 0.5）。 */
export function isNearDuplicate(a: string, b: string, threshold = 0.5): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  if (na.length < 3 || nb.length < 3) return false;
  const ta = trigramSet(na);
  const tb = trigramSet(nb);
  let intersection = 0;
  for (const gram of ta) if (tb.has(gram)) intersection += 1;
  return intersection / (ta.size + tb.size - intersection) >= threshold;
}

type CreatingAction = AddAction | Extract<PlanAction, { action: 'abstract_merge' | 'replace' }>;

function targetsOf(action: PlanAction): number[] {
  if (action.action === 'abstract_merge') return action.target_ids;
  if (action.action === 'replace' || action.action === 'reinforce' || action.action === 'retire') {
    return [action.target_id];
  }
  return [];
}

function labelOf(action: PlanAction): string {
  return `${action.action}${targetsOf(action).length > 0 ? ` #${targetsOf(action).join('、#')}` : ''}`;
}

/** 证据只能来自本批经历。 */
function checkBatchReferences(actions: PlanAction[], batch: ExperienceRow[]): void {
  const batchIds = new Set(batch.map((e) => e.id));
  for (const action of actions) {
    if (!('source_experience_ids' in action)) continue;
    const outside = action.source_experience_ids.filter((id) => !batchIds.has(id));
    if (outside.length > 0) {
      throw new PlanError(
        `${labelOf(action)} 引用了不在本批里的经历：${outside.join('、')}（只能用本次给你的待处理经历作证据）`,
      );
    }
  }
}

/** 登记了分歧的原则，同一个计划里不能再被别的动作改动。 */
function checkDilemmaIsolation(actions: PlanAction[]): void {
  const related = new Set<number>();
  for (const action of actions) if (action.action === 'dilemma') for (const id of action.related_principle_ids) related.add(id);
  for (const action of actions) {
    if (action.action === 'dilemma') continue;
    for (const target of targetsOf(action)) {
      if (related.has(target)) {
        throw new PlanError(`原则 #${target} 已经登记为需要用户拍板的分歧，同一个计划里不能再对它做 ${action.action}`);
      }
    }
  }
}

/** 近 80% 时只许「先腾空间再新增」：新增数减去合并/替代/淘汰数不能是正数。 */
function checkNearLimit(actions: PlanAction[], capacity: CapacityReport): void {
  if (!capacity.nearLimit) return;
  let created = 0;
  let removed = 0;
  for (const action of actions) {
    if (action.action === 'add') created += 1;
    else if (action.action === 'abstract_merge') {
      created += 1;
      removed += action.target_ids.length;
    } else if (action.action === 'replace') {
      created += 1;
      removed += 1;
    } else if (action.action === 'retire') removed += 1;
  }
  if (created - removed > 0) {
    throw new PlanError(
      `原则池已接近上限（${capacity.activeCount}/${capacity.softCount} 条，${capacity.activeChars}/${capacity.hardChars} 字），请先用 abstract_merge 或 retire 腾出空间，再新增原则`,
    );
  }
}

/** 新原则的查重：先确定性字面比对（可注入的语义判断在后），本批内部的新原则也互相比。 */
async function checkDuplicates(
  actions: PlanAction[],
  active: PrincipleRow[],
  judge: DuplicateJudge | undefined,
): Promise<void> {
  const creating = actions.filter((a): a is CreatingAction => a.action === 'add' || a.action === 'abstract_merge' || a.action === 'replace');
  const seen: Array<{ text: string; where: string }> = [];
  for (const action of creating) {
    const text = `${action.trigger_when}\n${action.rule}`;
    const own = targetsOf(action);
    for (const other of seen) {
      if (isNearDuplicate(text, other.text)) {
        throw new PlanError(`计划里的两条新原则说的是同一件事（${other.where} 和 ${labelOf(action)}），请只留一条`);
      }
    }
    for (const principle of active) {
      if (own.includes(principle.id)) continue;
      if (isNearDuplicate(text, `${principle.triggerWhen}\n${principle.rule}`)) {
        throw new PlanError(`新原则和已有的原则 #${principle.id} 字面几乎一样，请改用 reinforce 或 abstract_merge`);
      }
    }
    seen.push({ text, where: labelOf(action) });
  }
  if (!judge || creating.length === 0) return;
  for (const action of creating) {
    const own = targetsOf(action);
    const pool = active.filter((p) => !own.includes(p.id));
    const duplicateId = await judge.findDuplicate(
      { trigger_when: action.trigger_when, rule: action.rule },
      pool.map((p) => ({ id: p.id, trigger_when: p.triggerWhen, rule: p.rule })),
    );
    if (duplicateId === null) continue;
    if (!pool.some((p) => p.id === duplicateId)) {
      throw new PlanError(`语义查重（${judge.id}）返回的编号 #${duplicateId} 不在可比较的原则里，判定不可信`);
    }
    throw new PlanError(`语义查重判断新原则和已有的原则 #${duplicateId} 说的是同一件事，请改用 reinforce 或 abstract_merge`);
  }
}

/* ====================== 落库（一个事务） ====================== */

interface ApplyContext {
  scope: string;
  actions: PlanAction[];
  batch: ExperienceRow[];
  at: string;
}

function activeTarget(store: Store, id: number, scope: string): PrincipleRow {
  const row = store.findPrinciple(id);
  if (!row) throw new PlanError(`目标原则 #${id} 不存在`);
  if (row.scope !== scope) throw new PlanError(`目标原则 #${id} 不属于当前作用域，不能跨作用域改动`);
  if (row.status !== 'active') throw new PlanError(`目标原则 #${id} 已经是「${row.status}」状态，不能再被这个动作使用`);
  return row;
}

/**
 * 新旧基准：一条原则「有多新」看它依据的经历是什么时候发生的，不是它被写进库的时间。
 * 旧经历在后台排到很晚才凝出原则时，写在原则之后、发生在那条经历之后的真实纠错仍然算「更新」；
 * 原则没有任何还能查到的依据经历时，才退回它的创建时间。
 */
function evidenceBaseline(store: Store, target: PrincipleRow): string {
  const sources = target.sourceExperienceIds.length > 0 ? store.getExperiences(target.sourceExperienceIds) : [];
  const times = sources.map((e) => e.occurredAt).sort();
  return times[times.length - 1] ?? target.createdAt;
}

/** replace 必须有一条比旧原则（按依据经历的发生时间算）更新、而且是纠错或事实的经历作依据，一条就够。 */
function assertReplacementGrounded(store: Store, target: PrincipleRow, sourceIds: number[]): void {
  const baseline = evidenceBaseline(store, target);
  const experiences = store.getExperiences(sourceIds);
  const qualifying = experiences.filter(
    (e) => (e.kind === 'correction' || e.kind === 'fact') && e.occurredAt >= baseline,
  );
  if (qualifying.length === 0) {
    const kinds = experiences.map((e) => e.kind).join('、') || '没有';
    throw new PlanError(
      `replace 需要一条比原则 #${target.id} 更新的纠错或事实经历作依据；这次给的经历是：${kinds}`,
    );
  }
}

/**
 * 事务内的字面去重复核：两个互不相连的调用（两个进程、两个会话）在同一作用域上各自拿模型出计划时，
 * 事务外那次查重看到的「现有原则」可能已经过期——这边刚提交了一条字面几乎一样的新原则。
 * 这一步在同一把写锁里重读生效原则再比一遍；比出来就整体回滚，经历保持待处理。
 */
function recheckDuplicatesInTransaction(store: Store, scope: string, actions: PlanAction[]): void {
  const creating = actions.filter((a): a is CreatingAction => a.action === 'add' || a.action === 'abstract_merge' || a.action === 'replace');
  if (creating.length === 0) return;
  const active = store.listPrinciples(scope, { status: 'active' });
  for (const action of creating) {
    const own = targetsOf(action);
    const text = `${action.trigger_when}\n${action.rule}`;
    for (const principle of active) {
      if (own.includes(principle.id)) continue;
      if (isNearDuplicate(text, `${principle.triggerWhen}\n${principle.rule}`)) {
        throw new PlanError(
          `新原则和刚刚才落库的原则 #${principle.id} 字面几乎一样（别的凝结抢先了一步）；这批经历保持待处理，重新凝结时请改用 reinforce 或 abstract_merge`,
        );
      }
    }
  }
}

function applyPlan(store: Store, context: ApplyContext): ActionOutcome[] {
  const { scope, actions, batch, at } = context;
  // 同批输入复核：拉到模型计划期间，别的处理可能已经消费了这些经历
  const fresh = store.getExperiences(batch.map((e) => e.id));
  for (const experience of fresh) {
    if (experience.processedAt !== null) throw new PlanError(`经历 #${experience.id} 已经被别的凝结处理过了，请重新拉取待处理经历再试`);
  }
  if (fresh.length < batch.length) throw new PlanError('这批经历里有已经被删除的，请重新拉取待处理经历再试');
  recheckDuplicatesInTransaction(store, scope, actions);

  const outcomes: ActionOutcome[] = [];
  for (const action of actions) {
    switch (action.action) {
      case 'add': {
        const row = store.insertPrinciple({
          scope,
          triggerWhen: action.trigger_when,
          rule: action.rule,
          rationale: action.rationale,
          isCore: action.is_core,
          sourceExperienceIds: action.source_experience_ids,
          now: at,
        });
        outcomes.push({ action: 'add', principleId: row.id });
        break;
      }
      case 'reinforce': {
        const target = activeTarget(store, action.target_id, scope);
        store.reinforcePrinciple(target.id, { delta: REINFORCE_DELTA, addSourceIds: action.source_experience_ids, now: at });
        outcomes.push({ action: 'reinforce', principleId: target.id });
        break;
      }
      case 'abstract_merge': {
        const targets = action.target_ids.map((tid) => activeTarget(store, tid, scope));
        const inherited = [...new Set(targets.flatMap((t) => t.sourceExperienceIds))];
        const row = store.insertPrinciple({
          scope,
          triggerWhen: action.trigger_when,
          rule: action.rule,
          rationale: action.rationale,
          isCore: action.is_core,
          parentIds: targets.map((t) => t.id),
          sourceExperienceIds: [...new Set([...inherited, ...action.source_experience_ids])].sort((a, b) => a - b),
          now: at,
        });
        for (const target of targets) {
          store.setPrincipleStatus(target.id, 'merged', { retireReason: `已上位抽象合并为原则 #${row.id}`, now: at });
        }
        outcomes.push({ action: 'abstract_merge', principleId: row.id, mergedIds: targets.map((t) => t.id) });
        break;
      }
      case 'replace': {
        const target = activeTarget(store, action.target_id, scope);
        assertReplacementGrounded(store, target, action.source_experience_ids);
        const row = store.insertPrinciple({
          scope,
          triggerWhen: action.trigger_when,
          rule: action.rule,
          rationale: action.rationale,
          isCore: action.is_core,
          parentIds: [target.id],
          sourceExperienceIds: action.source_experience_ids,
          now: at,
        });
        store.setPrincipleStatus(target.id, 'superseded', {
          retireReason: `被原则 #${row.id} 替代：${action.rationale ?? '用户最新的纠错或事实'}`,
          now: at,
        });
        outcomes.push({ action: 'replace', principleId: row.id, supersededId: target.id });
        break;
      }
      case 'retire': {
        const target = activeTarget(store, action.target_id, scope);
        store.setPrincipleStatus(target.id, 'retired', { retireReason: action.reason, now: at });
        outcomes.push({ action: 'retire', principleId: target.id });
        break;
      }
      case 'dilemma': {
        for (const relatedId of action.related_principle_ids) {
          const related = store.findPrinciple(relatedId);
          if (!related || related.scope !== scope) throw new PlanError(`分歧引用的原则 #${relatedId} 不存在或不在当前作用域`);
        }
        const signature = `${action.kind}:${normalizeText(action.summary)}`;
        for (const open of store.listDilemmas(scope, { status: 'open' })) {
          if (`${open.kind}:${normalizeText(open.summary)}` === signature) {
            throw new PlanError(`同样的分歧已经登记过（#${open.id}），不要重复登记`);
          }
        }
        const row = store.insertDilemma({
          scope,
          kind: action.kind as DilemmaKind,
          summary: action.summary,
          optionA: action.option_a,
          optionB: action.option_b,
          relatedPrincipleIds: action.related_principle_ids,
          sourceExperienceIds: action.source_experience_ids,
          now: at,
        });
        outcomes.push({ action: 'dilemma', dilemmaId: row.id });
        break;
      }
    }
  }

  // 容量硬上限：条数、字数、常驻核心条数，超了就整体回滚
  const after = store.capacity(scope);
  if (after.activeCount > after.hardCount) {
    throw new PlanError(`应用后生效原则会到 ${after.activeCount} 条，超过硬上限 ${after.hardCount} 条；请先 abstract_merge 或 retire`);
  }
  if (after.activeChars > after.hardChars) {
    throw new PlanError(`应用后生效原则会到 ${after.activeChars} 字，超过硬上限 ${after.hardChars} 字；请先 abstract_merge 或 retire`);
  }
  if (after.coreCount > after.maxCore) {
    throw new PlanError(`应用后常驻核心原则会到 ${after.coreCount} 条，超过上限 ${after.maxCore} 条；请把 is_core 改成 false`);
  }

  // 动作组和「标记已处理」同一事务
  store.markExperiencesProcessed(batch.map((e) => e.id), at);
  return outcomes;
}

/* ====================== 入口 ====================== */

export interface CondenseOptions {
  store: Store;
  scope: string;
  model: CondenseModel;
  /** 默认 scheduled：待处理经历攒够 threshold 条才跑；timer / manual / correction / new_fact 立刻跑 */
  reason?: CondenseReason;
  /** 指定提前处理的待处理经历（纠错即时路径），必须是当前作用域里还没处理的；一次最多 20 条，超了直接拒绝 */
  experienceIds?: number[];
  /** 一批最多处理几条，默认 15，上限 20 */
  batchSize?: number;
  /** 默认 15 */
  threshold?: number;
  /** 可注入的语义查重；不给就只做确定性去重 */
  judge?: DuplicateJudge;
  now?: () => string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 凝结一批经历：拉上下文 → 让注入的模型出计划 → 整体校验（白名单、证据、去重、容量、作用域）
 * → 同一个事务里落动作并标记经历已处理。任何一步不对就整体回滚，经历保持未处理，可以重试。
 */
export async function condense(options: CondenseOptions): Promise<CondenseResult> {
  const { store, model } = options;
  const scope = assertScope(options.scope).scope;
  const reason: CondenseReason = options.reason ?? 'scheduled';
  const threshold = options.threshold ?? CONDENSE_DEFAULTS.threshold;
  const batchSize = clamp(options.batchSize ?? CONDENSE_DEFAULTS.batchSize, 1, CONDENSE_DEFAULTS.maxBatch);
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();

  // 1. 取这一批
  // 显式指定经历同样受「一批最多 20 条」约束：先看数量，超了在查库、送模型之前就拒绝，不截断、不丢，全部保持待处理
  const requested = options.experienceIds ?? [];
  if (requested.length > CONDENSE_DEFAULTS.maxBatch) {
    throw new PlanError(
      `一次最多处理 ${CONDENSE_DEFAULTS.maxBatch} 条经历，这次指定了 ${requested.length} 条；请分成几批再跑。` +
        '这些经历都还是待处理状态，没有被截断也没有被丢掉',
    );
  }
  let batch: ExperienceRow[];
  const pendingTotal = store.countPendingExperiences(scope);
  if (options.experienceIds && options.experienceIds.length > 0) {
    batch = store.getExperiences(options.experienceIds);
    const found = new Set(batch.map((e) => e.id));
    const missing = options.experienceIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new PlanError(`指定的经历不存在：${missing.join('、')}`);
    const bad = batch.filter((e) => e.scope !== scope || e.processedAt !== null);
    if (bad.length > 0) {
      throw new PlanError(`指定的经历里有不在当前作用域或已经处理过的：${bad.map((e) => e.id).join('、')}`);
    }
  } else {
    batch = store.listPendingExperiences(scope, batchSize);
  }
  if (batch.length === 0) return { ran: false, reason: 'nothing_pending', pendingCount: pendingTotal };
  if (reason === 'scheduled' && pendingTotal < threshold) {
    return { ran: false, reason: 'below_threshold', pendingCount: pendingTotal, threshold };
  }

  // 2. 上下文：铁律只读，一起给模型看，用来判断有没有撞上铁律
  const active = store.listPrinciples(scope, { status: 'active' });
  const capacity = store.capacity(scope);
  const context: CondenseContext = {
    instructions: condenseInstructions(capacity.maxCore),
    scope,
    reason,
    experiences: batch.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
      evidence: e.evidence,
      occurred_at: e.occurredAt,
      source: e.source,
    })),
    principles: active.map((p) => ({
      id: p.id,
      trigger_when: p.triggerWhen,
      rule: p.rule,
      rationale: p.rationale,
      is_core: p.isCore,
      strength: p.strength,
      source_experience_ids: p.sourceExperienceIds,
    })),
    ironRules: store.listIronRules(scope).map((r) => ({ id: r.id, content: r.content })),
    openDilemmas: store.listDilemmas(scope).map((d) => ({ id: d.id, kind: d.kind, summary: d.summary })),
    capacity,
  };

  // 3. 模型计划一律当普通数据
  let raw: unknown;
  try {
    raw = await model.plan(context);
  } catch (error) {
    return { ran: true, ok: false, error: `模型「${model.id}」没有给出计划：${error instanceof Error ? error.message : String(error)}`, modelId: model.id };
  }

  let actions: PlanAction[];
  try {
    actions = validatePlanShape(raw);
    checkBatchReferences(actions, batch);
    checkDilemmaIsolation(actions);
    await checkDuplicates(actions, active, options.judge);
    checkNearLimit(actions, capacity);
  } catch (error) {
    if (error instanceof PlanError) return { ran: true, ok: false, error: error.message, modelId: model.id };
    throw error;
  }

  // 4. 一个事务：复核同批输入与目标 → 落动作 → 容量 → 标记已处理
  try {
    const outcomes = store.transaction(() => applyPlan(store, { scope, actions, batch, at }));
    return { ran: true, ok: true, modelId: model.id, actions: outcomes, processedExperienceIds: batch.map((e) => e.id) };
  } catch (error) {
    if (error instanceof PlanError) return { ran: true, ok: false, error: error.message, modelId: model.id };
    throw error;
  }
}
