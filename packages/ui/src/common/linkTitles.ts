// Fetched page titles for generic chat links. The UI never fetches the page
// itself: the host registers a fetcher (the desktop app routes it to the
// link_page_title Tauri command, which sends no cookies or auth headers).
// Results are cached for the session; misses are cached too so a link is
// requested at most once.

export type PageTitleFetcher = (url: string) => Promise<string | null | undefined>;

let fetcher: PageTitleFetcher | null = null;
const titles = new Map<string, string | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

export function setPageTitleFetcher(next: PageTitleFetcher | null): void {
  fetcher = next;
}

/** Cached fetched title, or undefined when none is known (yet). */
export function cachedPageTitle(href: string): string | undefined {
  return titles.get(href) ?? undefined;
}

/** Ask the host for a page title once; listeners fire when one arrives. */
export function requestPageTitle(href: string): void {
  if (!fetcher || titles.has(href) || inflight.has(href)) return;
  inflight.add(href);
  fetcher(href)
    .then((title) => {
      const clean = typeof title === 'string' ? title.trim() : '';
      titles.set(href, clean || null);
      if (clean) listeners.forEach((listener) => listener());
    })
    .catch(() => {
      titles.set(href, null);
    })
    .finally(() => inflight.delete(href));
}

export function onPageTitle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function resetPageTitlesForTest(): void {
  fetcher = null;
  titles.clear();
  inflight.clear();
  listeners.clear();
}
