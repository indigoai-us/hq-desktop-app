export function getVisibleSidebarRows<T extends { active: boolean }>(
  rows: T[],
  expanded: boolean,
  limit = 7,
): T[] {
  if (expanded || rows.length <= limit) return rows;

  const visible = rows.slice(0, limit);
  const active = rows.find((row) => row.active);
  if (!active || visible.includes(active)) return visible;

  return [...visible.slice(0, Math.max(0, limit - 1)), active];
}
