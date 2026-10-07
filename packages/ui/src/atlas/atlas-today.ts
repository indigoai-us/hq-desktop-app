/**
 * Today panel (inspector idle state): what changed today, from real data.
 * An object counts when its last-modified time falls on today (UTC, the same
 * day boundary as the timeline). Changes are grouped under their parent
 * object (project, knowledge folder, repo...) so a /brainstorm run's five
 * files read as one project's output, not five bare file names. The graph has
 * no per-story timestamps, so stories finished today cannot be listed. Pure
 * functions.
 */

import { ATLAS_DISTRICTS, districtLabel, type AtlasDistrictType, type AtlasNode } from "./atlas-model.js";
import { atlasDayStart } from "./atlas-timeline.js";
import { portfolioColumn, type PortfolioColumn } from "../projects/projects-model.js";

/** Groups shown before "Show N more groups", and added per click after. */
export const ATLAS_TODAY_GROUPS = 4;
/** Rows shown inside a group before its own "N more". */
export const ATLAS_TODAY_ROWS = 3;

/** What a changed object is, for its row icon. */
export type AtlasTodayKind =
  | "prd"
  | "brainstorm"
  | "policy"
  | "knowledge"
  | "meeting"
  | "source"
  | "project"
  | "repo"
  | "worker"
  | "skill";

export type AtlasTodayRow = {
  node: AtlasNode;
  kind: AtlasTodayKind;
  /** Frontmatter title when the graph carries one, else the sentence-cased stem. */
  title: string;
  /** Folder the object lives in, vault-relative, e.g. `projects/launch-landing/`. */
  parentPath: string;
};

export type AtlasTodayStories = { done: number; total: number; fraction: number; text: string };

export type AtlasTodayGroup = {
  key: string;
  kind: AtlasDistrictType;
  title: string;
  path: string;
  /** The parent on the map; null for a district catch-all or a folder the map does not show. */
  node: AtlasNode | null;
  /** Projects with a PRD: story progress and the Projects board column. */
  stories: AtlasTodayStories | null;
  column: PortfolioColumn | null;
  /** True when the parent object itself changed today. */
  changed: boolean;
  touched: number;
  rows: AtlasTodayRow[];
};

/** Objects changed today: projects first, then most recent, then by name. */
export function atlasTodayChanges(nodes: readonly AtlasNode[], nowMs: number): AtlasNode[] {
  const start = atlasDayStart(nowMs);
  return nodes
    .filter((n) => n.touched != null && n.touched >= start && n.touched <= nowMs)
    .sort(
      (a, b) =>
        Number(b.type === "project") - Number(a.type === "project") ||
        (b.touched ?? 0) - (a.touched ?? 0) ||
        a.label.localeCompare(b.label),
    );
}

