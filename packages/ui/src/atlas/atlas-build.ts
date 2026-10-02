/**
 * Builds the company Atlas graph on the client from the ACL-filtered vault
 * listing (hq-pro `GET /v1/files/list`) and project PRDs (QA-016).
 *
 * The web Console builds the same graph server-side behind its browser
 * session, which the native app does not have. The native app reaches hq-pro
 * through the platform adapter with its own HQ sign-in, so it lists and
 * shapes the vault here instead. Ported from hq-console
 * src/lib/company-atlas-server.ts (`loadAtlasGraph`, no prefix) and
 * src/lib/company-atlas.ts; keep the shaping rules in sync with those files.
 */

import {
  ATLAS_DISTRICTS,
  type AtlasDistrictType,
  type AtlasGraph,
  type AtlasNode,
  type AtlasRefEdge,
} from "./atlas-model.js";
import type { AtlasLocalSource, AtlasVaultSource } from "../shell/atlas-landing.js";

export type { AtlasLocalSource, AtlasVaultSource };

import { parseListPage, type AtlasListedObject, type AtlasListPage } from "../shell/vault-list-page.js";

export { parseListPage };
export type { AtlasListedObject, AtlasListPage };

type AtlasPrdRefs = {
  projectId: string;
  repos: string[];
  knowledge: string[];
  workers: string[];
  created?: number;
  updated?: number;
};

const DISTRICT_MAX_KEYS = 100_000;
const REGISTRY_MAX_KEYS = 5_000;
const PRD_FETCH_CONCURRENCY = 32;
/**
 * PRD reads only add links between objects. A large company has hundreds of
 * PRDs, so stop starting new reads after this long and paint what we have;
 * the refresh timeout must never be spent on links (QA-016).
 */
export const ATLAS_PRD_BUDGET_MS = 8_000;
const RECENT_FILES = 80;
const SKIP_ROOT_FILES = new Set(["INDEX.md", "README.md", "board.json", "company.yaml"]);

async function listAll(
  source: AtlasVaultSource,
  companyUid: string,
  prefix: string,
  maxKeys: number,
): Promise<AtlasListedObject[]> {
  const out: AtlasListedObject[] = [];
  let cursor: string | undefined;
  do {
    const page = parseListPage(await source.listPage(companyUid, prefix, cursor));
    for (const o of page.objects) {
      out.push(o);
      if (out.length >= maxKeys) return out;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return out;
}

function skipAtlasName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith("._") || name.startsWith("_")) return true;
  return name === ".DS_Store" || name === "Thumbs.db" || name === ".git";
}

function leafName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function ms(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

/** Root-view nodes for one district: folders are continents, loose files recent-only or hidden. */
export function districtNodes(
  type: AtlasDistrictType,
  prefix: string,
  listed: AtlasListedObject[],
): AtlasNode[] {
  const objects = listed.filter((o) => o.key.startsWith(prefix) && o.key !== prefix);
  const prefixes = new Set<string>();
  const looseFiles: AtlasListedObject[] = [];
  const touchedByFolder = new Map<string, number>();
  const createdByFolder = new Map<string, number>();
  const countByFolder = new Map<string, number>();
  for (const obj of objects) {
    const rest = obj.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      looseFiles.push(obj);
      continue;
    }
    const folder = prefix + rest.slice(0, slash + 1);
    prefixes.add(folder);
    countByFolder.set(folder, (countByFolder.get(folder) ?? 0) + 1);
    const t = ms(obj.lastModified);
    if (!t) continue;
    if (t > (touchedByFolder.get(folder) ?? 0)) touchedByFolder.set(folder, t);
    const prevC = createdByFolder.get(folder);
    if (prevC == null || t < prevC) createdByFolder.set(folder, t);
  }

  const folders: AtlasNode[] = [...prefixes]
    .sort()
    .filter((path) => !skipAtlasName(leafName(path)))
    .map((path) => ({
      id: `${type}:${path}`,
      type,
      label: leafName(path).replace(/-/g, " "),
      path,
      folder: true,
      touched: touchedByFolder.get(path),
      created: createdByFolder.get(path),
      count: Math.max(1, countByFolder.get(path) ?? 1),
    }));

  const continent = type === "policy" || type === "knowledge";
  const fileRows = continent
    ? looseFiles
        .filter((file) => {
          const name = leafName(file.key);
          return !skipAtlasName(name) && !SKIP_ROOT_FILES.has(name);
        })
        .sort((a, b) => (ms(b.lastModified) ?? 0) - (ms(a.lastModified) ?? 0))
        .slice(0, RECENT_FILES)
    : [];
  const files: AtlasNode[] = fileRows.map((file) => ({
    id: `${type}:${file.key}`,
    type,
    label: leafName(file.key).replace(/-/g, " ").replace(/\.(md|json|ya?ml|txt)$/i, ""),
    path: file.key,
    folder: false,
    touched: ms(file.lastModified),
    created: ms(file.lastModified),
    count: 1,
  }));
  return [...folders, ...files];
}

