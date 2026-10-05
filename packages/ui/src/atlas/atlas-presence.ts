/**
 * Live presence on the Atlas map (US-013): which objects carry a halo, which
 * actor chips dock beside them, and which objects a people filter keeps.
 *
 * Inputs come from the shell's PresenceStore and LiveReadStore mirrors, so
 * nothing here polls or fetches. Pure functions only.
 */

import type { AtlasNode, AtlasPresence } from "./atlas-model.js";
import type { AtlasPlaced } from "./atlas-layout.js";

/** Shape of the shell's `AtlasLiveActor` (kept structural to avoid a shell import). */
export type AtlasLiveActorInput = {
  actorUid: string;
  name: string;
  bot: boolean;
  projectId?: string;
  /** Other hints from the live session about where the work is, when sent. */
  repo?: string;
  cwd?: string;
  workerId?: string;
  taskId?: string;
  signal?: string;
  /** Online with no session in progress. */
  idle?: boolean;
};

/**
 * One form for every place name, on both sides of a match: lower-case,
 * trimmed, no trailing slash, the last path segment only (a cwd or a node
 * path), and `_` read as `-`.
 */
export function atlasMatchKey(raw: string | null | undefined): string {
  const path = (raw ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = path.split("/").pop() ?? "";
  return leaf.trim().toLowerCase().replace(/_/g, "-");
}

/** Node types an actor can stand on, in the order they are tried. */
const PLACE_TYPES = ["project", "repo", "worker"] as const;

/** Project slug for a project node: last path segment, lower-cased. */
export function atlasProjectSlug(node: Pick<AtlasNode, "type" | "path">): string | null {
  if (node.type !== "project") return null;
  const leaf = node.path.replace(/\/+$/, "").split("/").pop();
  return leaf ? leaf.toLowerCase() : null;
}

/** The place an actor's session names, in words, when it names one. */
function atlasActorWhere(a: AtlasLiveActorInput): string | undefined {
  for (const raw of [a.projectId, a.repo, a.cwd, a.workerId]) {
    const leaf = raw?.trim().replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()?.trim();
    if (leaf) return leaf;
  }
  return undefined;
}

/** Plain words for why an actor has no place on the map. */
export function atlasUnplacedReason(a: AtlasLiveActorInput): string {
  const where = atlasActorWhere(a);
  if (where) return `Working in ${where}, which is not on this map`;
  return a.idle ? "Online, no session in progress" : "In a session with no project";
}

/**
 * Map live actors onto graph nodes of the graph being shown (never another
 * company's). Each session hint is tried in turn: project id, repo, cwd,
 * worker id, then task id; each against project folders, then repos, then
 * workers. An actor that matches nothing keeps a `person:` id and an
 * `unplaced` reason so the map's Not on the map dock shows them; that row is
 * dropped when the same actor is already placed elsewhere.
 */
export function atlasPresenceFromActors(
  actors: readonly AtlasLiveActorInput[],
  nodes: readonly AtlasNode[],
): AtlasPresence[] {
  const index = new Map<string, Map<string, string>>(PLACE_TYPES.map((t) => [t, new Map()]));
  for (const n of nodes) {
    const byKey = index.get(n.type);
    const key = byKey ? atlasMatchKey(n.path) : "";
    if (byKey && key && !byKey.has(key)) byKey.set(key, n.id);
  }
  const place = (a: AtlasLiveActorInput): string | undefined => {
    for (const raw of [a.projectId, a.repo, a.cwd, a.workerId, a.taskId]) {
      const key = atlasMatchKey(raw);
      if (!key) continue;
      for (const type of PLACE_TYPES) {
        const hit = index.get(type)!.get(key);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const rows: AtlasPresence[] = [];
  const seen = new Set<string>();
  const placedActors = new Set<string>();
  for (const a of actors) {
    const hit = place(a);
    const nodeId = hit ?? `person:${a.actorUid}`;
    const key = `${a.actorUid}>${nodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hit) placedActors.add(a.actorUid);
    rows.push({
      nodeId,
      actorUid: a.actorUid,
      name: a.name,
      bot: a.bot,
      signal: a.signal,
      ...(a.idle ? { idle: true } : {}),
      ...(hit ? {} : { unplaced: atlasUnplacedReason(a) }),
    });
  }
  return rows.filter((p) => !p.unplaced || !placedActors.has(p.actorUid!));
}

/**
 * Live actors with no object on the map, once each: people first, then
 * bots, by name. The map's Not on the map dock lists them.
 */
export function atlasUnplacedActors(presence: readonly AtlasPresence[]): AtlasPresence[] {
  return atlasDistinctActors(presence.filter((p) => p.unplaced)).sort(
    (a, b) => Number(a.bot) - Number(b.bot) || a.name.localeCompare(b.name),
  );
}

/** Dock chips shown before the +N chip that expands the rest in place. */
export const ATLAS_DOCK_CAP = 12;

/** Distinct live actors (one per uid) for counts and Working now. */
export function atlasDistinctActors(presence: readonly AtlasPresence[]): AtlasPresence[] {
  const seen = new Set<string>();
  const out: AtlasPresence[] = [];
  for (const p of presence) {
    const key = p.actorUid ?? p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Node ids a people filter keeps: the objects that actor is live on. */
export function atlasActorNodeIds(
  presence: readonly AtlasPresence[],
  actorUid: string | null,
): Set<string> | null {
  if (!actorUid) return null;
  return new Set(presence.filter((p) => p.actorUid === actorUid).map((p) => p.nodeId));
}

export type AtlasDockedChip = {
  key: string;
  nodeId: string;
  actorUid?: string;
  name: string;
  bot: boolean;
  initials: string;
  /** Position in this node's stack, 0 first. */
  index: number;
  /** What the actor is doing, when the live read says. */
  signal?: string;
  /** Online with no session in progress: drawn quieter, without the pulse. */
  idle?: boolean;
  /** Chip centre and the connector start on the node rim (world units). */
  x: number;
  y: number;
  x1: number;
  y1: number;
};

export const ATLAS_CHIP_SIZE = 16;
const CHIP_GAP = 20;

export function atlasInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

/**
 * Docked chips: stacked up and to the right of each live node, joined to the
 * rim by a short connector. Layout is world-space so pan and zoom move chips
 * with the single map transform.
 */
export function atlasDockedChips(
  placed: readonly AtlasPlaced[],
  presence: readonly AtlasPresence[],
): AtlasDockedChip[] {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const perNode = new Map<string, number>();
  const out: AtlasDockedChip[] = [];
  for (const who of presence) {
    const node = byId.get(who.nodeId);
    if (!node) continue;
    const i = perNode.get(node.id) ?? 0;
    perNode.set(node.id, i + 1);
    const angle = -Math.PI / 4;
    const x1 = node.x + Math.cos(angle) * node.r;
    const y1 = node.y + Math.sin(angle) * node.r;
    out.push({
      key: `${who.actorUid ?? who.name}>${node.id}`,
      nodeId: node.id,
      actorUid: who.actorUid,
      name: who.name,
      bot: who.bot,
      initials: who.bot ? "⌁" : atlasInitials(who.name),
      index: i,
      signal: who.signal,
      ...(who.idle ? { idle: true } : {}),
      x: x1 + 18 + i * CHIP_GAP,
      y: y1 - 18,
      x1,
      y1,
    });
  }
  return out;
}
