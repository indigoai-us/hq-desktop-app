/**
 * One source for company sidepane counts (QA-014).
 *
 * Each company page publishes the real total of the list it shows (every
 * row, before tabs, search, or paging). The sidepane reads the same number,
 * so "Secrets 28" beside "Secrets · 444" cannot happen. Totals persist to
 * localStorage, so the pane paints the last known page total on launch and
 * updates in place whenever a page refreshes. The cached company summary is
 * only a fallback for rows whose page has never loaded.
 */

const STORAGE_KEY = "hq.company-page-counts.v1";

type CountMap = Record<string, number>;

function readStored(): CountMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: CountMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch (err) {
    console.warn("[company-page-counts] could not read cached counts", err);
    return {};
  }
}

let counts = $state<CountMap>(readStored());

function storeKey(company: string, rowId: string): string {
  return `${company}::${rowId}`;
}

/** Record a page's real total for one company row. */
export function publishCompanyPageCount(
  company: string | null | undefined,
  rowId: string,
  total: number,
): void {
  const id = company?.trim();
  if (!id || !Number.isFinite(total) || total < 0) return;
  const k = storeKey(id, rowId);
  if (counts[k] === total) return;
  counts = { ...counts, [k]: total };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch (err) {
    console.warn("[company-page-counts] could not persist counts", err);
  }
}

/**
 * Published page totals for a company, keyed by row id. Looks up each key
 * (slug, then uid) so pages that only know one of them still land.
 */
export function companyPageCounts(
  ...companies: Array<string | null | undefined>
): Record<string, number> {
  const out: Record<string, number> = {};
  const ids = companies.map((c) => c?.trim()).filter((c): c is string => Boolean(c));
  // Later ids first, so the earlier key (slug before uid) wins.
  for (const id of [...ids].reverse()) {
    const prefix = `${id}::`;
    for (const [k, v] of Object.entries(counts)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
  }
  return out;
}

/** Test hook: forget every published count. */
export function resetCompanyPageCounts(): void {
  counts = {};
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable in this runtime; the in-memory map is already empty.
  }
}
