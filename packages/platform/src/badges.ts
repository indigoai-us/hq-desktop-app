/**
 * Accomplishment badges from hq-pro: `GET /v1/badges/{uid}` with `uid` either
 * `me` or a `prs_*` person uid.
 *
 *   200 { enabled: false, subject: null, consent: null, badges: [], progress: [] }
 *       while the `badges.api` flag is off;
 *   200 { enabled: true, subject: { uid, kind: "person" }, consent,
 *         badges: [{ id, tier, earnedAt }], progress: [{ id, current, target, unit }] };
 *   404 BADGES_SUBJECT_NOT_FOUND for agents, non-teammates and missing rows;
 *   400 BADGES_BAD_UID.
 *
 * The response is untrusted at this boundary: anything that is not the shape
 * above is dropped here, so the UI only ever sees well-formed rows. Which ids
 * the app knows (and how a tier is drawn) is the UI catalog's call, not this
 * file's.
 */

/** Tier as hq-pro sends it: 1 bronze, 2 silver, 3 gold. "L" is the legacy legendary tier. */
export type BadgeWireTier = 1 | 2 | 3 | "L";

export interface BadgeWire {
  id: string;
  tier: BadgeWireTier;
  /** ISO-8601. */
  earnedAt: string;
}

export interface BadgeProgressWire {
  id: string;
  current: number;
  /** The count that earns the first tier. */
  target: number;
  /** Plural unit, e.g. "skills". */
  unit: string;
}

export interface BadgesPayload {
  /** False while the server's feature flag is off; nothing else is filled then. */
  enabled: boolean;
  subject: { uid: string; kind: "person" } | null;
  consent: "granted" | "not-granted" | null;
  badges: BadgeWire[];
  progress: BadgeProgressWire[];
}

/** The payload of a response that says nothing: no badges, no progress. */
export const NO_BADGES: Readonly<BadgesPayload> = Object.freeze({
  enabled: false,
  subject: null,
  consent: null,
  badges: [],
  progress: [],
});

const BADGE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const TIERS: readonly unknown[] = [1, 2, 3, "L"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function badgeId(value: unknown): string | null {
  return typeof value === "string" && BADGE_ID.test(value) ? value : null;
}

function badge(value: unknown): BadgeWire | null {
  const row = record(value);
  if (!row) return null;
  const id = badgeId(row.id);
  const tier = TIERS.includes(row.tier) ? (row.tier as BadgeWireTier) : null;
  const earnedAt = typeof row.earnedAt === "string" && Number.isFinite(Date.parse(row.earnedAt)) ? row.earnedAt : null;
  return id && tier !== null && earnedAt ? { id, tier, earnedAt } : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function progressRow(value: unknown): BadgeProgressWire | null {
  const row = record(value);
  if (!row) return null;
  const id = badgeId(row.id);
  const current = count(row.current);
  const target = count(row.target);
  if (!id || current === null || target === null || target <= 0) return null;
  return { id, current, target, unit: typeof row.unit === "string" ? row.unit.trim() : "" };
}

/** One row per id: the first wins. */
function unique<T extends { id: string }>(rows: readonly (T | null)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** Parse a `GET /v1/badges/{uid}` body. Never throws; a malformed body is {@link NO_BADGES}. */
export function parseBadgesPayload(raw: unknown): BadgesPayload {
  const body = record(raw);
  if (!body || body.enabled !== true) return { ...NO_BADGES, badges: [], progress: [] };
  const subject = record(body.subject);
  const subjectUid = typeof subject?.uid === "string" && subject.uid.trim() ? subject.uid.trim() : null;
  return {
    enabled: true,
    subject: subjectUid && subject?.kind === "person" ? { uid: subjectUid, kind: "person" } : null,
    consent: body.consent === "granted" || body.consent === "not-granted" ? body.consent : null,
    badges: unique((Array.isArray(body.badges) ? body.badges : []).map(badge)),
    progress: unique((Array.isArray(body.progress) ? body.progress : []).map(progressRow)),
  };
}
