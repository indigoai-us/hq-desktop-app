/**
 * Company Brain pages (console-rail US-028).
 *
 * Pure data. Listings paint from a per-slug cache and refresh after the
 * first frame. Create sheets hand the existing HQ slash commands to Claude
 * Code (`/learn`, `/create-skill`, `/newworker`). They do not invent a file
 * format. Run prefills `/skill` or `/run worker`.
 */

import type { LibrarySkill, LibraryWorker } from "../../library/library.js";
import { displayTitle } from "../../common/display-title.js";

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

/** Rows past this count window on scroll instead of mounting every node. */
export const VIRTUAL_AFTER = 200;
const ROW_HEIGHT = 62;

export type BrainPageId = "knowledge" | "policies" | "skills" | "workers";

export type PolicyEnforcement = "hard" | "soft";
export type PolicyScope = "company" | "project" | "personal";
export type SkillScope = "company" | "personal";
export type WorkerScope = "company" | "personal";
export type SkillTemplate = "blank" | "brief" | "monitor" | "pipeline";

export interface KnowledgeFile {
  path: string;
  name: string;
  title: string;
  folder: string;
  mark: "new" | "upd" | null;
  body: string;
  /** Last-changed date from frontmatter (YYYY-MM-DD), when the file has one. */
  changed?: string | null;
}

export interface PolicyDoc {
  path: string;
  title: string;
  enforcement: PolicyEnforcement;
  when: string;
  scope: string;
  appliesTo: string;
  satisfiedBy: string;
  version: string;
  createdBy: string;
  edited: string;
  body: string;
}

export interface SkillRow {
  name: string;
  description: string;
  path: string;
  scope: string;
  triggers: string[];
  owner: string;
  lastRun: string;
  runs: number;
  running: boolean;
  needsAccess: boolean;
  mine: boolean;
  shared: boolean;
}

export interface WorkerRow {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: "company" | "personal" | "root";
  /** The worker's own status from worker.yaml (active, parked, ...). */
  status: string;
  tools: string[];
  skills: string[];
  parked: boolean;
  mine: boolean;
  scheduled: boolean;
  live: boolean;
  lastRun: string;
}

export interface BrainCache {
  knowledge: KnowledgeFile[];
  policies: PolicyDoc[];
  skills: SkillRow[];
  workers: WorkerRow[];
}

const cache = new Map<string, BrainCache>();

export function readBrainCache(slug: string): BrainCache | null {
  return cache.get(slug) ?? null;
}

export function writeBrainCache(slug: string, value: BrainCache): void {
  if (slug) cache.set(slug, value);
}

export function emptyBrainCache(): BrainCache {
  return { knowledge: [], policies: [], skills: [], workers: [] };
}

/** QA-100: a file-backed list is not loaded, loading (maybe with cached rows), or loaded. */
export type BrainListLoad = "not-loaded" | "loading" | "loaded";

export interface BrainListView {
  body: "skeleton" | "rows" | "empty";
  /** Null while nothing trustworthy is known; a zero only after the read finished. */
  count: number | null;
}

/** Cached rows show at once; without them a skeleton shows and no count until the read ends. */
export function brainListView(load: BrainListLoad, rows: number): BrainListView {
  if (rows > 0) return { body: "rows", count: rows };
  if (load === "loaded") return { body: "empty", count: 0 };
  return { body: "skeleton", count: null };
}

