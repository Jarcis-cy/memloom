/**
 * memloom M1 核心内核的公开入口。
 * 这一层只有：单文件 SQLite 真源、经历采集（纠错 / 复盘 / 抢救）、字面召回、凝结与三级冲突自愈。
 * 模型一律通过可注入接口进来；M1 不自带任何外部模型，也没有语义向量检索。
 */

export {
  EXPERIENCE_KINDS,
  EXPERIENCE_SOURCES,
  PRINCIPLE_LIMITS,
  PRINCIPLE_STATUSES,
  DILEMMA_KINDS,
  parseScope,
  assertScope,
} from './types.js';
export type * from './types.js';
export { Store, openStore } from './store.js';
export { SCHEMA_SQL, FTS_TRIGGER_NAMES } from './schema.js';
export { buildQueryPlan, searchExperiences, searchPrinciples, scoreText, longestCommonSubstring } from './recall.js';
export type { QueryPlan, QuerySegment, ExperienceHit, PrincipleHit } from './recall.js';
export {
  detectCorrection,
  CorrectionThrottle,
  isReviewDue,
  ReviewTrigger,
  REVIEW_DEFAULTS,
  selectFlushWindow,
  FLUSH_WINDOW_SIZE,
  extractExperiences,
  captureCorrection,
} from './capture.js';
export type { CorrectionSignal, CorrectionCapture, ExtractOptions, ExtractResult, FlushWindow } from './capture.js';
export { condense, validatePlanShape, isNearDuplicate, PlanError, CONDENSE_DEFAULTS } from './condense.js';
export type { CondenseOptions } from './condense.js';
export { WRITING_RULES, WRITING_EXAMPLES, SPACE_RULE, condenseInstructions, EXTRACTION_INSTRUCTIONS } from '../prompts/m1.js';
