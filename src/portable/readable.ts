/**
 * 人可直接阅读的 Markdown 快照（单向从数据库导出，规格 §2 / §7）：
 * `STANDING.md` 是置顶铁律，`PRINCIPLES.md` 是生效原则清单 + 历史留底。手改这些文件不会写回数据库。
 */
export interface StandingRow {
  id: number;
  active: boolean;
  content: string;
}

export interface PrincipleViewRow {
  id: number;
  triggerWhen: string;
  rule: string;
  rationale: string | null;
  status: 'active' | 'merged' | 'superseded' | 'retired';
  isCore: boolean;
  strength: number;
  appliedCount: number;
  violatedCount: number;
  retireReason: string | null;
}

const STATUS_LABEL: Record<PrincipleViewRow['status'], string> = {
  active: '生效',
  merged: '已合并',
  superseded: '已被替代',
  retired: '已退役',
};

export function renderStanding(scope: string, ironRules: readonly StandingRow[]): string {
  const lines = [`# 置顶铁律（${scope}）`, '', '> 这份文件由 memloom 从数据库单向导出，手改不会写回。', ''];
  if (ironRules.length === 0) lines.push('（还没有置顶铁律）');
  for (const rule of ironRules) lines.push(`- ${rule.active ? '' : '（已停用）'}${rule.content}`);
  return `${lines.join('\n')}\n`;
}

export function renderPrinciples(scope: string, principles: readonly PrincipleViewRow[]): string {
  const active = principles.filter((p) => p.status === 'active');
  const history = principles.filter((p) => p.status !== 'active');
  const lines = [`# 凝结原则（${scope}）`, '', '> 这份文件由 memloom 从数据库单向导出，手改不会写回。', '', `生效 ${active.length} 条，历史留底 ${history.length} 条。`, ''];
  if (active.length === 0) lines.push('（还没有生效原则）');
  for (const p of active) {
    const stats = `强度 ${p.strength.toFixed(1)}，遵守 ${p.appliedCount} 次，违背 ${p.violatedCount} 次${p.isCore ? '，常驻核心' : ''}`;
    lines.push(`- **P${p.id}**（${stats}）${p.triggerWhen}：${p.rule}`);
    if (p.rationale) lines.push(`  - 来由：${p.rationale}`);
  }
  if (history.length > 0) {
    lines.push('', '## 历史留底（不再生效，只留记录）', '');
    for (const p of history) {
      lines.push(`- **P${p.id}**（${STATUS_LABEL[p.status]}）${p.triggerWhen}：${p.rule}`);
      if (p.retireReason) lines.push(`  - 原因：${p.retireReason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 作用域写成能当目录名的样子：personal / project-<id> / role-<name> */
export function scopeSlug(scope: string): string {
  const safe = scope.replace(/[^A-Za-z0-9._-]+/g, '-');
  return safe.length > 0 ? safe : 'scope';
}
