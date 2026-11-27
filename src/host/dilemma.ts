/**
 * 分歧的「轻声冒泡」（规格 §5.3）：还没提醒过的 open 分歧 ≥ 3 条、或其中有撞铁律的，才在下一新会话的开场附一段两行以内的提示；
 * 提醒过的记一次 surfaced_count，同一批绝不再提醒第二次。拍板仍走 M3 的人工入口（dilemmas resolve），这里不替用户决定。
 */
import type { Store } from '../core/store.js';

export const DILEMMA_NOTICE_THRESHOLD = 3;

export interface DilemmaNotice {
  text: string;
  surfacedIds: number[];
}

export function dilemmaNotice(input: { store: Store; scope: string }): DilemmaNotice {
  const fresh = input.store.listDilemmas(input.scope, { status: 'open' }).filter((d) => d.surfacedCount === 0);
  if (fresh.length === 0) return { text: '', surfacedIds: [] };
  const collision = fresh.some((d) => d.kind === 'iron_rule_collision');
  if (fresh.length < DILEMMA_NOTICE_THRESHOLD && !collision) return { text: '', surfacedIds: [] };
  const topics = fresh
    .slice(0, 3)
    .map((d) => (d.summary.length > 30 ? `${d.summary.slice(0, 30)}…` : d.summary))
    .join('；');
  const text =
    `顺带一提：记忆系统里目前有 ${fresh.length} 处拿不准的规则分歧${collision ? '（其中有撞上置顶铁律的）' : ''}，涉及：${topics}${fresh.length > 3 ? '等' : ''}。` +
    '你方便时可以新开一个会话，发一句「处理记忆分歧」，我会把选项用大白话列出来，你回个序号，剩下的我全部自动更新写回。';
  input.store.bumpDilemmaSurfaced(fresh.map((d) => d.id));
  return { text, surfacedIds: fresh.map((d) => d.id) };
}