/** "just now", "12 min ago", "3 h ago". */
export function atlasAgo(ms: number, nowMs: number): string {
  const min = Math.floor(Math.max(0, nowMs - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

const UPPER_WORDS = new Set([
  "hq", "prd", "api", "ui", "ux", "ai", "gtm", "mvp", "seo", "faq", "sop", "url", "cli", "llm", "kpi", "okr", "roi", "qa", "readme",
]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|svelte|css|html|swift|kt|java|rb|sh|sql|toml)$/i;

function leaf(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}

function dirOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? "" : trimmed.slice(0, cut + 1);
}

/** `market-landscape.md` → "Market landscape"; `hq-landscape` → "HQ landscape". */
export function atlasHumanTitle(stemOrPath: string): string {
  const base = leaf(stemOrPath).replace(/\.[a-z0-9]{1,5}$/i, "");
  const words = base.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return stemOrPath;
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (UPPER_WORDS.has(lower)) return lower.toUpperCase();
      if (/[A-Z]/.test(w.slice(1))) return w; // authored casing such as "iOS"
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** The icon kind for one changed object. */
export function atlasTodayKind(node: Pick<AtlasNode, "type" | "path" | "folder">): AtlasTodayKind {
  const name = leaf(node.path).toLowerCase();
  if (node.folder) return node.type;
  if (name === "prd.json" || /(^|[-_])prd\.(md|json)$/.test(name)) return "prd";
  if (node.type === "policy") return "policy";
  if (/(^|\/)(meetings?|meeting-notes|transcripts?)\//i.test(node.path) || name.includes("meeting")) return "meeting";
  if (name.startsWith("brainstorm")) return "brainstorm";
  if (CODE_EXT.test(name)) return "source";
  return node.type === "project" ? "knowledge" : node.type;
}

function storiesOf(node: AtlasNode | null): Pick<AtlasTodayGroup, "stories" | "column"> {
  if (!node || node.type !== "project" || !node.stories?.total) return { stories: null, column: null };
  const total = node.stories.total;
  const done = Math.min(Math.max(0, node.stories.done), total);
  return {
    stories: { done, total, fraction: done / total, text: `${done} of ${total} ${total === 1 ? "story" : "stories"}` },
    column: portfolioColumn({ status: "", storiesComplete: done, storiesTotal: total }, false),
  };
}

function titleOf(node: AtlasNode): string {
  return node.title?.trim() || atlasHumanTitle(leaf(node.path) || node.label);
}

function rowOf(node: AtlasNode): AtlasTodayRow {
  return { node, kind: atlasTodayKind(node), title: titleOf(node), parentPath: dirOf(node.path) };
}

/**
 * Group today's changes under their parent: the node's parentId, else the
 * deepest folder on the map that contains it, else its own folder (a project
 * folder the map does not show still groups its files), else its district.
 * A changed top-level folder is its own group header. Projects first, then
 * the most recent change, then by title.
 */
export function atlasTodayGroups(changes: readonly AtlasNode[], nodes: readonly AtlasNode[]): AtlasTodayGroup[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const folders = nodes.filter((n) => n.folder && n.path).sort((a, b) => b.path.length - a.path.length);
  const groups = new Map<string, AtlasTodayGroup>();

  const groupFor = (key: string, init: () => Omit<AtlasTodayGroup, "key" | "rows" | "touched" | "changed">) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, ...init(), rows: [], touched: 0, changed: false };
      groups.set(key, g);
    }
    return g;
  };
  const nodeGroup = (parent: AtlasNode) =>
    groupFor(parent.id, () => ({ kind: parent.type, title: titleOf(parent), path: parent.path, node: parent, ...storiesOf(parent) }));
  const parentOf = (n: AtlasNode): AtlasNode | null => {
    const byParentId = n.parentId ? byId.get(n.parentId) : undefined;
    if (byParentId) return byParentId;
    return folders.find((f) => f.id !== n.id && n.path !== f.path && n.path.startsWith(f.path)) ?? null;
  };

  for (const n of changes) {
    const parent = parentOf(n);
    if (!parent && n.folder) {
      const own = nodeGroup(n);
      own.changed = true;
      own.touched = Math.max(own.touched, n.touched ?? 0);
      continue;
    }
    let g: AtlasTodayGroup;
    if (parent) {
      g = nodeGroup(parent);
    } else {
      const district = ATLAS_DISTRICTS.find((d) => d.type === n.type);
      const dir = dirOf(n.path);
      g =
        dir && dir !== district?.prefix
          ? groupFor(`dir:${n.type}:${dir}`, () => ({
              kind: n.type,
              title: atlasHumanTitle(leaf(dir)),
              path: dir,
              node: null,
              stories: null,
              column: null,
            }))
          : groupFor(`district:${n.type}`, () => ({
              kind: n.type,
              title: districtLabel(n.type),
              path: district?.prefix ?? "",
              node: null,
              stories: null,
              column: null,
            }));
    }
    g.rows.push(rowOf(n));
    g.touched = Math.max(g.touched, n.touched ?? 0);
  }

  for (const g of groups.values()) {
    g.rows.sort((a, b) => (b.node.touched ?? 0) - (a.node.touched ?? 0) || a.title.localeCompare(b.title));
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.kind === "project") - Number(a.kind === "project") ||
      b.touched - a.touched ||
      a.title.localeCompare(b.title),
  );
}
