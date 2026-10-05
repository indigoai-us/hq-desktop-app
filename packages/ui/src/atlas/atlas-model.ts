/**
 * Company Atlas object model (US-012).
 *
 * Copied from the web Console atlas libraries so both surfaces share one
 * vocabulary: hq-console src/lib/company-atlas.ts (districts, nodes, PRD
 * detail), src/lib/atlas-hover.ts (date copy) and
 * src/lib/company-atlas-layout.ts (related-count copy). Keep the strings in
 * sync with those files rather than rewording them here.
 */

export const ATLAS_DISTRICTS = [
  { type: "project", prefix: "projects/", label: "Projects" },
  { type: "knowledge", prefix: "knowledge/", label: "Knowledge" },
  { type: "policy", prefix: "policies/", label: "Policies" },
  { type: "repo", prefix: "repos/", label: "Repos" },
  { type: "worker", prefix: "workers/", label: "Workers" },
  { type: "skill", prefix: "skills/", label: "Skills" },
] as const;

export type AtlasDistrictType = (typeof ATLAS_DISTRICTS)[number]["type"];

/** Ring order on the desktop map, clockwise from the top. */
export const ATLAS_RING_ORDER: readonly AtlasDistrictType[] = [
  "project",
  "repo",
  "worker",
  "skill",
  "policy",
  "knowledge",
];

export type AtlasStories = { done: number; total: number };

export type AtlasNode = {
  id: string;
  type: AtlasDistrictType;
  label: string;
  path: string;
  folder: boolean;
  touched?: number;
  created?: number;
  count: number;
  parentId?: string;
  depth?: number;
  stories?: AtlasStories;
};

export type AtlasRefEdge = {
  source: string;
  target: string;
  kind: "uses" | "cites" | "assigned" | "contains";
};

export type AtlasGraph = {
  nodes: AtlasNode[];
  company: string;
  stories?: AtlasStories;
  edges?: AtlasRefEdge[];
};

export type AtlasStory = { id: string; title: string; passes?: boolean };

export type AtlasDetail = {
  summary?: string;
  goal?: string;
  success?: string;
  branch?: string;
  stories?: AtlasStory[];
  preview?: string;
};

/** Someone working on an object right now (from the desktop presence stores). */
export type AtlasPresence = {
  nodeId: string;
  /** Work Mesh actor uid; drives the sidepane people filter (US-013). */
  actorUid?: string;
  name: string;
  bot: boolean;
  signal?: string;
  /** Online with no session in progress; listed apart from Working now. */
  idle?: boolean;
  /** Name of the object on the map they are working on, when there is one. */
  place?: string;
};

const DISTRICT_TYPES = new Set<string>(ATLAS_DISTRICTS.map((d) => d.type));
const EDGE_KINDS = new Set(["uses", "cites", "assigned", "contains"]);

export function districtLabel(type: AtlasDistrictType): string {
  return ATLAS_DISTRICTS.find((d) => d.type === type)?.label ?? type;
}

export function objectSize(n: Pick<AtlasNode, "count" | "stories">): number {
  if (n.stories?.total) return n.stories.total;
  return Math.max(1, n.count || 1);
}

function num(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Validate the Console `GET /api/companies/{uid}/atlas` body. */
export function parseAtlasGraph(raw: unknown): AtlasGraph | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.nodes)) return null;
  const nodes: AtlasNode[] = [];
  for (const item of row.nodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id) continue;
    if (typeof n.type !== "string" || !DISTRICT_TYPES.has(n.type)) continue;
    const stories =
      n.stories && typeof n.stories === "object"
        ? (n.stories as Record<string, unknown>)
        : null;
    nodes.push({
      id: n.id,
      type: n.type as AtlasDistrictType,
      label: typeof n.label === "string" ? n.label : n.id,
      path: typeof n.path === "string" ? n.path : "",
      folder: n.folder === true,
      touched: num(n.touched),
      created: num(n.created),
      count: num(n.count) ?? 1,
      parentId: typeof n.parentId === "string" ? n.parentId : undefined,
      depth: num(n.depth),
      stories:
        stories && num(stories.total) != null
          ? { done: num(stories.done) ?? 0, total: num(stories.total) as number }
          : undefined,
    });
  }
  const edges: AtlasRefEdge[] = [];
  for (const item of Array.isArray(row.edges) ? row.edges : []) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.source !== "string" || typeof e.target !== "string") continue;
    if (typeof e.kind !== "string" || !EDGE_KINDS.has(e.kind)) continue;
    edges.push({
      source: e.source,
      target: e.target,
      kind: e.kind as AtlasRefEdge["kind"],
    });
  }
  return {
    company: typeof row.company === "string" ? row.company : "",
    nodes,
    edges,
  };
}

export function detailFromPrd(raw: unknown): AtlasDetail | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const md =
    rec.metadata && typeof rec.metadata === "object"
      ? (rec.metadata as Record<string, unknown>)
      : {};
  const list = [rec.stories, rec.userStories, rec.features].find(Array.isArray) as
    | Record<string, unknown>[]
    | undefined;
  const stories = (list || [])
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      id: String(s.id ?? ""),
      title: String(s.title ?? s.id ?? ""),
      passes: s.passes === true,
    }));
  const goal =
    typeof rec.goal === "string"
      ? rec.goal
      : typeof md.goal === "string"
        ? md.goal
        : undefined;
  const summary =
    typeof rec.description === "string"
      ? rec.description
      : typeof rec.summary === "string"
        ? rec.summary
        : goal;
  const success = typeof rec.success === "string" ? rec.success : undefined;
  const branch =
    typeof rec.branch === "string"
      ? rec.branch
      : typeof rec.branchName === "string"
        ? rec.branchName
        : undefined;
  if (!summary && !goal && !success && !branch && !stories.length) return undefined;
  return { summary, goal, success, branch, stories: stories.length ? stories : undefined };
}

