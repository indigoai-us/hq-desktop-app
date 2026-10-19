// Live details for GitHub pull request and issue links in chat: title, state,
// review decision, author, and size. Like linkTitles.ts, the UI never calls
// GitHub itself: the host registers a fetcher (the desktop app routes it to
// the link_github_summary Tauri command). Results are cached for a minute so a
// status change shows up on the next hover; misses are cached the same way.
// The cache keeps the newest MAX_ENTRIES links and drops the oldest past that.

export type GithubLinkState =
  | 'open'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'completed'
  | 'not_planned';

export interface GithubLinkSummary {
  kind: 'pull' | 'issue';
  title: string;
  state: GithubLinkState;
  review?: 'approved' | 'changes_requested' | null;
  author?: string | null;
  /** `data:` URL, never a remote image. */
  authorAvatar?: string | null;
  updatedAt?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  comments?: number | null;
}

export type GithubSummaryFetcher = (url: string) => Promise<GithubLinkSummary | null | undefined>;

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

let fetcher: GithubSummaryFetcher | null = null;
const summaries = new Map<string, { at: number; value: GithubLinkSummary | null }>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function remember(href: string, value: GithubLinkSummary | null): void {
  // Re-insert so Map order is oldest-written first, then trim from the front.
  summaries.delete(href);
  summaries.set(href, { at: Date.now(), value });
  while (summaries.size > MAX_ENTRIES) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) break;
    summaries.delete(oldest);
  }
}

export function setGithubSummaryFetcher(next: GithubSummaryFetcher | null): void {
  fetcher = next;
}

/** Cached summary; `null` when the lookup finished with nothing, `undefined` while unknown. */
export function cachedGithubSummary(href: string): GithubLinkSummary | null | undefined {
  return summaries.get(href)?.value;
}

/** Ask the host once per minute per link; listeners fire when an answer lands. */
export function requestGithubSummary(href: string, now = Date.now()): void {
  if (!fetcher || inflight.has(href)) return;
  const hit = summaries.get(href);
  if (hit && now - hit.at < TTL_MS) return;
  inflight.add(href);
  fetcher(href)
    .then((value) => {
      remember(href, value && value.title ? value : null);
    })
    .catch(() => {
      remember(href, null);
    })
    .finally(() => {
      inflight.delete(href);
      listeners.forEach((listener) => listener());
    });
}

export function onGithubSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const STATE_LABELS: Record<GithubLinkState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
  completed: 'Closed',
  not_planned: 'Not planned',
};

/** Status pill text and tone. An open PR shows its review decision instead of "Open". */
export function githubStatus(summary: GithubLinkSummary): { label: string; tone: string } {
  if (summary.kind === 'pull' && summary.state === 'open') {
    if (summary.review === 'changes_requested') return { label: 'Changes requested', tone: 'danger' };
    if (summary.review === 'approved') return { label: 'Approved', tone: 'open' };
  }
  const tone =
    summary.state === 'open'
      ? 'open'
      : summary.state === 'merged' || summary.state === 'completed'
        ? 'done'
        : summary.state === 'draft'
          ? 'muted'
          : summary.kind === 'pull'
            ? 'danger'
            : 'muted';
  return { label: STATE_LABELS[summary.state] ?? summary.state, tone };
}

/** "just now", "5m ago", "16h ago", "3d ago", then a short date. */
export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Test seams. */
export const GITHUB_SUMMARY_CACHE_LIMIT = MAX_ENTRIES;
export const GITHUB_SUMMARY_TTL_MS = TTL_MS;

export function githubSummaryCacheSizeForTest(): number {
  return summaries.size;
}

export function resetGithubSummariesForTest(): void {
  fetcher = null;
  summaries.clear();
  inflight.clear();
  listeners.clear();
}
