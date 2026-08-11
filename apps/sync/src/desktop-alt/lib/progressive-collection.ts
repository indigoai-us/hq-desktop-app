/** Initial render budget for each full Projects group/column. */
export const PROJECT_RENDER_BATCH = 24;

/** Overview projects-card preview budget (US-004 V2: 3 rows + View projects);
 *  full data remains available in Projects. */
export const OVERVIEW_PROJECT_LIMIT = 3;

export interface ProgressiveWindow<T> {
  items: T[];
  remaining: number;
  nextCount: number;
}

/**
 * Return the currently visible prefix plus honest remaining/next counts.
 */
export function progressiveWindow<T>(
  items: readonly T[],
  visibleCount: number,
  batchSize: number,
): ProgressiveWindow<T> {
  const safeVisible = Number.isFinite(visibleCount)
    ? Math.max(0, Math.floor(visibleCount))
    : 0;
  const safeBatch = Number.isFinite(batchSize)
    ? Math.max(1, Math.floor(batchSize))
    : 1;
  const renderedCount = Math.min(items.length, safeVisible);
  return {
    items: items.slice(0, renderedCount),
    remaining: Math.max(0, items.length - renderedCount),
    nextCount: Math.min(items.length, renderedCount + safeBatch),
  };
}