export function virtualWindow(
  count: number,
  scrollTop: number,
  viewport: number,
): { start: number; end: number; padTop: number; padBottom: number } {
  if (count <= VIRTUAL_AFTER) {
    return { start: 0, end: count, padTop: 0, padBottom: 0 };
  }
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const visible = Math.ceil(Math.max(viewport, ROW_HEIGHT) / ROW_HEIGHT) + 8;
  const end = Math.min(count, start + visible);
  return {
    start,
    end,
    padTop: start * ROW_HEIGHT,
    padBottom: Math.max(0, count - end) * ROW_HEIGHT,
  };
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function fm(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function bodyAfterFm(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n/, "");
}

function titleFrom(path: string, text: string): string {
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

export function knowledgeFromFile(path: string, text: string): KnowledgeFile {
  const meta = fm(text);
  const markRaw = (meta.mark ?? meta.status ?? "").toLowerCase();
  const mark = markRaw === "new" ? "new" : markRaw === "upd" || markRaw === "updated" ? "upd" : null;
  const folder = path.split("/").slice(0, -1).join("/");
  return {
    path,
    name: path.split("/").pop() ?? path,
    title: displayTitle(meta.title || titleFrom(path, text)),
    folder,
    mark,
    body: bodyAfterFm(text),
    changed: frontmatterDate(meta),
  };
}

/** Last-changed date from frontmatter fields, newest field first. */
function frontmatterDate(meta: Record<string, string>): string | null {
  for (const key of ["updated", "updated_at", "last_updated", "modified", "date", "created", "created_at"]) {
    const raw = (meta[key] ?? "").replace(/^["']|["']$/g, "").trim();
    const m = raw.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
  }
  return null;
}

/** What's fresh: most recently changed first; files without a date last, by title. */
export function freshKnowledge(rows: readonly KnowledgeFile[]): KnowledgeFile[] {
  return [...rows].sort((a, b) => {
    const da = a.changed ?? "";
    const db = b.changed ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

/** The knowledge folder the tree is rooted at. */
export function knowledgeTreeRoot(slug: string): string {
  return ["companies", slug, "knowledge"].join("/");
}

/** A sync conflict copy (`name.conflict-<time>-<hash>.md`). */
export function isConflictCopy(name: string): boolean {
  return name.includes(".conflict-");
}

/**
 * One folder of the knowledge tree, listed from the file paths already read
 * (the Files tree asks for one folder at a time). Folders first, then files,
 * each by name.
 */
export function knowledgeDirListing(
  paths: readonly string[],
  dir: string,
): Array<{ name: string; path: string; isDir: boolean; hasChildren: boolean }> {
  const prefix = dir ? `${dir}/` : "";
  const dirs = new Map<string, string>();
  const files = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.set(rest, path);
    else dirs.set(rest.slice(0, slash), `${prefix}${rest.slice(0, slash)}`);
  }
  const byName = (a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]);
  return [
    ...[...dirs.entries()].sort(byName).map(([name, path]) => ({ name, path, isDir: true, hasChildren: true })),
    ...[...files.entries()].sort(byName).map(([name, path]) => ({ name, path, isDir: false, hasChildren: false })),
  ];
}

export function policyFromFile(path: string, text: string): PolicyDoc {
  const meta = fm(text);
  const enforcement: PolicyEnforcement =
    (meta.enforcement ?? "").toLowerCase() === "hard" ? "hard" : "soft";
  return {
    path,
    title: displayTitle(meta.title || titleFrom(path, text)),
    enforcement,
    when: meta.when ?? "",
    scope: meta.scope ?? "company",
    appliesTo: meta["applies to"] ?? meta.applies_to ?? "",
    satisfiedBy: meta["satisfied by"] ?? meta.satisfied_by ?? "",
    version: meta.version ?? "",
    createdBy: meta.created_by ?? meta.owner ?? "",
    edited: meta.edited ?? "",
    body: bodyAfterFm(text),
  };
}

export function skillRowFromLibrary(skill: LibrarySkill, selfName: string): SkillRow {
  const triggers = skill.description
    .split(/[.;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length < 48)
    .slice(0, 3);
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope: skill.scope,
    triggers,
    owner: skill.company ?? skill.scope,
    lastRun: "",
    runs: 0,
    running: false,
    needsAccess: false,
    mine: skill.scope === "personal" || skill.company === selfName,
    shared: skill.scope === "root" || Boolean(skill.pack),
  };
}

export function workerRowFromLibrary(worker: LibraryWorker): WorkerRow {
  const parked = worker.status.toLowerCase() === "parked";
  return {
    id: worker.id,
    name: worker.name,
    description: worker.description,
    path: worker.path,
    scope: worker.scope === "company" ? "company" : worker.scope === "root" ? "root" : "personal",
    status: worker.status ?? "",
    tools: [],
    skills: [],
    parked,
    mine: worker.scope !== "root",
    scheduled: false,
    live: worker.status.toLowerCase() === "live" || worker.status.toLowerCase() === "running",
    // OWNER-R12: no run history is read, so lastRun stays empty. It used to
    // hold the status, which left a parked row showing its scope instead.
    lastRun: "",
  };
}

export type SkillFilter = "all" | "mine" | "shared" | "needs-access";
export type WorkerFilter = "all" | "active" | "parked" | "mine" | "scheduled";
export type WorkerScopeFilter = "all" | "company" | "personal";
export type PolicyFilter = "all" | "hard" | "soft";

export function filterSkills(rows: readonly SkillRow[], filter: SkillFilter, query: string): SkillRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "mine" && !row.mine) return false;
    if (filter === "shared" && !row.shared) return false;
    if (filter === "needs-access" && !row.needsAccess) return false;
    if (!q) return true;
    return `${row.name} ${row.description} ${row.triggers.join(" ")}`.toLowerCase().includes(q);
  });
}

export function filterWorkers(
  rows: readonly WorkerRow[],
  scope: WorkerScopeFilter,
  filter: WorkerFilter,
  query: string,
): WorkerRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (scope === "company" && row.scope !== "company") return false;
    if (scope === "personal" && row.scope !== "personal") return false;
    if (filter === "active" && row.parked) return false;
    if (filter === "parked" && !row.parked) return false;
    if (filter === "mine" && !row.mine) return false;
    if (filter === "scheduled" && !row.scheduled) return false;
    if (!q) return true;
    return `${row.name} ${row.description} ${row.id}`.toLowerCase().includes(q);
  });
}

