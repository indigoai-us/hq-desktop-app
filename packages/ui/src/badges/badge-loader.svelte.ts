/**
 * hq-accomplishment-badges US-005: real badges from hq-pro.
 *
 * Profile panes, the side nav and avatar tier marks ask for badges
 * synchronously (`badgesFor`), so this keeps a per-person cache and fills it
 * in the background: one `GET /v1/badges/{uid}` per person per session, read
 * again after {@link BADGE_REFRESH_MS}. The cache is `$state`, so whatever
 * read it redraws when the answer lands.
 *
 * Badges are an enhancement, never a gate. A failure of any kind (offline,
 * the 404 for agents and non-teammates, the route not deployed yet, the
 * server flag off) caches "no badges" until the next refresh and shows
 * nothing to the person.
 *
 * Lookups are by person uid only. A subject without a `prs_*` uid, and every
 * bot, has no badges here; names are never used to find someone.
 */
import type { BadgesPayload, IdentityApi } from "@hq/platform";
import { BADGE_BY_ID, type BadgeTier, type EarnedBadge } from "./badge-catalog.js";
import {
  hasBadgeSource,
  setBadgeProgressSource,
  setBadgeSource,
  type BadgeProgress,
  type BadgeSubject,
} from "./badge-source.js";

/** How long one person's badges stay fresh before they are read again. */
export const BADGE_REFRESH_MS = 10 * 60 * 1000;

export type BadgeApi = Pick<IdentityApi, "getBadges">;

interface Entry {
  badges: readonly EarnedBadge[];
  progress: readonly BadgeProgress[];
  /** When the read finished, for the refresh. */
  at: number;
}

const EMPTY: Omit<Entry, "at"> = { badges: [], progress: [] };

const cache = $state<Record<string, Entry>>({});
const inflight = new Set<string>();
let api: BadgeApi | null = null;
let now: () => number = () => Date.now();

const PERSON_UID = /^prs_[A-Za-z0-9_-]+$/;

/** The uid to look a subject up by, or null when there is none to use. */
export function badgeUid(subject: BadgeSubject): string | null {
  if (subject.kind !== "person") return null;
  const uid = subject.uid?.trim() ?? "";
  return PERSON_UID.test(uid) ? uid : null;
}

function singleLevel(id: string): boolean {
  return (BADGE_BY_ID[id]?.levels.split(" · ").length ?? 0) < 3;
}

/**
 * The earned badges the app can draw. Unknown ids are dropped. A single-level
 * badge (Founding Member, Founder) shows at its own tier whatever the server
 * says; the others need tier 1, 2 or 3 (Bronze, Silver, Gold).
 */
export function earnedFromPayload(payload: BadgesPayload): EarnedBadge[] {
  if (!payload.enabled) return [];
  const out: EarnedBadge[] = [];
  for (const row of payload.badges) {
    const def = BADGE_BY_ID[row.id];
    if (!def) continue;
    let tier: BadgeTier;
    if (singleLevel(row.id)) tier = def.tier;
    else if (row.tier === 1 || row.tier === 2 || row.tier === 3) tier = row.tier;
    else continue;
    out.push({ id: row.id, tier, earnedAt: row.earnedAt });
  }
  return out;
}

/** Progress toward badges the app knows and the person has not earned. */
export function progressFromPayload(payload: BadgesPayload, earned: readonly EarnedBadge[]): BadgeProgress[] {
  if (!payload.enabled) return [];
  const have = new Set(earned.map((b) => b.id));
  return payload.progress
    .filter((p) => BADGE_BY_ID[p.id] && !have.has(p.id))
    .map((p) => ({ id: p.id, current: p.current, target: p.target, unit: p.unit }));
}

function load(uid: string, from: BadgeApi): void {
  if (inflight.has(uid) || !from.getBadges) return;
  inflight.add(uid);
  const settle = (entry: Omit<Entry, "at">) => {
    // A sign-out or a new loader while this was in flight: keep nothing.
    if (api !== from) return;
    cache[uid] = { ...entry, at: now() };
  };
  // Called while a view reads the cache, so the request (and any write) waits
  // a microtask: a read never writes state synchronously.
  void Promise.resolve()
    .then(() => from.getBadges!(uid))
    .then((res) => {
      if (!res.ok) {
        console.debug("[badges] no badges for", uid, res.code ?? res.reason);
        settle(EMPTY);
        return;
      }
      const badges = earnedFromPayload(res.value);
      settle({ badges, progress: progressFromPayload(res.value, badges) });
    })
    .catch(() => settle(EMPTY))
    .finally(() => inflight.delete(uid));
}

function entryFor(subject: BadgeSubject): Entry | null {
  const uid = badgeUid(subject);
  if (!uid || !api) return null;
  const entry = cache[uid];
  if (!entry || now() - entry.at >= BADGE_REFRESH_MS) load(uid, api);
  return entry ?? null;
}

/** A person's earned badges, or none while they load. Starts the read. */
export function loadedBadgesFor(subject: BadgeSubject): readonly EarnedBadge[] {
  return entryFor(subject)?.badges ?? [];
}

/** A person's progress toward badges not yet earned, or none while they load. */
export function loadedBadgeProgressFor(subject: BadgeSubject): readonly BadgeProgress[] {
  return entryFor(subject)?.progress ?? [];
}

/**
 * Make hq-pro the badge source, for an adapter that can read badges. Leaves
 * an installed source alone (the design harness's samples). Returns the
 * uninstall, which also drops the cache.
 */
export function installBadgeLoader(next: BadgeApi | null | undefined): () => void {
  if (!next?.getBadges || hasBadgeSource()) return () => {};
  resetBadgeLoader();
  api = next;
  setBadgeSource(loadedBadgesFor);
  setBadgeProgressSource(loadedBadgeProgressFor);
  return () => {
    if (api !== next) return;
    setBadgeSource(null);
    setBadgeProgressSource(null);
    resetBadgeLoader();
  };
}

/** Drop the cache and the loader. Tests and uninstall only. */
export function resetBadgeLoader(): void {
  api = null;
  for (const key of Object.keys(cache)) delete cache[key];
  inflight.clear();
}

/** Tests only: the clock the refresh reads. */
export function setBadgeLoaderClock(next: (() => number) | null): void {
  now = next ?? (() => Date.now());
}
