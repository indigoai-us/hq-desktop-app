/**
 * Turns a repo's merged PR list into something a person can take in at a
 * glance: a one-line mix by kind and the three changes most worth knowing.
 */
import { productName, repoShort } from "./brief-origin.js";
import type { BriefLine, BriefOrigin, BriefShipped } from "./brief-types.js";

const KINDS: [RegExp, string][] = [
  [/^(feat|promote)\b/i, "feature"],
  [/^fix\b/i, "fix"],
  [/^docs?\b/i, "docs"],
  [/^(chore|ci|build|refactor|test)\b/i, "chore"],
];

interface Parsed {
  kind: string;
  text: string;
}

/** "1217 feat(conduct): on by default in v16" -> { kind: "feature", text: "On by default in v16" }. */
export function parsePr(label: string): Parsed {
  const body = label.replace(/^#?\d+\s+/, "");
  const m = body.match(/^([a-z-]+)(\([^)]*\))?!?:\s*(.+)$/i);
  const prefix = m?.[1] ?? "";
  const kind = KINDS.find(([re]) => re.test(prefix))?.[1] ?? "change";
  const text = (m?.[3] ?? body).trim();
  return { kind, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

export function shippedDigest(lines: readonly BriefLine[], max = 3): { mix: string; highlights: BriefLine[] } {
  const parsed = lines.map((l) => parsePr(l.label));
  const counts = new Map<string, number>();
  for (const p of parsed) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const order = ["feature", "fix", "change", "docs", "chore"];
  const mix = order
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${k}${counts.get(k) === 1 ? "" : k === "fix" ? "es" : "s"}`)
    .join(" · ");
  const rank = (k: string) => order.indexOf(k);
  const highlights = parsed
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.kind) - rank(b.p.kind) || a.i - b.i)
    .slice(0, max)
    .map(({ p }) => ({ label: p.text.length > 72 ? `${p.text.slice(0, 71)}…` : p.text, state: p.kind.toUpperCase(), tone: "ok" as const }));
  return { mix, highlights };
}

const CONVENTIONAL = /^(feat|fix|docs?|chore|ci|build|refactor|test|perf|style|revert|promote)(\([^)]*\))?!?:\s*/i;

/**
 * A title as a person's to-do, not a PR: drops a leading "<repo> #<n>:" (or
 * "#<n>") reference and a conventional-commit prefix ("feat(pack):"), then
 * sentence-cases the rest. The reference comes back as `ref` for the peek.
 */
export function humanTitle(title: string): { text: string; ref: string | null } {
  let body = title.trim().replace(/\s+/g, " ");
  let ref: string | null = null;
  const m = body.match(/^((?:[\w.-]+\/)?[\w.-]+\s+)?#(\d+)\s*[:\-–—]?\s+/);
  if (m) {
    ref = `${(m[1] ?? "").trim()} #${m[2]}`.trim();
    body = body.slice(m[0].length);
  }
  const stripped = body.replace(CONVENTIONAL, "").trim();
  const changed = !!ref || stripped !== body;
  if (!stripped) return { text: title.trim(), ref: null };
  return { text: changed ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : stripped, ref };
}

// ---------------------------------------------------------------------------
// Shipped tiles: one per product, never per repo. Pure, no locale.
// ---------------------------------------------------------------------------

/** One tile on the shipped card: a product and what landed in it. */
export interface ShippedTile {
  /** Lowercased product name; stable key. */
  key: string;
  product: string;
  origin: BriefOrigin;
  ids: string[];
  /** Merged changes behind the tile (0 when every row is a named ship with no count). */
  merged: number;
  /** "9 merged", or the named ship when there is no count. */
  headline: string;
  /** Plain lines worth knowing, best first, at most five. The face shows the first one or two. */
  highlights: BriefLine[];
  /** "2 features · 1 fix", from the merged PR titles; empty without them. */
  mix: string;
  /** The writer's own sentence about the product, for the peek status. */
  why: string | null;
  first: boolean;
  release: string | null;
  mergeHoursMedian: number | null;
  sample: boolean;
}

const MAX_HIGHLIGHTS = 5;
const COUNT_TITLE = /^(.+?):\s*(\d+)\s+changes?\s+shipped$/i;
const LISTY_WHY = /(^|;\s*)(feat|fix|docs?|chore|ci|build|refactor|test|perf|style|revert|promote)(\([^)]*\))?!?:/i;
const RELEASE_LINE = /^(release\b|chore\(release\))/i;
const RELEASE_TITLE = /\bis out\b|^release\b|\breleased\b/i;

