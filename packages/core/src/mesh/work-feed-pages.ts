/**
 * Paging for GET /v1/work-mesh/work (hq-pro #5004).
 *
 * The server bounds each response (default 1000 rows, 4.5 MiB) and adds
 * `hasMore` plus `nextCursor` when rows were cut. The client fetches the rest
 * with `pageCursor=<nextCursor>`. Every page of one walk returns the same sync
 * `cursor`. Rows are ordered `open` first, then `changed`, newest activity
 * first within each section.
 *
 * Backward compatible: servers that predate paging send no `hasMore`, which is
 * treated as false, so the first response is the whole feed.
 */

export const WORK_FEED_PATH = "/v1/work-mesh/work";

/** Upper bound on pages fetched for one feed read. */
export const WORK_FEED_MAX_PAGES = 50;

export type WorkFeedPageFetch = (pageCursor: string | undefined) => Promise<unknown>;

export interface WorkFeedPagesResult {
  /**
   * The merged feed: the first page's fields with `open` / `changed`
   * concatenated across pages. `hasMore` is false and `nextCursor` is removed
   * unless the page cap stopped the walk (`truncated`).
   */
  state: unknown;
  /** Number of page requests made. */
  pages: number;
  /** True when the page cap stopped the walk while the server still had rows. */
  truncated: boolean;
}

export interface WorkFeedPagesOptions {
  maxPages?: number;
  /** Warning sink (defaults to console.warn). Never receives row content. */
  warn?: (message: string, detail: Record<string, unknown>) => void;
}

/** A page after the first failed. `partial` holds the rows merged so far. */
export class WorkFeedPagingError extends Error {
  constructor(
    readonly failure: unknown,
    readonly partial: WorkFeedPagesResult,
  ) {
    super("work feed paging failed");
    this.name = "WorkFeedPagingError";
  }
}

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function rowsOf(rec: Rec, key: "open" | "changed"): unknown[] {
  const value = rec[key];
  return Array.isArray(value) ? value : [];
}

function nextCursorOf(rec: Rec): string | undefined {
  if (rec.hasMore !== true) return undefined;
  const next = rec.nextCursor;
  return typeof next === "string" && next.length > 0 ? next : undefined;
}

function syncCursorOf(rec: Rec): string | undefined {
  return typeof rec.cursor === "string" ? rec.cursor : undefined;
}

function rowKey(row: unknown): string | undefined {
  const rec = asRec(row);
  if (!rec) return undefined;
  const id = rec.threadId ?? rec.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

class Accumulator {
  readonly first: Rec;
  readonly open: unknown[] = [];
  readonly changed: unknown[] = [];
  private readonly seen = new Set<string>();

  constructor(first: Rec) {
    this.first = first;
    this.add(first);
  }

  add(page: Rec): void {
    for (const key of ["open", "changed"] as const) {
      for (const row of rowsOf(page, key)) {
        const id = rowKey(row);
        if (id) {
          const seenKey = `${key}:${id}`;
          if (this.seen.has(seenKey)) continue;
          this.seen.add(seenKey);
        }
        this[key].push(row);
      }
    }
  }

  result(pages: number, truncated: boolean, lastNext?: string): WorkFeedPagesResult {
    const { nextCursor: _drop, ...rest } = this.first;
    void _drop;
    const state: Rec = {
      ...rest,
      open: this.open,
      changed: this.changed,
      hasMore: truncated,
      ...(truncated && lastNext ? { nextCursor: lastNext } : {}),
    };
    return { state, pages, truncated };
  }
}

/**
 * Fetch every page of one work-feed read and merge them.
 *
 * `fetchPage(undefined)` must request the first page exactly as before
 * paging existed; `fetchPage(token)` requests `pageCursor=<token>` (and the
 * same sync cursor). It throws on HTTP or body errors.
 *
 * - First-page errors propagate unchanged.
 * - A later-page error throws WorkFeedPagingError with the rows merged so far.
 * - A non-object first page is returned untouched (single page).
 * - If a later page reports a different sync cursor, the server restarted the
 *   walk (its page token expired), so the merge restarts from that page.
 */
export async function fetchWorkFeedPages(
  fetchPage: WorkFeedPageFetch,
  opts: WorkFeedPagesOptions = {},
): Promise<WorkFeedPagesResult> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? WORK_FEED_MAX_PAGES));
  const warn =
    opts.warn ??
    ((message: string, detail: Record<string, unknown>) =>
      console.warn(message, detail));

  const firstRaw = await fetchPage(undefined);
  const first = asRec(firstRaw);
  let next = first ? nextCursorOf(first) : undefined;
  // Single page (or a pre-paging server): hand the response back untouched.
  if (!first || !next) return { state: firstRaw, pages: 1, truncated: false };

  let acc = new Accumulator(first);
  let pages = 1;
  const used = new Set<string>();

  while (next) {
    if (pages >= maxPages) {
      warn("[hq-work-feed] page cap reached", { event: "page-cap", pages, maxPages });
      return acc.result(pages, true, next);
    }
    if (used.has(next)) {
      warn("[hq-work-feed] page cursor repeated", { event: "page-cursor-repeat", pages });
      return acc.result(pages, true, next);
    }
    used.add(next);

    let raw: unknown;
    try {
      raw = await fetchPage(next);
    } catch (error) {
      throw new WorkFeedPagingError(error, acc.result(pages, true, next));
    }
    pages += 1;
    const page = asRec(raw);
    if (!page) {
      throw new WorkFeedPagingError(
        new Error("work feed page was not an object"),
        acc.result(pages, true, next),
      );
    }
    const firstCursor = syncCursorOf(acc.first);
    const pageCursor = syncCursorOf(page);
    if (firstCursor !== undefined && pageCursor !== undefined && pageCursor !== firstCursor) {
      warn("[hq-work-feed] sync cursor changed mid-walk; restarting merge", {
        event: "walk-restart",
        pages,
      });
      acc = new Accumulator(page);
    } else {
      acc.add(page);
    }
    next = nextCursorOf(page);
  }
  return acc.result(pages, false);
}

/** Path for one work-feed page, keeping the caller's sync cursor. */
export function workFeedPagePath(
  basePath: string,
  syncCursor: string | undefined,
  pageCursor: string | undefined,
): string {
  const url = new URL(basePath, "http://local.invalid");
  if (syncCursor) url.searchParams.set("cursor", syncCursor);
  if (pageCursor) url.searchParams.set("pageCursor", pageCursor);
  return `${url.pathname}${url.search}`;
}

/** True when `path` targets GET /v1/work-mesh/work (any query string). */
export function isWorkFeedPath(path: string): boolean {
  return new URL(path, "http://local.invalid").pathname === WORK_FEED_PATH;
}
