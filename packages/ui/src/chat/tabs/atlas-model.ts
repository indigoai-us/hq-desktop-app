/**
 * Atlas graph model (US-018). Matches the console atlas wire: nodes with
 * type/label/position and undirected edges. Desktop renders read-only.
 */

const ATLAS_NODE_TYPES = [
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

