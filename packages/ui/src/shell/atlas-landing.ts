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
 * One live actor on the Atlas map (US-013), one row per place they have an
 * open Work Mesh session on. A place is the session's project id, or, when
 * there is none, any repo, working directory or worker the session names.
 * Actors with no such session appear once with no place; the map lists them
 * in its Not on the map dock.
 */
export interface AtlasLiveActor {
  actorUid: string;
  name: string;
  bot: boolean;
  projectId?: string;
  repo?: string;
  cwd?: string;
  workerId?: string;
  taskId?: string;
  signal?: string;
  /** Online, but none of their sessions is in progress. */
  idle?: boolean;
}

/** Session states that mean work is in progress right now. */
const WORKING_STATUSES = new Set(["active", "open", "running"]);

type LiveReadLike = {
  participants: readonly {
    actorUid: string;
    actorType: string;
    displayName: string;
    presence: string;
    sessions: readonly {
      projectId?: string;
      taskId?: string;
      repo?: string;
      cwd?: string;
      workerId?: string;
      status: string;
    }[];
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
    const idle = !p.sessions.some((s) => WORKING_STATUSES.has(s.status));
    const flag = idle ? { idle: true } : {};
    // One row per place. A session with no project still says where it is
    // when it names a repo, a working directory, a worker or a task.
    const places = new Map<string, Omit<AtlasLiveActor, "actorUid" | "name" | "bot" | "idle">>();
    for (const s of p.sessions) {
      if (s.status === "ended") continue;
      const projectId = s.projectId?.trim().toLowerCase() || undefined;
      const taskId = s.taskId?.trim() || undefined;
      const hints = projectId
        ? { projectId }
        : {
            ...(s.repo?.trim() ? { repo: s.repo.trim() } : {}),
            ...(s.cwd?.trim() ? { cwd: s.cwd.trim() } : {}),
            ...(s.workerId?.trim() ? { workerId: s.workerId.trim() } : {}),
            ...(taskId ? { taskId } : {}),
          };
      const key = projectId ? `project:${projectId}` : Object.values(hints).join("|");
      if (!Object.keys(hints).length || places.has(key)) continue;
      places.set(key, { ...hints, signal: taskId });
    }
    if (!places.size) {
      out.push({ actorUid: p.actorUid, name, bot, ...flag });
      continue;
    }
    for (const place of places.values()) {
      out.push({ actorUid: p.actorUid, name, bot, ...place, ...flag });
    }
  }
  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.actorUid.localeCompare(b.actorUid) ||
      (a.projectId ?? a.repo ?? a.cwd ?? a.workerId ?? a.taskId ?? "").localeCompare(
        b.projectId ?? b.repo ?? b.cwd ?? b.workerId ?? b.taskId ?? "",
      ),
  );
}

/** The node fields an Atlas inspector action needs (path is company-relative). */
export interface AtlasActionNode {
  type: string;
  path: string;
  folder: boolean;
  /** For a folder: the file inside it to open (company-relative). */
  file?: string;
}

/**
 * Where the Atlas inspector's Open files / Open board buttons go (QA-066).
 * Open files shows a file, not a tree (owner, 2026-10-04): a file opens in
 * the Files explorer, and a folder opens on its main file (README, PRD, SKILL
 * and so on) there. A project with no such file falls back to the Projects
 * page Files tab, and any other folder to the company vault. Open board goes
 * to the project's Tasks tab. Null when there is no company.
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
  const vault = `company:${slug}`;
  const file = node.file?.replace(/^\/+/, "");
  if (action === "files" && node.folder && file) {
    return { kind: "explorer", vault, path: `companies/${slug}/${file}` };
  }
  if (project) {
    return { kind: "projects", company: slug, project, tab: action === "files" ? "files" : "tasks" };
  }
  if (action === "board") return { kind: "projects", company: slug };
  if (node.folder || !path) return { kind: "explorer", vault, path: null };
  return { kind: "explorer", vault, path: `companies/${slug}/${path}` };
}
