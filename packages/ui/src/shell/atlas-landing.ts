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
import type { NavigationDestination } from "./navigation-history.js";

/**
 * Vault access the Atlas graph builder needs in the native app (QA-016). The
 * shell supplies it from the platform adapter; it lives here, outside atlas/,
 * so the shell can name the type without importing the Atlas chunk.
 */
export interface AtlasVaultSource {
  /** Raw hq-pro `/v1/files/list` body for one page; the builder parses it. */
  listPage(companyUid: string, prefix: string, cursor?: string): Promise<unknown>;
  /** Object text, or null when the object has no readable body. */
  readText(companyUid: string, key: string): Promise<string | null>;
}

/**
 * The company folder synced to this machine, read by the native app (QA-016).
 * Each call resolves null when the folder is not on this machine; Atlas then
 * falls back to the vault listing.
 */
export interface AtlasLocalSource {
  /** District roots and direct children: `{ revision, complete, objects }`. */
  firstPage(companySlug: string): Promise<unknown>;
  /** Every object under the districts, same shape, cached by revision. */
  listing(companySlug: string): Promise<unknown>;
  /** Text of one object under the districts (project PRDs). */
  readText(companySlug: string, key: string): Promise<string | null>;
}

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

/**
 * One live actor on the Atlas map (US-013), one row per project they have an
 * open Work Mesh session on. Actors with no project-bound session appear once
 * with no `projectId`; they stay in Working now but dock nowhere.
 */
export interface AtlasLiveActor {
  actorUid: string;
  name: string;
  bot: boolean;
  projectId?: string;
  signal?: string;
}

type LiveReadLike = {
  participants: readonly {
    actorUid: string;
    actorType: string;
    displayName: string;
    presence: string;
    sessions: readonly { projectId?: string; taskId?: string; status: string }[];
  }[];
};

/**
 * Live actors for a company from the LiveReadStore projection, gated by the
 * PresenceStore: an actor the presence snapshot knows about must be online
 * there; otherwise the live read's own presence decides. Ended sessions never
 * dock. Pure; the shell feeds it from the two existing store mirrors.
 */
export function atlasLiveActors(
  live: LiveReadLike | null | undefined,
  snapshot: PresenceSnapshot,
  companyUid: string,
  names: RosterNames,
  selfUid: string | null = null,
): AtlasLiveActor[] {
  if (!live) return [];
  const actors = snapshot.get(companyUid);
  const out: AtlasLiveActor[] = [];
  for (const p of live.participants) {
    const known = actors?.get(p.actorUid);
    const online = known ? known.status === "online" : p.presence === "online";
    if (!online) continue;
    const name =
      names.get(p.actorUid) ||
      p.displayName?.trim() ||
      (p.actorUid === selfUid ? "You" : p.actorUid);
    const bot = (known?.actorType ?? p.actorType) === "agent";
    const projects = new Map<string, string | undefined>();
    for (const s of p.sessions) {
      const project = s.projectId?.trim().toLowerCase();
      if (!project || s.status === "ended" || projects.has(project)) continue;
      projects.set(project, s.taskId?.trim() || undefined);
    }
    if (!projects.size) {
      out.push({ actorUid: p.actorUid, name, bot });
      continue;
    }
    for (const [projectId, taskId] of projects) {
      out.push({ actorUid: p.actorUid, name, bot, projectId, signal: taskId });
    }
  }
  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.actorUid.localeCompare(b.actorUid) ||
      (a.projectId ?? "").localeCompare(b.projectId ?? ""),
  );
}

/** The node fields an Atlas inspector action needs (path is company-relative). */
export interface AtlasActionNode {
  type: string;
  path: string;
  folder: boolean;
}

/**
 * Where the Atlas inspector's Open files / Open board buttons go (QA-066).
 * A project opens on the Projects page, on its Files or Tasks tab, the same
 * place Projects > project > Files reaches. Any other file opens in the Files
 * explorer; a folder opens the company vault. Null when there is no company.
 */
export function atlasNodeDestination(
  node: AtlasActionNode,
  companySlug: string | null | undefined,
  action: "files" | "board",
): NavigationDestination | null {
  const slug = companySlug?.trim();
  if (!slug) return null;
  const path = node.path.replace(/^\/+|\/+$/g, "");
  const project = node.type === "project" ? /^projects\/([^/]+)/.exec(path)?.[1] : undefined;
  if (project) {
    return { kind: "projects", company: slug, project, tab: action === "files" ? "files" : "tasks" };
  }
  if (action === "board") return { kind: "projects", company: slug };
  const vault = `company:${slug}`;
  if (node.folder || !path) return { kind: "explorer", vault, path: null };
  return { kind: "explorer", vault, path: `companies/${slug}/${path}` };
}
