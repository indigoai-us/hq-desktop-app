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
  signal?: string;
};

/** Project slug for a project node: last path segment, lower-cased. */
export function atlasProjectSlug(node: Pick<AtlasNode, "type" | "path">): string | null {
  if (node.type !== "project") return null;
  const leaf = node.path.replace(/\/+$/, "").split("/").pop();
  return leaf ? leaf.toLowerCase() : null;
}

/**
 * Map live actors onto graph nodes. An actor on a project that is on the map
 * gets that project's node id; anyone else keeps a `person:` id so the
 * inspector's Working now list still shows them.
 */
export function atlasPresenceFromActors(
  actors: readonly AtlasLiveActorInput[],
  nodes: readonly AtlasNode[],
): AtlasPresence[] {
  const bySlug = new Map<string, string>();
  for (const n of nodes) {
    const slug = atlasProjectSlug(n);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, n.id);
  }
  const out: AtlasPresence[] = [];
  const seen = new Set<string>();
  for (const a of actors) {
    const nodeId = (a.projectId && bySlug.get(a.projectId.toLowerCase())) || `person:${a.actorUid}`;
    const key = `${a.actorUid}>${nodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodeId, actorUid: a.actorUid, name: a.name, bot: a.bot, signal: a.signal });
  }
  return out;
}

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
      x: x1 + 18 + i * CHIP_GAP,
      y: y1 - 18,
      x1,
      y1,
    });
  }
  return out;
}
