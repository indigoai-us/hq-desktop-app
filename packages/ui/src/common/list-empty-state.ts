/**
 * Shared empty-state copy for every list that has a search box or filter
 * (QA-058). A list that is empty only because the query or filter hides its
 * rows must say so and offer a way back; "nothing here yet" is reserved for a
 * list whose unfiltered source is genuinely empty.
 */

export interface ListEmptyInput {
  /** Rows in the unfiltered source list. */
  total: number;
  /** Rows left after the query and filters. */
  shown: number;
  /** Free-text search, if the list has one. */
  query?: string;
  /** True when a non-default filter (tab, chip, scope) is active. */
  filtered?: boolean;
  /** Singular and plural noun for the total, e.g. ["file", "files"]. */
  noun: readonly [string, string];
  /** Copy for a genuinely empty list. Defaults to "Nothing here yet." */
  emptyCopy?: string;
}

export type ListEmptyState =
  | { kind: "empty"; title: string }
  | { kind: "no-matches"; title: string; totalLabel: string };

export function countLabel(count: number, noun: readonly [string, string]): string {
  return `${count} ${count === 1 ? noun[0] : noun[1]}`;
}

/** Returns null when the list has rows to show. */
export function listEmptyState(input: ListEmptyInput): ListEmptyState | null {
  if (input.shown > 0) return null;
  const q = (input.query ?? "").trim();
  if (input.total > 0 && (q || input.filtered)) {
    return {
      kind: "no-matches",
      title: q ? `No matches for '${q}'` : "No matches for these filters",
      totalLabel: countLabel(input.total, input.noun),
    };
  }
  if (input.total > 0) return null;
  return { kind: "empty", title: input.emptyCopy ?? "Nothing here yet." };
}
