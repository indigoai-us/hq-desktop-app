/**
 * Live groups and folder grants for the company settings Groups and Grants
 * panes. Pure: no Svelte, no Tauri.
 *
 * Groups come from hq-pro GET /secrets/{companyUid}/groups. Grants come from
 * GET /files/{companyUid}/acl/tree, read once per top-level folder because a
 * large company's whole tree is over the server's response budget. A folder
 * that is still over budget is paged (limit/cursor) when the server allows
 * it, and is reported as too large when it does not. A failed folder never
 * reads as "no grants".
 */

import type { AdapterResult, Json } from "@hq/platform";
import type { CompanyGroup, GrantKind, PathGrant } from "./company-settings.js";

export type ReadTree = (
  companyUid: string,
  prefix: string,
  page?: { limit: number; cursor?: string },
) => Promise<AdapterResult<Json>>;

/** Server codes from hq-pro handleAclTree. */
export const TREE_TOO_LARGE = "ACL_TREE_RESPONSE_TOO_LARGE";
export const TREE_PAGING_DISABLED = "ACL_TREE_PAGINATION_DISABLED";
export const TREE_PAGE_LIMIT = 200;
/** 200 pages of 200 rows: 40,000 grants under one top-level folder. */
export const TREE_MAX_PAGES = 200;

/** Fallback when the company folder is not on this Mac. */
export const DEFAULT_TOP_FOLDERS = [
  "agents",
  "data",
  "knowledge",
  "meetings",
  "policies",
  "projects",
  "signals",
  "skills",
  "sources",
  "workers",
] as const;

/** Section key for grants made on the whole vault ("*"). */
export const WHOLE_COMPANY = "*";

interface WireEntry {
  granteeType?: unknown;
  granteeId?: unknown;
  permission?: unknown;
  grantedBy?: unknown;
  grantedAt?: unknown;
  expiresAt?: unknown;
  sourcePrefix?: unknown;
}

interface WireIdentity {
  type?: unknown;
  name?: unknown;
  email?: unknown;
}

type Level = PathGrant["level"];
const RANK: Record<Level, number> = { read: 1, write: 2, admin: 3 };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asLevel(v: unknown): Level | null {
  return v === "read" || v === "write" || v === "admin" ? v : null;
}

