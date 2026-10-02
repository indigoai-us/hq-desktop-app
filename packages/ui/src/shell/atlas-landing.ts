/**
 * Atlas landing data (console-rail US-009).
 *
 * Atlas is the company landing page. Until the map lands (US-012) the page
 * shows the inspector's nothing-selected state, the company roll-up that used
 * to live on Overview: live count, projects in progress, and Working now. The
 * sidepane adds the Live now and Idle rosters.
 *
 * Everything derives from stores the shell already holds (presence snapshot,
 * conversation rows, cached company summary), so the page paints from cache in
 * the first frame and adds no poller. Pure data only; nothing on the boot path.
 */

import type { PresenceSnapshot } from "@hq/core";
import type { SidepaneRosterEntry } from "./sidepane-models.js";

/** Display name for a person or bot uid, from rows the shell already loaded. */
export type RosterNames = ReadonlyMap<string, string>;

/** Names keyed by person uid from DM rows; first non-empty title wins. */
export function rosterNamesFromRows(
  rows: readonly { personUid?: string; title: string }[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const uid = row.personUid?.trim();
    const title = row.title?.trim();
    if (uid && title && !names.has(uid)) names.set(uid, title);
  }
  return names;
}

/**
 * Company roster from the presence snapshot: online actors are live, the rest
 * idle. Sorted by name so rows do not jump when presence ticks.
 */
export function atlasRoster(
  snapshot: PresenceSnapshot,
  companyUid: string,
  names: RosterNames,
  selfUid: string | null = null,
): SidepaneRosterEntry[] {
  const actors = snapshot.get(companyUid);
  if (!actors) return [];
  const out: SidepaneRosterEntry[] = [];
  for (const [uid, entry] of actors) {
    const name = names.get(uid) ?? (uid === selfUid ? "You" : uid);
    out.push({
      uid,
      name,
      kind: entry.actorType === "agent" ? "bot" : "human",
      live: entry.status === "online",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
}

/** Working-now entries for the inspector's nothing-selected state. */
export interface AtlasWorkingNow {
  nodeId: string;
  name: string;
  bot: boolean;
}

export function atlasWorkingNow(roster: readonly SidepaneRosterEntry[]): AtlasWorkingNow[] {
  return roster
    .filter((p) => p.live)
    .map((p) => ({ nodeId: `person:${p.uid}`, name: p.name, bot: p.kind === "bot" }));
}