function cleanPrdRef(raw: string): string | null {
  const token = String(raw).split("#")[0].trim().split(/\s+/)[0];
  if (!token || token.includes("://")) return null;
  if (/[{}*]/.test(token)) return null;
  if (/^[A-Za-z]:[\\/]/.test(token)) return null;
  return token.replace(/^\/+/, "");
}

const REPO_ROOT = /^(repos\/(?:public|private)|companies\/[^/]+\/repos)\/([A-Za-z0-9][A-Za-z0-9._-]*)/;
const FILE_SLUG = /\.(md|json|ya?ml|ts|tsx|js|jsx|mjs|cjs|rs|py|go|svelte|css|html|txt|toml|lock)$/i;

function vaultRelative(path: string): string {
  return path.replace(/^companies\/[^/]+\//, "");
}

function normalizeRepoRef(raw: string): { slug: string; path: string } | null {
  const cleaned = cleanPrdRef(raw);
  if (!cleaned) return null;
  const rel = vaultRelative(cleaned).replace(/\/+$/, "");
  const match = rel.match(REPO_ROOT);
  if (!match) return null;
  const slug = match[2];
  if (FILE_SLUG.test(slug)) return null;
  return { slug, path: `${match[1]}/${slug}/` };
}

function isoMs(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** repoPath / knowledge / relatedWorkers cites from one PRD. */
export function refsFromPrd(raw: unknown): Omit<AtlasPrdRefs, "projectId"> {
  const empty = { repos: [] as string[], knowledge: [] as string[], workers: [] as string[] };
  if (!raw || typeof raw !== "object") return empty;
  const rec = raw as Record<string, unknown>;
  const md =
    rec.metadata && typeof rec.metadata === "object" ? (rec.metadata as Record<string, unknown>) : {};
  const repos: string[] = [];
  const pushRepo = (value: unknown) => {
    if (typeof value === "string") {
      const repo = normalizeRepoRef(value);
      if (repo) repos.push(repo.path);
      return;
    }
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      const path = row.repoPath ?? row.github ?? row.path;
      if (typeof path === "string") {
        const repo = normalizeRepoRef(path);
        if (repo) repos.push(repo.path);
      }
    }
  };
  if (typeof md.repoPath === "string") pushRepo(md.repoPath);
  if (typeof md.secondaryRepoPath === "string") pushRepo(md.secondaryRepoPath);
  for (const extra of [md.repos, md.secondaryRepos, rec.repos]) {
    if (Array.isArray(extra)) {
      for (const val of extra) pushRepo(val);
    } else if (extra && typeof extra === "object") {
      for (const val of Object.values(extra as Record<string, unknown>)) pushRepo(val);
    }
  }
  const stories = [rec.stories, rec.userStories].find(Array.isArray) as unknown[] | undefined;
  for (const story of stories ?? []) {
    if (!story || typeof story !== "object") continue;
    const files = (story as { files?: unknown }).files;
    for (const file of Array.isArray(files) ? files : []) {
      const rawFile = String(file);
      if (!rawFile.startsWith("repos/")) continue;
      const parts = rawFile.split("/");
      if (parts.length >= 3) pushRepo(parts.slice(0, 3).join("/"));
    }
  }
  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
  const knowledge = listOf(md.knowledge)
    .map((k) => cleanPrdRef(String(k)))
    .filter((k): k is string => Boolean(k))
    .slice(0, 16);
  const workers = listOf(md.relatedWorkers)
    .map((w) => cleanPrdRef(String(w)))
    .filter((w): w is string => Boolean(w));
  return {
    repos: [...new Set(repos)],
    knowledge,
    workers,
    created: isoMs(md.createdAt ?? rec.createdAt ?? md.created),
    updated: isoMs(md.updatedAt ?? rec.updatedAt ?? md.updated),
  };
}

function districtForRef(path: string): AtlasDistrictType {
  const rel = vaultRelative(path);
  if (rel.startsWith("policies/") || rel.startsWith("policy/")) return "policy";
  if (rel.startsWith("repos/") || rel.startsWith("repo/")) return "repo";
  if (rel.startsWith("workers/") || !rel.includes("/")) return "worker";
  if (rel.startsWith("skills/")) return "skill";
  return "knowledge";
}

function findExisting(nodes: AtlasNode[], type: AtlasDistrictType, ref: string): AtlasNode | undefined {
  const rel = vaultRelative(ref);
  const slug = leafName(rel);
  return nodes.find((n) => {
    if (n.type !== type) return false;
    if (n.path === rel || n.path === `${rel}/` || n.id === `${type}:${rel}` || n.id === `${type}:${rel}/`) {
      return true;
    }
    return leafName(n.path) === slug || n.label.replace(/\s+/g, "-") === slug;
  });
}

function syntheticNode(type: AtlasDistrictType, ref: string): AtlasNode {
  const rel = vaultRelative(ref);
  const slug = leafName(rel);
  const folder = type === "repo" || type === "worker" || rel.endsWith("/");
  const path = folder && !rel.endsWith("/") ? `${rel}/` : rel;
  return {
    id: `${type}:${path}`,
    type,
    label: slug.replace(/-/g, " ").replace(/\.(md|json|ya?ml|txt)$/i, ""),
    path,
    folder,
    count: 1,
  };
}

/** Fill missing continents from PRD repo / knowledge / worker cites, with edges. */
export function applyPrdRefs(
  nodes: AtlasNode[],
  refs: AtlasPrdRefs[],
  seeds: string[] = [],
): { nodes: AtlasNode[]; edges: AtlasRefEdge[] } {
  const out = [...nodes];
  const edges: AtlasRefEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (source: string, target: string | null, kind: AtlasRefEdge["kind"]) => {
    if (!target || source === target) return;
    const key = `${kind}:${source}->${target}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source, target, kind });
  };
  const resolve = (type: AtlasDistrictType, ref: string): string | null => {
    if (type === "repo") {
      const repo = normalizeRepoRef(ref);
      if (!repo) return null;
      const existing = findExisting(out, "repo", repo.path) ?? findExisting(out, "repo", repo.slug);
      if (existing) return existing.id;
      const node = syntheticNode("repo", repo.path);
      out.push(node);
      return node.id;
    }
    const existing = findExisting(out, type, ref);
    if (existing) return existing.id;
    const node = syntheticNode(type, ref);
    out.push(node);
    return node.id;
  };
  for (const seed of seeds) resolve("repo", seed);
  for (const row of refs) {
    const project = out.find((n) => n.id === row.projectId);
    if (project) {
      if (row.created) project.created = row.created;
      if (row.updated) project.touched = Math.max(project.touched ?? 0, row.updated);
      else if (row.created && (project.touched == null || project.touched < row.created)) {
        project.touched = row.created;
      }
    }
    const stamp = (id: string | null) => {
      if (!id || !project) return;
      const node = out.find((n) => n.id === id);
      if (!node) return;
      if (project.created != null) {
        node.created = node.created == null ? project.created : Math.min(node.created, project.created);
      }
      const touched = project.touched ?? project.created;
      if (touched != null) node.touched = Math.max(node.touched ?? 0, touched);
    };
    for (const repo of row.repos) {
      const target = resolve("repo", repo);
      addEdge(row.projectId, target, "uses");
      stamp(target);
    }
    for (const worker of row.workers) {
      const target = resolve("worker", worker);
      addEdge(row.projectId, target, "assigned");
      stamp(target);
    }
    for (const item of row.knowledge) {
      const repo = normalizeRepoRef(item);
      if (repo) {
        const target = resolve("repo", repo.path);
        addEdge(row.projectId, target, "cites");
        stamp(target);
        continue;
      }
      const type = districtForRef(item);
      if (type === "repo") continue;
      const target = resolve(type, item);
      addEdge(row.projectId, target, "cites");
      stamp(target);
    }
  }
  return { nodes: out, edges };
}

const KEY_DATE = /(\d{4}-\d{2}-\d{2})/;

/** Born/touched dates from dated names inside project folders, over vault sync mtime. */
export function applyFolderActivity(nodes: AtlasNode[], keys: string[]): AtlasNode[] {
  for (const node of nodes) {
    if (node.type !== "project" || !node.folder) continue;
    let created: number | undefined;
    let touched: number | undefined;
    for (const key of keys) {
      if (!key.startsWith(node.path)) continue;
      const match = KEY_DATE.exec(key.slice(node.path.length));
      if (!match) continue;
      const t = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (!Number.isFinite(t)) continue;
      if (created == null || t < created) created = t;
      if (touched == null || t > touched) touched = t;
    }
    if (created != null) node.created = node.created == null ? created : Math.min(node.created, created);
    if (touched != null) node.touched = touched;
  }
  return nodes;
}

async function loadProjectRefs(
  source: AtlasVaultSource,
  companyUid: string,
  objects: AtlasListedObject[],
  budgetMs: number,
  now: () => number,
): Promise<AtlasPrdRefs[]> {
  const deadline = now() + budgetMs;
  const keys = objects.filter((o) => {
    if (!o.key.startsWith("projects/") || !o.key.endsWith("/prd.json")) return false;
    return o.key.slice("projects/".length).split("/").length === 2;
  });
  const refs: AtlasPrdRefs[] = [];
  // Newest projects first, so a cut-off budget keeps the links people look at.
  keys.sort((a, b) => (ms(b.lastModified) ?? 0) - (ms(a.lastModified) ?? 0));
  for (let i = 0; i < keys.length; i += PRD_FETCH_CONCURRENCY) {
    if (now() >= deadline) {
      console.warn(`[atlas] PRD budget spent; linked ${i} of ${keys.length} projects`);
      break;
    }
    const chunk = keys.slice(i, i + PRD_FETCH_CONCURRENCY);
    const rows = await Promise.all(
      chunk.map(async (row) => {
        try {
          const text = await source.readText(companyUid, row.key);
          if (text == null) return null;
          const folder = row.key.slice(0, row.key.length - "prd.json".length);
          return { projectId: `project:${folder}`, ...refsFromPrd(JSON.parse(text)) };
        } catch (err) {
          // One unreadable PRD drops its links only; the map still loads.
          console.warn("[atlas] project PRD unreadable", row.key, err);
          return null;
        }
      }),
    );
    for (const row of rows) if (row) refs.push(row);
  }
  return refs;
}

async function loadRegistryRepoSeeds(source: AtlasVaultSource, companyUid: string): Promise<string[]> {
  try {
    const objects = await listAll(source, companyUid, "registry/resources/", REGISTRY_MAX_KEYS);
    const seeds: string[] = [];
    for (const obj of objects) {
      const name = obj.key.split("/").pop() ?? "";
      const match = /^repo-([A-Za-z0-9][A-Za-z0-9._-]*)\.ya?ml$/i.exec(name);
      if (match) seeds.push(`repos/private/${match[1]}`);
    }
    return seeds;
  } catch (err) {
    // Registry seeds only add repo continents; the map loads without them.
    console.warn("[atlas] registry listing failed", err);
    return [];
  }
}

/** A local listing from the native app: `{ revision, complete, objects }`. */
export type AtlasLocalListing = AtlasListPage & { revision: string; complete: boolean };

/** Parse a local listing; null when the company folder is not on this machine. */
export function parseLocalListing(raw: unknown): AtlasLocalListing | null {
  if (raw == null) return null;
  const page = parseListPage(raw);
  const row = raw as Record<string, unknown>;
  return {
    ...page,
    revision: typeof row.revision === "string" ? row.revision : "",
    complete: row.complete === true,
  };
}

/** Serve `listPage` from one in-memory listing and `readText` through `readText`. */
export function listingVaultSource(
  listing: AtlasListPage,
  readText: (key: string) => Promise<string | null>,
): AtlasVaultSource {
  return {
    async listPage(_company, prefix) {
      return { objects: listing.objects.filter((o) => o.key.startsWith(prefix)), cursor: null };
    },
    readText: (_company, key) => readText(key),
  };
}

/** The company's root Atlas graph, same shape as Console `GET /api/companies/{uid}/atlas`. */
export async function buildAtlasGraph(
  source: AtlasVaultSource,
  companyUid: string,
  opts: { prdBudgetMs?: number; now?: () => number; links?: boolean } = {},
): Promise<AtlasGraph> {
  const batches = await Promise.all(
    ATLAS_DISTRICTS.map(async (d) => {
      const objects = await listAll(source, companyUid, d.prefix, DISTRICT_MAX_KEYS);
      return { type: d.type, objects, nodes: districtNodes(d.type, d.prefix, objects) };
    }),
  );
  const listed = batches.flatMap((b) => b.nodes);
  const projectObjects = batches.find((b) => b.type === "project")?.objects ?? [];
  // The first page has folder placeholders only; links wait for the full listing.
  const [refs, seeds] = await Promise.all([
    opts.links === false
      ? Promise.resolve([])
      : loadProjectRefs(source, companyUid, projectObjects, opts.prdBudgetMs ?? ATLAS_PRD_BUDGET_MS, opts.now ?? Date.now),
    loadRegistryRepoSeeds(source, companyUid),
  ]);
  const merged = applyPrdRefs(listed, refs, seeds);
  applyFolderActivity(
    merged.nodes,
    projectObjects.map((o) => o.key),
  );
  return { company: companyUid, nodes: merged.nodes, edges: merged.edges };
}
