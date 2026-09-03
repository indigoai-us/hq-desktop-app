/**
 * Atlas graph model (US-018). Matches the console atlas wire: nodes with
 * type/label/position and undirected edges. Desktop renders read-only.
 */

export const ATLAS_NODE_TYPES = [
  "company",
  "person",
  "agent",
  "file",
] as const;
export type AtlasNodeType = (typeof ATLAS_NODE_TYPES)[number];

export interface AtlasNode {
  id: string;
  type: AtlasNodeType;
  label: string;
  subtitle?: string;
  x: number;
  y: number;
}

export interface AtlasEdge {
  from: string;
  to: string;
}

export interface AtlasGraph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export const ATLAS_SMOKE_FIXTURE: AtlasGraph = {
  nodes: [
    { id: "cmp_acme", type: "company", label: "Ramen Bae", x: 400, y: 280 },
    {
      id: "prs_corey",
      type: "person",
      label: "Corey Epstein",
      subtitle: "owner",
      x: 250,
      y: 180,
    },
    {
      id: "prs_jacob",
      type: "person",
      label: "Jacob Posel",
      subtitle: "member",
      x: 550,
      y: 180,
    },
    {
      id: "agt_polar",
      type: "agent",
      label: "Polar",
      subtitle: "basic · Codex",
      x: 400,
      y: 430,
    },
    {
      id: "file_brief",
      type: "file",
      label: "brief.md",
      subtitle: "knowledge",
      x: 160,
      y: 360,
    },
  ],
  edges: [
    { from: "cmp_acme", to: "prs_corey" },
    { from: "cmp_acme", to: "prs_jacob" },
    { from: "cmp_acme", to: "agt_polar" },
    { from: "cmp_acme", to: "file_brief" },
  ],
};

export function parseAtlasGraph(raw: unknown): AtlasGraph | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.nodes) || !Array.isArray(row.edges)) return null;
  const nodes: AtlasNode[] = [];
  for (const item of row.nodes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const node = item as Record<string, unknown>;
    if (typeof node.id !== "string" || node.id.length === 0) return null;
    if (!ATLAS_NODE_TYPES.includes(node.type as AtlasNodeType)) return null;
    if (typeof node.label !== "string") return null;
    if (typeof node.x !== "number" || typeof node.y !== "number") return null;
    nodes.push({
      id: node.id,
      type: node.type as AtlasNodeType,
      label: node.label,
      subtitle: typeof node.subtitle === "string" ? node.subtitle : undefined,
      x: node.x,
      y: node.y,
    });
  }
  const edges: AtlasEdge[] = [];
  for (const item of row.edges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const edge = item as Record<string, unknown>;
    if (typeof edge.from !== "string" || typeof edge.to !== "string") return null;
    edges.push({ from: edge.from, to: edge.to });
  }
  return { nodes, edges };
}

export function atlasFill(type: AtlasNodeType): string {
  if (type === "company") return "#e8e4dc";
  if (type === "person") return "#9ec5ff";
  if (type === "agent") return "#c4b5fd";
  return "#86efac";
}

export function makeAtlasStressGraph(count: number): AtlasGraph {
  const nodes: AtlasNode[] = [
    { id: "cmp", type: "company", label: "Stress", x: 400, y: 300 },
  ];
  const edges: AtlasEdge[] = [];
  const n = Math.max(0, count - 1);
  for (let i = 0; i < n; i += 1) {
    const angle = (Math.PI * 2 * i) / Math.max(n, 1);
    const id = `n${i}`;
    nodes.push({
      id,
      type: i % 5 === 0 ? "agent" : "person",
      label: `Node ${i}`,
      x: 400 + Math.cos(angle) * 220,
      y: 300 + Math.sin(angle) * 160,
    });
    edges.push({ from: "cmp", to: id });
  }
  return { nodes, edges };
}