/**
 * Which policy-folder entries are real policies. Skips `_`-prefixed entries
 * (`_digest.md`, `_archive/`), HQ Sync conflict artifacts
 * (`name.conflict-<ts>-<hash>.md`) and Finder duplicate copies (`name 2.md`).
 */
export function isPolicyFileName(name: string, _isDir = false): boolean {
  if (!name || name.startsWith("_") || name.startsWith(".")) return false;
  if (/\.conflict-[^/]*\.md$/i.test(name)) return false;
  if (/ \d+\.(md|ya?ml)$/i.test(name)) return false;
  return true;
}

/** Map with at most `limit` promises in flight; keeps input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export function filterPolicies(rows: readonly PolicyDoc[], filter: PolicyFilter, query: string): PolicyDoc[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter !== "all" && row.enforcement !== filter) return false;
    if (!q) return true;
    return `${row.title} ${row.when} ${row.body}`.toLowerCase().includes(q);
  });
}

export function filterKnowledge(rows: readonly KnowledgeFile[], query: string): KnowledgeFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) => `${row.title} ${row.path} ${row.body}`.toLowerCase().includes(q));
}

/** Claude Code prompt that runs a skill. The slash name is the prefill. */
export function skillRunPrompt(name: string): string {
  return `/${name}`;
}

/** Claude Code prompt that runs a worker through the existing /run command. */
export function workerRunPrompt(id: string): string {
  return `/run ${id}`;
}

export interface PolicyDraft {
  title: string;
  enforcement: PolicyEnforcement;
  when: string;
  scope: PolicyScope;
  satisfiedBy: string;
  body: string;
}

export function policyCreatePrompt(slug: string, draft: PolicyDraft): string {
  const file = slugify(draft.title) || "policy";
  const path =
    draft.scope === "personal"
      ? `personal/policies/${file}.md`
      : `companies/${slug}/policies/${file}.md`;
  return [
    "/learn",
    "File this policy with the existing HQ policy markdown command.",
    "Do not invent a new file format.",
    `Path: ${path}`,
    `Title: ${draft.title}`,
    `Enforcement: ${draft.enforcement}`,
    `When: ${draft.when}`,
    `Scope: ${draft.scope}`,
    `Satisfied by: ${draft.satisfiedBy}`,
    "Body:",
    draft.body,
  ].join("\n");
}

export interface SkillDraft {
  name: string;
  scope: SkillScope;
  triggers: string[];
  template: SkillTemplate;
}

export function skillCreatePrompt(slug: string, draft: SkillDraft): string {
  const name = slugify(draft.name) || "skill";
  return [
    "/create-skill",
    "Create this skill with the existing create-skill command.",
    "Write SKILL.md. Do not invent a new file format.",
    `Name: ${name}`,
    `Company: ${slug}`,
    `Scope: ${draft.scope}`,
    `Template: ${draft.template}`,
    `Trigger phrases: ${draft.triggers.join(", ")}`,
  ].join("\n");
}

export interface WorkerDraft {
  name: string;
  scope: WorkerScope;
  description: string;
  skills: string[];
  tools: string[];
  knowledge: string;
}

export function workerCreatePrompt(slug: string, draft: WorkerDraft): string {
  const name = slugify(draft.name) || "worker";
  return [
    "/newworker",
    "Create this worker with the existing /newworker command.",
    "Write worker.yaml. Do not invent a new file format.",
    `Name: ${name}`,
    `Company: ${slug}`,
    `Scope: ${draft.scope}`,
    `Description: ${draft.description}`,
    `Skills: ${draft.skills.join(", ")}`,
    `Tools: ${draft.tools.join(", ")}`,
    "Knowledge paths:",
    draft.knowledge,
  ].join("\n");
}

export function groupPolicies(rows: readonly PolicyDoc[]): { hard: PolicyDoc[]; soft: PolicyDoc[] } {
  return {
    hard: rows.filter((row) => row.enforcement === "hard"),
    soft: rows.filter((row) => row.enforcement === "soft"),
  };
}

/**
 * The row the inspector shows: the selected row when the current results hold
 * it, else the first result, else nothing (QA-102). Reading from the filtered
 * rows keeps a search with no matches from leaving an unrelated row and its
 * actions in the inspector.
 */
export function inspectedRow<T extends { path: string }>(
  rows: readonly T[],
  selected: string | null,
): T | null {
  return rows.find((row) => row.path === selected) ?? rows[0] ?? null;
}