/**
 * The merged count a row carries: the larger of its PR lines and "N merged"
 * in its status (the writer's count may raise a rollup that listed fewer
 * lines), else "N changes shipped" in its title.
 */
export function rowMerged(row: BriefShipped): number {
  const status = row.status.match(/(\d+)\s+merged/i);
  const counted = Math.max(row.lines.length, status ? Number(status[1]) : 0);
  if (counted) return counted;
  const title = row.title.match(COUNT_TITLE);
  return title ? Number(title[2]) : 0;
}

/** A row named after a thing that shipped ("Desktop 0.11.3 is out") rather than a count or a repo. */
export function isNamedShip(row: BriefShipped): boolean {
  const t = row.title.trim();
  if (!t || COUNT_TITLE.test(t)) return false;
  const product = productName(row.origin.repo, row.origin.product);
  return t.toLowerCase() !== repoShort(row.origin.repo).toLowerCase() && t.toLowerCase() !== product.toLowerCase();
}

/** The writer's `why` as highlight lines when it is a list of PR titles ("feat(x): a; fix(y): b"); empty for prose. */
export function whyHighlights(why: string | null | undefined): string[] {
  const text = (why ?? "").trim();
  if (!text || !LISTY_WHY.test(text)) return [];
  return text
    .split(/;\s+/)
    .map((seg) => parsePr(seg.trim()).text.replace(/[.;]+$/, ""))
    .filter(Boolean);
}

