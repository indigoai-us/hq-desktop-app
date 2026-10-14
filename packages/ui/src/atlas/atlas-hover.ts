/**
 * Atlas hover card content (owner, 2026-10-05: "can these hover cards have
 * more details?"). Built from data the map already holds: the node, its ref
 * edges (the same ones focus mode uses) and live presence. A row appears only
 * when its data exists; nothing is fetched on hover.
 *
 * Not drawn, because the graph has no source for them yet: a status word, a
 * one-line description, contributors beyond who is live now, the story in
 * progress, and per-day activity for a sparkline.
 */

import {
  districtLabel,
  fmtCompactDate,
  type AtlasDistrictType,
  type AtlasNode,
  type AtlasPresence,
  type AtlasRefEdge,
} from "./atlas-model.js";
import { atlasRelatedIds } from "./atlas-layout.js";
import { atlasAgo } from "./atlas-today.js";

/** Avatars in the People row before "+N". */
export const ATLAS_HOVER_PEOPLE = 5;
/** Names in a linked-items row before "+N". */
export const ATLAS_HOVER_NAMES = 3;
const DAY_MS = 86_400_000;

export type AtlasHoverPerson = { key: string; name: string; bot: boolean; avatarUrl?: string; signal?: string };

export type AtlasHoverContent = {
  kind: string;
  title: string;
  /** Who is on it now (live presence only; the graph has no contributor list). */
  people?: { label: string; shown: AtlasHoverPerson[]; more: number };
  /** Story progress from the node's own counts. */
  stories?: { done: number; total: number; fraction: number; text: string };
  /** Named linked items, one row each: "Repos  hq-pro, hq-console +2". */
  links: { label: string; text: string }[];
  /** Other linked kinds, counted: "5 knowledge docs · 1 policy". */
  counts?: string;
  /** Folder the object sits in, for files. */
  folder?: string;
  activity?: string;
  hint?: string;
};

const LINK_LABEL: Partial<Record<AtlasDistrictType, string>> = {
  project: "Projects",
  repo: "Repos",
};

const KIND_ONE: Record<AtlasDistrictType, string> = {
  project: "Project",
  knowledge: "Knowledge",
  policy: "Policy",
  repo: "Repo",
  worker: "Worker",
  skill: "Skill",
};

const COUNT_LABEL: Record<AtlasDistrictType, [string, string]> = {
  project: ["project", "projects"],
  knowledge: ["knowledge doc", "knowledge docs"],
  policy: ["policy", "policies"],
  repo: ["repo", "repos"],
  worker: ["worker", "workers"],
  skill: ["skill", "skills"],
};

/** "a, b, c +2": up to `cap` names, then how many more. */
export function atlasNamesLine(names: readonly string[], cap = ATLAS_HOVER_NAMES): string {
  const shown = names.slice(0, cap).join(", ");
  return names.length > cap ? `${shown} +${names.length - cap}` : shown;
}

/** Born / touched, with relative time for the last day, and the folder size. */
export function atlasHoverActivity(
  n: Pick<AtlasNode, "created" | "touched" | "count" | "folder">,
  nowMs: number,
): string {
  const when = (ms: number | undefined): string | null =>
    ms === undefined ? null : nowMs - ms < DAY_MS && ms <= nowMs ? atlasAgo(ms, nowMs) : fmtCompactDate(ms, nowMs);
  const parts: string[] = [];
  const born = when(n.created);
  const touched = when(n.touched);
  if (born) parts.push(`Born ${born}`);
  if (touched) parts.push(`Touched ${touched}`);
  if (n.folder) parts.push(`${n.count} inside`);
  return parts.join(" · ");
}

function folderOf(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut > 0 ? `${trimmed.slice(0, cut)}/` : undefined;
}

/**
 * Card content for a hovered object. Pure; the map calls it once per hovered
 * id, not per pointer move.
 */
export function atlasHoverContent(
  node: AtlasNode,
  ctx: {
    byId: ReadonlyMap<string, AtlasNode>;
    edges: readonly AtlasRefEdge[];
    presence: readonly AtlasPresence[];
    nowMs: number;
  },
): AtlasHoverContent {
  const relatedNodes = [...atlasRelatedIds(node.id, [...ctx.edges])]
    .map((id) => ctx.byId.get(id))
    .filter((n): n is AtlasNode => n !== undefined)
    .sort((a, b) => (b.touched ?? 0) - (a.touched ?? 0) || a.label.localeCompare(b.label));
  const byType = new Map<AtlasDistrictType, AtlasNode[]>();
  for (const n of relatedNodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);

  // Named rows: a project names its repos; everything else names the
  // projects that link to it. Other kinds are counted.
  const named: AtlasDistrictType[] = node.type === "project" ? ["repo"] : ["project"];
  const links = named
    .filter((t) => byType.get(t)?.length)
    .map((t) => ({ label: LINK_LABEL[t] ?? districtLabel(t), text: atlasNamesLine(byType.get(t)!.map((n) => n.label)) }));
  const counted = [...byType].filter(([t]) => !named.includes(t) && t !== node.type);
  const counts = counted
    .map(([t, list]) => `${list.length} ${list.length === 1 ? COUNT_LABEL[t][0] : COUNT_LABEL[t][1]}`)
    .join(" · ");

  const seen = new Set<string>();
  const live: AtlasHoverPerson[] = [];
  for (const p of ctx.presence) {
    if (p.nodeId !== node.id) continue;
    const key = p.actorUid ?? p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    live.push({ key, name: p.name, bot: p.bot, avatarUrl: p.avatarUrl, signal: p.signal });
  }

  const stories =
    node.stories && node.stories.total > 0
      ? {
          done: node.stories.done,
          total: node.stories.total,
          fraction: Math.max(0, Math.min(1, node.stories.done / node.stories.total)),
          text: `${node.stories.done} of ${node.stories.total} ${node.stories.total === 1 ? "story" : "stories"} done`,
        }
      : undefined;
  const activity = atlasHoverActivity(node, ctx.nowMs);
  const folder = node.type === "knowledge" || node.type === "policy" ? folderOf(node.path) : undefined;

  return {
    kind: KIND_ONE[node.type],
    title: node.label,
    ...(live.length
      ? { people: { label: "On it now", shown: live.slice(0, ATLAS_HOVER_PEOPLE), more: Math.max(0, live.length - ATLAS_HOVER_PEOPLE) } }
      : {}),
    ...(stories ? { stories } : {}),
    links,
    ...(counts ? { counts } : {}),
    ...(folder ? { folder } : {}),
    ...(activity ? { activity } : {}),
    hint: "Click to focus",
  };
}