/** Groups from GET /secrets/{companyUid}/groups. Rows without an id are dropped. */
export function groupsFromBody(body: unknown): CompanyGroup[] {
  const list = body && typeof body === "object" ? (body as { groups?: unknown }).groups : null;
  if (!Array.isArray(list)) throw new Error("groups response did not parse");
  const out: CompanyGroup[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = str(g.groupId);
    if (!id) continue;
    const members = Array.isArray(g.members) ? g.members : null;
    const memberCount =
      typeof g.memberCount === "number" && Number.isFinite(g.memberCount)
        ? g.memberCount
        : members
          ? members.length
          : null;
    out.push({
      id,
      name: str(g.name) || id,
      description: str(g.description),
      members: [],
      memberCount,
      paths: [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Group id for a typed name, the way the web console derives one: lower case,
 * runs of anything else become "-", with the `grp_` prefix hq-pro stores.
 */
export function groupIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `grp_${slug || "group"}`;
}

/** Why a typed name cannot be created, or null when it can be sent. */
export function newGroupNameProblem(name: string, existing: readonly CompanyGroup[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a group name.";
  const id = groupIdFromName(trimmed);
  const lower = trimmed.toLowerCase();
  if (existing.some((g) => g.id === id || g.name.trim().toLowerCase() === lower)) {
    return "A group with this name already exists. Choose another name.";
  }
  return null;
}

/**
 * The group a POST /secrets/{companyUid}/groups answer created. Falls back to
 * what was sent when the body does not carry the group.
 */
export function createdGroupFromBody(
  body: unknown,
  sent: { groupId: string; name: string; description?: string },
): CompanyGroup {
  const raw = body && typeof body === "object" ? (body as { group?: unknown }).group : null;
  try {
    const [group] = groupsFromBody({ groups: raw ? [raw] : [] });
    if (group) return { ...group, memberCount: group.memberCount ?? 0 };
  } catch {
    // Fall through to what was sent.
  }
  return {
    id: sent.groupId,
    name: sent.name,
    description: sent.description ?? "",
    members: [],
    memberCount: 0,
    paths: [],
  };
}

/** Plain sentence for a failed group create. Server text is never shown. */
export function createGroupFailureMessage(failure: { code?: string; status?: number }): string {
  const status = failure.status ?? (failure.code?.startsWith("http-") ? Number(failure.code.slice(5)) : NaN);
  if (status === 409) return "A group with this name already exists. Choose another name.";
  if (status === 403) return "Only the owner, or an admin the owner allows, can create groups.";
  return "Could not create the group. Try again.";
}

/** Top-level section a grant path belongs to. */
export function topFolderOf(path: string): string {
  if (!path || path === "*" || path === "/*") return WHOLE_COMPANY;
  const first = path.split("/")[0] ?? "";
  return first && first !== "*" ? first : WHOLE_COMPANY;
}

/** Agents sign in with an `agt-…@…` mailbox; those email grants are bots. */
function isAgentEmail(email: string): boolean {
  return /^agt[-_]/i.test(email);
}

function expiryOf(raw: unknown, now: number): { expiry: string; expiring: boolean } {
  const iso = str(raw);
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return { expiry: "No expiry", expiring: false };
  const days = (t - now) / 86_400_000;
  const label = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { expiry: days < 0 ? `Expired ${label}` : label, expiring: days >= 0 && days <= 7 };
}

export interface TreeMapContext {
  groupNames: Map<string, string>;
  now?: number;
}

/**
 * Grant rows from one acl/tree body. Direct entries sit on the asked prefix;
 * inherited and children carry their own sourcePrefix. The folder row's
 * creator is listed as admin, the way the server resolves it.
 */
export function grantsFromTree(body: unknown, ctx: TreeMapContext): PathGrant[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("acl tree did not parse");
  const b = body as Record<string, unknown>;
  const asked = str(b.prefix);
  const identities = (b.identities && typeof b.identities === "object" ? b.identities : {}) as Record<string, WireIdentity>;
  const now = ctx.now ?? Date.now();
  const out: PathGrant[] = [];

  const nameOf = (uid: string): string | null => {
    const who = identities[uid];
    return str(who?.name) || str(who?.email) || null;
  };

  const push = (e: WireEntry, path: string) => {
    const level = asLevel(e.permission);
    if (!level || !path) return;
    const type = str(e.granteeType);
    const gid = str(e.granteeId);
    let kind: GrantKind;
    let principal: string;
    let detail = "";
    if (type === "person") {
      const who = identities[gid];
      const bot = who?.type === "agent" || gid.startsWith("agt_");
      kind = bot ? "agent" : "person";
      principal = str(who?.name) || str(who?.email) || (bot ? "A bot" : "A teammate");
      detail = bot ? "Bot" : str(who?.name) && str(who?.email) ? str(who?.email) : "";
    } else if (type === "group") {
      kind = "group";
      principal = ctx.groupNames.get(gid) ?? gid;
      detail = "Group";
    } else if (type === "email") {
      kind = isAgentEmail(gid) ? "agent" : "guest";
      principal = gid;
      detail = kind === "agent" ? "Bot" : "Not a member yet";
    } else if (type === "company-wide") {
      kind = "group";
      principal = "Everyone in the company";
      detail = "Company-wide";
    } else if (type === "app") {
      kind = "agent";
      principal = "An app";
      detail = "App";
    } else {
      return;
    }
    const by = str(e.grantedBy);
    out.push({
      id: `${path}|${type}|${gid}`,
      principal,
      detail,
      kind,
      path,
      level,
      granteeId: gid,
      ...expiryOf(e.expiresAt, now),
      grantedBy: by ? (nameOf(by) ?? "") : "",
    });
  };

  for (const e of (Array.isArray(b.direct) ? b.direct : []) as WireEntry[]) push(e, asked);
  for (const e of (Array.isArray(b.inherited) ? b.inherited : []) as WireEntry[]) push(e, str(e.sourcePrefix));
  for (const e of (Array.isArray(b.children) ? b.children : []) as WireEntry[]) push(e, str(e.sourcePrefix));

  const row = (b.directRow && typeof b.directRow === "object" ? b.directRow : null) as { creatorUid?: unknown } | null;
  const creator = str(row?.creatorUid);
  if (creator && asked) {
    const who = identities[creator];
    const bot = who?.type === "agent" || creator.startsWith("agt_");
    out.push({
      id: `${asked}|creator|${creator}`,
      principal: nameOf(creator) ?? (bot ? "A bot" : "A teammate"),
      detail: "Created this folder",
      kind: bot ? "agent" : "person",
      path: asked,
      level: "admin",
      expiry: "No expiry",
      expiring: false,
      grantedBy: "",
    });
  }
  return out;
}

/** One row per path and grantee, at its highest level. */
export function mergeGrants(into: Map<string, PathGrant>, rows: readonly PathGrant[]): void {
  for (const row of rows) {
    const prev = into.get(row.id);
    if (!prev || RANK[row.level] > RANK[prev.level]) into.set(row.id, row);
  }
}

export type FolderStatus = "ok" | "too-large" | "failed";

export interface FolderRead {
  folder: string;
  status: FolderStatus;
  /** Plain reason for a folder that did not read. */
  note: string | null;
}

export interface GrantsRead {
  grants: PathGrant[];
  folders: FolderRead[];
}

function failed(res: AdapterResult<Json>): res is Extract<AdapterResult<Json>, { ok: false }> {
  return !res.ok;
}

function isTooLarge(res: AdapterResult<Json>): boolean {
  return failed(res) && (res.code === TREE_TOO_LARGE || res.code === "http-413");
}

/** Read one top-level folder: whole first, then paged if it is over budget. */
export async function readFolderGrants(
  readTree: ReadTree,
  companyUid: string,
  folder: string,
  ctx: TreeMapContext,
): Promise<{ rows: PathGrant[]; read: FolderRead }> {
  const prefix = folder === WHOLE_COMPANY ? "*" : `${folder}/*`;
  const whole = await readTree(companyUid, prefix);
  if (whole.ok) return { rows: grantsFromTree(whole.value, ctx), read: { folder, status: "ok", note: null } };
  if (!isTooLarge(whole)) {
    console.warn("[settings] grants read failed", { folder, code: whole.code, message: whole.message });
    return { rows: [], read: { folder, status: "failed", note: "Could not read this folder's grants." } };
  }
  const rows: PathGrant[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < TREE_MAX_PAGES; page += 1) {
    const res = await readTree(companyUid, prefix, { limit: TREE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    if (failed(res)) {
      if (res.code === TREE_PAGING_DISABLED || isTooLarge(res)) {
        return { rows: [], read: { folder, status: "too-large", note: "Too many grants to read here yet." } };
      }
      console.warn("[settings] grants page failed", { folder, page, code: res.code, message: res.message });
      return { rows: [], read: { folder, status: "failed", note: "Could not read this folder's grants." } };
    }
    rows.push(...grantsFromTree(res.value, ctx));
    const next = (res.value as { nextCursor?: unknown } | null)?.nextCursor;
    if (typeof next !== "string" || !next) return { rows, read: { folder, status: "ok", note: null } };
    cursor = next;
  }
  return { rows, read: { folder, status: "too-large", note: `Showing the first ${TREE_MAX_PAGES * TREE_PAGE_LIMIT} grants.` } };
}

/**
 * Read every top-level folder, a few at a time. Grants on the whole vault
 * come back as inherited entries on every folder and are merged once.
 */
export async function readCompanyGrants(opts: {
  readTree: ReadTree;
  companyUid: string;
  folders: readonly string[];
  ctx: TreeMapContext;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<GrantsRead> {
  const folders = [...new Set(opts.folders.filter((f) => f && f !== WHOLE_COMPANY))];
  const merged = new Map<string, PathGrant>();
  const reads: FolderRead[] = new Array(folders.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < folders.length) {
      const i = next;
      next += 1;
      const { rows, read } = await readFolderGrants(opts.readTree, opts.companyUid, folders[i]!, opts.ctx);
      mergeGrants(merged, rows);
      reads[i] = read;
      done += 1;
      opts.onProgress?.(done, folders.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, folders.length)) }, worker));
  return { grants: [...merged.values()], folders: reads };
}

export interface GrantSection {
  folder: string;
  total: number;
  counts: Record<GrantKind, number>;
  grants: PathGrant[];
}

/** Grants grouped by top-level folder, whole-company first, then by size. */
export function grantSections(grants: readonly PathGrant[]): GrantSection[] {
  const map = new Map<string, GrantSection>();
  for (const g of grants) {
    const folder = topFolderOf(g.path);
    let s = map.get(folder);
    if (!s) {
      s = { folder, total: 0, counts: { person: 0, group: 0, agent: 0, guest: 0 }, grants: [] };
      map.set(folder, s);
    }
    s.total += 1;
    s.counts[g.kind] += 1;
    s.grants.push(g);
  }
  for (const s of map.values()) s.grants.sort((a, b) => a.path.localeCompare(b.path) || a.principal.localeCompare(b.principal));
  return [...map.values()].sort((a, b) =>
    a.folder === WHOLE_COMPANY ? -1 : b.folder === WHOLE_COMPANY ? 1 : b.total - a.total || a.folder.localeCompare(b.folder),
  );
}

export interface GroupGrantSummary {
  total: number;
  byLevel: Record<Level, number>;
  folders: string[];
}

/** What each group is granted, by group id. */
export function groupGrantSummaries(grants: readonly PathGrant[]): Map<string, GroupGrantSummary> {
  const out = new Map<string, GroupGrantSummary>();
  for (const g of grants) {
    if (g.kind !== "group" || g.detail !== "Group") continue;
    const gid = g.granteeId ?? "";
    if (!gid) continue;
    let s = out.get(gid);
    if (!s) {
      s = { total: 0, byLevel: { read: 0, write: 0, admin: 0 }, folders: [] };
      out.set(gid, s);
    }
    s.total += 1;
    s.byLevel[g.level] += 1;
    const top = topFolderOf(g.path);
    if (!s.folders.includes(top)) s.folders.push(top);
  }
  for (const s of out.values()) s.folders.sort();
  return out;
}

/** Last good live reads per company uid; the panes paint these first. */
const groupsCache = new Map<string, CompanyGroup[]>();
const grantsCache = new Map<string, GrantsRead>();

export function cachedGroups(companyUid: string): CompanyGroup[] | null {
  return groupsCache.get(companyUid) ?? null;
}
export function cacheGroups(companyUid: string, groups: CompanyGroup[]): void {
  groupsCache.set(companyUid, groups);
}
export function cachedGrants(companyUid: string): GrantsRead | null {
  return grantsCache.get(companyUid) ?? null;
}
export function cacheGrants(companyUid: string, read: GrantsRead): void {
  grantsCache.set(companyUid, read);
}

/** Top-level folder names from a listDir of the company folder. */
export function topFoldersFromListing(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const { name, isDir } = e as { name?: unknown; isDir?: unknown };
    // hq-pro's validatePrefix refuses a `companies/` prefix inside a company vault.
    if (isDir !== true || typeof name !== "string" || !name || name.startsWith(".") || name === "companies") continue;
    out.push(name);
  }
  return out.sort();
}