/** "Release 0.11.3" from a release PR line or a named release row; null when nothing released. */
export function releaseLine(rows: readonly BriefShipped[]): string | null {
  for (const row of rows) {
    if (isNamedShip(row) && RELEASE_TITLE.test(row.title.trim())) return humanTitle(row.title).text;
  }
  for (const row of rows) {
    for (const line of row.lines) {
      const body = line.label.replace(/^#?\d+\s+/, "").trim();
      if (!RELEASE_LINE.test(body)) continue;
      const m = body.match(/^chore\(release\)!?:\s*(.+)$/i);
      return m ? `Release ${m[1]!.trim()}` : parsePr(body).text;
    }
  }
  return null;
}

/**
 * Groups shipped rows by product (the writer's `product`, else the repo's
 * product name) and sorts firsts ahead, then by merged count, then by name.
 * Highlights: named ships, the writer's highlights, a list-like `why`, then
 * the PR digest; never a "#n feat(...)" label.
 */
/**
 * A highlight with its PR references taken out: "(cherry-pick of #1219)",
 * "dropped by #4823" and bare "#123" never reach the page.
 */
export function withoutPrRefs(text: string): string {
  return text
    .replace(/\s*\((?:cherry[- ]?pick(?:ed)?(?:\s+of)?\s*)?#\d+\)/gi, "")
    .replace(/\s+(?:by|in|from|of|via|see)\s+#\d+\b/gi, "")
    .replace(/\s*#\d+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function shippedTiles(rows: readonly BriefShipped[]): ShippedTile[] {
  const groups = new Map<string, BriefShipped[]>();
  for (const row of rows) {
    const product = productName(row.origin.repo, row.origin.product) || "Other";
    const key = product.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const tiles: ShippedTile[] = [];
  for (const [key, group] of groups) {
    const product = productName(group[0]!.origin.repo, group[0]!.origin.product) || "Other";
    const named = group.filter(isNamedShip);
    const lines = group.flatMap((r) => r.lines);
    const digest = shippedDigest(lines, MAX_HIGHLIGHTS);
    const merged = group.reduce((n, r) => n + rowMerged(r), 0);
    // Without a count the named ship is the headline, so it does not repeat as a highlight.
    const headline = merged ? `${merged} merged` : named[0] ? humanTitle(named[0].title).text : group[0]!.status;
    const seen = new Set<string>([headline.toLowerCase()]);
    const highlights: BriefLine[] = [];
    const push = (label: string, state = "") => {
      const text = withoutPrRefs(label);
      const k = text.toLowerCase();
      if (!text || seen.has(k) || highlights.length >= MAX_HIGHLIGHTS) return;
      seen.add(k);
      highlights.push({ label: text.length > 72 ? `${text.slice(0, 71)}…` : text, state, tone: "ok" });
    };
    for (const r of named) push(humanTitle(r.title).text);
    for (const r of group) for (const h of r.highlights ?? []) push(humanTitle(h).text);
    for (const r of group) for (const h of whyHighlights(r.why)) push(h);
    for (const h of digest.highlights) push(h.label, h.state);
    const median = group.map((r) => r.mergeHoursMedian).find((h) => h != null && Number.isFinite(h)) ?? null;
    const why = group.map((r) => (r.why ?? "").trim()).find((w) => w && !LISTY_WHY.test(w)) ?? null;
    tiles.push({
      key,
      product,
      origin: group[0]!.origin,
      ids: group.map((r) => r.id),
      merged,
      headline,
      highlights,
      mix: digest.mix,
      why,
      first: group.some((r) => !!r.first),
      release: releaseLine(group),
      mergeHoursMedian: median,
      sample: group.some((r) => !!r.sample),
    });
  }
  return tiles.sort((a, b) => Number(b.first) - Number(a.first) || b.merged - a.merged || a.product.localeCompare(b.product));
}

/** "Median 3h 20m from open to merge"; null when unknown. */
export function mergeMedianText(hours: number | null | undefined): string | null {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const span = h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
  return `Median ${span} from open to merge`;
}

// ---------------------------------------------------------------------------
// Landing streak: consecutive local days with a merge. Pure day arithmetic.
// ---------------------------------------------------------------------------

export interface ShippedStreak {
  days: number;
  /** YYYY-MM-DD, first and last day of the run. */
  from: string;
  to: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayNumber(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day.trim());
  if (!m) return null;
  const n = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
  return Number.isFinite(n) ? n : null;
}

const dayFromNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** "Oct 6" from YYYY-MM-DD, machine-timezone independent. */
export function shortDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day.trim());
  if (!m) return day;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/**
 * The run of consecutive landing days ending on the latest one. Null under
 * two days, or (when `today` is known) when the run ended before yesterday:
 * a streak that lapsed is not a streak.
 */
export function shippedStreak(landedDays: readonly string[] | null | undefined, today?: string | null): ShippedStreak | null {
  const nums = [...new Set((landedDays ?? []).map(dayNumber).filter((n): n is number => n != null))].sort((a, b) => a - b);
  if (nums.length < 2) return null;
  const last = nums[nums.length - 1]!;
  const t = today ? dayNumber(today) : null;
  if (t != null && last < t - 1) return null;
  let i = nums.length - 1;
  while (i > 0 && nums[i - 1] === nums[i]! - 1) i -= 1;
  const days = nums.length - i;
  return days >= 2 ? { days, from: dayFromNumber(nums[i]!), to: dayFromNumber(last) } : null;
}

/** "Shipped Oct 6, 7 and 8"; past five days, "Shipped every day from Oct 6 to Oct 12". */
export function streakTitle(s: ShippedStreak): string {
  if (s.days > 5) return `Shipped every day from ${shortDay(s.from)} to ${shortDay(s.to)}`;
  const start = dayNumber(s.from)!;
  const labels: string[] = [];
  let month = "";
  for (let k = 0; k < s.days; k += 1) {
    const day = dayFromNumber(start + k);
    const [mon, num] = shortDay(day).split(" ");
    labels.push(mon === month ? num! : `${mon} ${num}`);
    month = mon!;
  }
  return `Shipped ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