/** Vault key to open for an Atlas selection — any file, or a project's prd.json. */
export function atlasPaneObjectKey(
  n: Pick<AtlasNode, "folder" | "path" | "type">,
): string | null {
  if (!n.path) return null;
  if (n.folder) {
    if (n.type !== "project") return null;
    return `${n.path.replace(/\/?$/, "/")}prd.json`;
  }
  return n.path;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtCompactDate(ms?: number, nowMs = Date.now()): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const now = new Date(nowMs);
  const stamp = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (d.getUTCFullYear() !== now.getUTCFullYear()) return `${stamp}, ${d.getUTCFullYear()}`;
  return stamp;
}

/** Inspector footer: `Born Jul 16 · Touched Sep 30 · 14 inside`. */
export function atlasFooterLine(
  n: Pick<AtlasNode, "created" | "touched" | "count" | "folder">,
  nowMs = Date.now(),
): string {
  const parts: string[] = [];
  const born = fmtCompactDate(n.created, nowMs);
  const touched = fmtCompactDate(n.touched, nowMs);
  if (born) parts.push(`Born ${born}`);
  if (touched) parts.push(`Touched ${touched}`);
  if (n.folder) parts.push(`${n.count} inside`);
  return parts.join(" · ");
}

const RELATED_LABEL: Record<AtlasDistrictType, [string, string]> = {
  project: ["project", "projects"],
  knowledge: ["knowledge doc", "knowledge docs"],
  policy: ["policy", "policies"],
  repo: ["repo", "repos"],
  worker: ["worker", "workers"],
  skill: ["skill", "skills"],
};

/** Short kind tag used in the inspector's Related list. */
export const ATLAS_KIND_TAG: Record<AtlasDistrictType, string> = {
  project: "project",
  knowledge: "know",
  policy: "policy",
  repo: "repo",
  worker: "worker",
  skill: "skill",
};

export function atlasRelatedCountsLine(
  rows: { type: AtlasDistrictType; count: number }[],
): string {
  return rows
    .map((row) => {
      const [one, many] = RELATED_LABEL[row.type];
      return `${row.count} ${row.count === 1 ? one : many}`;
    })
    .join(" · ");
}

export function smokeAtlasGraph(company = "Indigo", now = Date.UTC(2026, 8, 30)): AtlasGraph {
  const day = 86_400_000;
  const node = (
    type: AtlasDistrictType,
    path: string,
    extra: Partial<AtlasNode> = {},
  ): AtlasNode => {
    const leaf = path.replace(/\/+$/, "").split("/").pop() ?? path;
    return {
      id: `${type}:${path}`,
      type,
      label: leaf.replace(/-/g, " ").replace(/\.(md|json|ya?ml)$/i, ""),
      path,
      folder: path.endsWith("/"),
      count: 1,
      touched: now - day * 9,
      created: now - day * 60,
      ...extra,
    };
  };
  const nodes: AtlasNode[] = [
    node("project", "projects/hq-desktop-console-rail/", {
      count: 14,
      stories: { done: 0, total: 9 },
      touched: now,
      created: now - day * 76,
    }),
    node("project", "projects/hq-explorer/", { count: 22, stories: { done: 7, total: 11 } }),
    node("project", "projects/launch-landing/", { count: 6, touched: now - day }),
    node("project", "projects/billing-v2/", { count: 4 }),
    node("repo", "repos/private/hq-desktop-app/", { count: 1, touched: now }),
    node("repo", "repos/private/hq-console/", { count: 1 }),
    node("repo", "repos/private/hq-pro/", { count: 1 }),
    node("worker", "workers/paper-designer/", { count: 5 }),
    node("worker", "workers/reviewer/", { count: 3 }),
    node("skill", "skills/search/", { count: 2 }),
    node("skill", "skills/deploy/", { count: 3 }),
    node("policy", "policies/tenancy.md"),
    node("policy", "policies/no-new-colors.md"),
    node("knowledge", "knowledge/design-styles.md", { touched: now - day }),
    node("knowledge", "knowledge/brand-pack.md"),
    node("knowledge", "knowledge/pricing.md"),
  ];
  const rail = "project:projects/hq-desktop-console-rail/";
  return {
    company,
    nodes,
    edges: [
      { source: rail, target: "repo:repos/private/hq-desktop-app/", kind: "uses" },
      { source: rail, target: "knowledge:knowledge/design-styles.md", kind: "cites" },
      { source: rail, target: "worker:workers/paper-designer/", kind: "assigned" },
      { source: "project:projects/hq-explorer/", target: "repo:repos/private/hq-console/", kind: "uses" },
      { source: "project:projects/billing-v2/", target: "repo:repos/private/hq-pro/", kind: "uses" },
    ],
  };
}

export const ATLAS_SMOKE_DETAIL: AtlasDetail = {
  goal: "Bring Console functions into the desktop app behind a left icon rail, company sidepanes, a project Files tab, and Atlas as the company landing.",
  branch: "feat/console-rail",
  stories: [
    { id: "US-001", title: "Rail shell and titlebar cleanup" },
    { id: "US-002", title: "Pinned companies and More popover" },
    { id: "US-003", title: "Sidepane host with three content models" },
    { id: "US-009", title: "Company sidepane, Atlas landing" },
    { id: "US-010", title: "Kanban live cards" },
    { id: "US-011", title: "Project Files tab" },
    { id: "US-012", title: "Atlas map, inspector, scrubber" },
  ],
};
