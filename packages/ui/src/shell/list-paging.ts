/**
 * Lists never silently truncate. A list shows every row; long lists render
 * in pages of LIST_PAGE_SIZE with a "Show more" row (ShowMoreRow.svelte)
 * that also loads the next page when it scrolls into view.
 */
export const LIST_PAGE_SIZE = 50;

export interface ListPage<T> {
  /** Rows to paint now. */
  rows: T[];
  /** Every row in the list, for the section header count. */
  total: number;
  /** Rows not painted yet. Zero means the whole list is on screen. */
  remaining: number;
  /** Size of the next page, for the "Show N more" label. */
  next: number;
}

/** Paint the first `pages` pages of `rows` (at least one page). */
export function pageRows<T>(rows: readonly T[], pages: number, size = LIST_PAGE_SIZE): ListPage<T> {
  const safeSize = Number.isFinite(size) && size >= 1 ? Math.floor(size) : LIST_PAGE_SIZE;
  const safePages = Number.isFinite(pages) && pages >= 1 ? Math.floor(pages) : 1;
  const shown = Math.min(rows.length, safePages * safeSize);
  const remaining = rows.length - shown;
  return {
    rows: rows.slice(0, shown),
    total: rows.length,
    remaining,
    next: Math.min(remaining, safeSize),
  };
}

/** Section header label with the real row count: "Secrets · 10". */
export function countLabel(label: string, total: number): string {
  return `${label} · ${total.toLocaleString()}`;
}
