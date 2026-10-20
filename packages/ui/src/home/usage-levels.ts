/**
 * Company levels (usage-only-pricing US-019). Each account, company or
 * personal, climbs seven levels as its highest month of usage passes $10,
 * $50, $100, $500, $1,000, $5,000 and $10,000 (owner direction, Corey,
 * 2026-10-20: "unlock different company levels as they advance between
 * different $ tiers"; levels follow the highest month ever).
 *
 * A level, once reached, stays: the record keeps the best month seen and the
 * highest level unlocked, and only ever moves up. The accomplishment card for
 * a level fires once per person per account per device: `announced` records
 * the highest level a card was shown for.
 *
 * Data source: hq-pro has no owner-facing monthly history yet (only this
 * month's statement, `GET /v1/billing/usage?window=month`, and the staff-only
 * `GET /v1/admin/usage/month`). So the best month is the larger of the stored
 * best and this month's statement, recomputed on every read. The rollup
 * started 2026-10-11, so this month is every account's whole history today.
 *
 * Pure. Nothing here touches the DOM; storage is passed in.
 */

export interface UsageLevel {
  /** 1..7. Level 0 is "no level yet" and has no entry here. */
  n: number;
  /** Short plain name (owner pick, Corey, 2026-10-20: "Build theme"). */
  name: string;
  /** The month total that unlocks it, in cents. */
  cents: number;
}

export const USAGE_LEVELS: readonly UsageLevel[] = [
  { n: 1, name: "Sketch", cents: 1_000 },
  { n: 2, name: "Prototype", cents: 5_000 },
  { n: 3, name: "Launch", cents: 10_000 },
  { n: 4, name: "Scale", cents: 50_000 },
  { n: 5, name: "Engine", cents: 100_000 },
  { n: 6, name: "Flagship", cents: 500_000 },
  { n: 7, name: "Landmark", cents: 1_000_000 },
];

export const MAX_LEVEL = USAGE_LEVELS.length;

/** The level a month total reaches: 0 below $10, 7 at $10,000 and up. */
export function levelForCents(cents: number | null | undefined): number {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return 0;
  let n = 0;
  for (const level of USAGE_LEVELS) if (cents >= level.cents) n = level.n;
  return n;
}

export function levelInfo(n: number): UsageLevel | null {
  return USAGE_LEVELS.find((l) => l.n === n) ?? null;
}

/** The next level up, or null at the top. */
export function nextLevel(n: number): UsageLevel | null {
  return USAGE_LEVELS.find((l) => l.n === n + 1) ?? null;
}

/** "$10", "$1k", "$10k": the threshold as the level badge says it. */
export function levelThresholdText(cents: number): string {
  const usd = cents / 100;
  return usd >= 1000 ? `$${(usd / 1000).toLocaleString("en-US")}k` : `$${usd.toLocaleString("en-US")}`;
}

/** "Level 4 · Scale". */
export function levelLabel(n: number): string {
  const info = levelInfo(n);
  return info ? `Level ${info.n} · ${info.name}` : "No level yet";
}

/**
 * Progress toward the next level, 0..1, measured from the current level's
 * threshold (or $0) to the next one, by the best month. 1 at the top.
 */
export function levelProgress(bestCents: number, level: number): number {
  const next = nextLevel(level);
  if (!next) return 1;
  const from = levelInfo(level)?.cents ?? 0;
  const span = next.cents - from;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (bestCents - from) / span));
}

/** "Level 5 Engine at a $1k month", or the top-level line. */
export function nextLevelLine(level: number): string {
  const next = nextLevel(level);
  if (!next) return "Top level reached";
  return `Next: Level ${next.n} ${next.name} at a ${levelThresholdText(next.cents)} month`;
}

/** "2026-10" from an ISO day or timestamp; null when it isn't one. */
export function monthOf(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[1]}-${m[2]}` : null;
}

/** "October 2026" for a "2026-10" month key. */
export function monthName(month: string): string {
  const d = new Date(`${month}-15T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** What is stored per person, per account, on this device. */
export interface LevelRecord {
  /** The highest month total seen, in cents. */
  bestCents: number;
  /** The month it was seen in ("2026-10"). */
  bestMonth: string | null;
  /** The highest level unlocked. Never goes down. */
  level: number;
  /** The highest level a card was shown for. Never goes down. */
  announced: number;
}

