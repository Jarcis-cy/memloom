/**
 * memloom M4 宿主无关核心的公开入口（契约 v1.3，见 docs/HOST-CONTRACT.md）。
 * 宿主适配层只需要这里导出的东西：HostCore + resolveHostConfig（Pi 扩展进程内常驻），或 hook-cli 的通用子进程入口 hookCliMain。
 * 这里的导出名就是契约里的字段名；改了要同步改契约版本并通知适配者。
 */
export { HostCore } from './core.js';
export type { HostCoreOptions } from './core.js';
export { resolveHostConfig, projectCraft, refreshBrief, trustedCrewCli, countCraft, craftTarget, assertCrewRole, CRAFT_START, CRAFT_END, CRAFT_HARD_LIMIT } from './crew.js';
export type { CraftReport, CraftTarget, BriefReport } from './crew.js';
export { hookCliMain } from './hook-cli.js';
export { InProcessRunner, runBackgroundJob, DEFAULT_HOOK_ENTRY } from './background.js';
export type { JobDeps, JobReport } from './background.js';
export { dilemmaNotice, DILEMMA_NOTICE_THRESHOLD } from './dilemma.js';
export type { DilemmaNotice } from './dilemma.js';
export { buildStaticBlock, stripInjections, STATIC_START, STATIC_END, HINT_START, HINT_END, STATIC_BUDGET, TOOL_NOTE, MAX_CORE } from './static.js';
export type { StaticInput, StaticResult } from './static.js';
export { shouldHint, toolFailureQuery, isStrongCorrection, recallHint, itemKey, MIN_HINT_CHARS } from './hint.js';
export type { HintRequest, HintOutcome } from './hint.js';
export { FileSessionStore, MemorySessionStore, pushMessage, uncoveredWindow, newSessionState, SESSION_TTL_MS, MAX_TRANSCRIPT } from './session.js';
export { HINT_OPTION_DEFAULTS, toolFailed, isSessionId } from './types.js';
export type {
  HostEvent,
  HostEventType,
  HostResponse,
  HostConfig,
  HostFlags,
  HintState,
  HintOptions,
  BackgroundEntry,
  BackgroundJob,
  BackgroundKind,
  BackgroundRunner,
  SessionState,
  SessionStore,
  TranscriptMessage,
  JobConfig,
} from './types.js';