export const EMPTY_LEVEL_RECORD: LevelRecord = { bestCents: 0, bestMonth: null, level: 0, announced: 0 };

/** One month as a statement reports it. */
export interface MonthObservation {
  month: string;
  cents: number;
}

export interface ObserveResult {
  record: LevelRecord;
  /** The level to announce now (the highest newly unlocked), or null. */
  announce: number | null;
}

/**
 * Fold one month into the record. The best month and the level only rise; a
 * lower month (a new month that just started) changes nothing. When the level
 * passes the last one announced, the highest new level is announced once,
 * even when several were passed at once (one card, not four).
 */
export function observeMonth(prev: LevelRecord | null | undefined, obs: MonthObservation): ObserveResult {
  const base = prev ?? EMPTY_LEVEL_RECORD;
  const cents = Number.isFinite(obs.cents) ? Math.max(0, obs.cents) : 0;
  const better = cents > base.bestCents;
  const bestCents = better ? cents : base.bestCents;
  const bestMonth = better ? obs.month : base.bestMonth;
  const level = Math.max(base.level, levelForCents(bestCents));
  const announce = level > base.announced ? level : null;
  return {
    record: { bestCents, bestMonth, level, announced: announce ?? base.announced },
    announce,
  };
}

export type LevelStorage = Pick<Storage, "getItem" | "setItem">;

export const LEVEL_STORAGE_PREFIX = "hq.usage.levels.v1";

/** Per person (the viewer) and per account, so a second sign-in on the machine gets its own cards. */
export function levelStorageKey(viewerUid: string, accountKey: string): string {
  return `${LEVEL_STORAGE_PREFIX}.${viewerUid}.${accountKey}`;
}

function nonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The stored record, or null when there is none or it is unreadable. */
export function loadLevelRecord(storage: LevelStorage | null, viewerUid: string, accountKey: string): LevelRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(levelStorageKey(viewerUid, accountKey));
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const bestCents = nonNeg(v.bestCents);
    const level = nonNeg(v.level);
    const announced = nonNeg(v.announced);
    if (bestCents === null || level === null || announced === null) return null;
    return {
      bestCents,
      bestMonth: typeof v.bestMonth === "string" ? v.bestMonth : null,
      level: Math.min(MAX_LEVEL, Math.floor(level)),
      announced: Math.min(MAX_LEVEL, Math.floor(announced)),
    };
  } catch {
    return null;
  }
}

/** Store the record. Returns false when storage refused it (full, blocked). */
export function saveLevelRecord(storage: LevelStorage | null, viewerUid: string, accountKey: string, record: LevelRecord): boolean {
  if (!storage) return false;
  try {
    storage.setItem(levelStorageKey(viewerUid, accountKey), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The meters the card names, in order, with their singular and plural words. */
const DONE_METERS: readonly { key: string; one: string; many: string }[] = [
  { key: "agent-run", one: "agent run", many: "agent runs" },
  { key: "member-sync", one: "sync", many: "syncs" },
  { key: "hq-mcp-call", one: "HQ MCP call", many: "HQ MCP calls" },
  { key: "integration-call", one: "app call", many: "app calls" },
];

/**
 * "1,240 agent runs, 3,100 syncs and 820 HQ MCP calls": what the team got
 * done in the month, from the statement's meter counts. Meters at zero or
 * missing are left out; "" when none has a count.
 */
export function teamDoneLine(counts: Readonly<Record<string, number>> | null | undefined, max = 3): string {
  if (!counts) return "";
  const parts = DONE_METERS.flatMap((m) => {
    const n = counts[m.key];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return [];
    const whole = Math.round(n);
    return [`${whole.toLocaleString("en-US")} ${whole === 1 ? m.one : m.many}`];
  }).slice(0, max);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Meter counts from raw statement lines (`{ key, usage }`); billed lines with a number only. */
export function countsFromLines(lines: readonly unknown[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines ?? []) {
    if (typeof line !== "object" || line === null) continue;
    const l = line as Record<string, unknown>;
    if (typeof l.key !== "string" || l.billed === false) continue;
    const n = l.usage;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[l.key] = n;
  }
  return out;
}
