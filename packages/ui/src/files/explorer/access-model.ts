/**
 * OWNER-R17: who can open a focused vault file or folder.
 *
 * Reads the hq-pro access tree (GET /files/{companyUid}/acl/tree, the read
 * the web console's access panel uses) and turns it into plain rows: a name
 * (never an id), a level, and the reason in the console's words. Pure: no
 * Svelte, no Tauri.
 */

import type { PersonIdentity } from "../../common/people/people.js";
import type { Vault } from "./vault-model.js";

export type AccessLevel = "read" | "write" | "admin";

export interface AccessRow {
  key: string;
  kind: "person" | "bot" | "group" | "email" | "company" | "owner";
  name: string;
  /** Muted secondary line (an email), never an id. */
  detail: string | null;
  /** People and bots, for the shared name display (OWNER-R5). */
  person: PersonIdentity | null;
  level: AccessLevel;
  levelLabel: string;
  reason: string;
}

export interface AccessView {
  rows: AccessRow[];
  /** The nearest parent folder access is inherited from, company-relative. */
  inheritedFrom: string | null;
  /** True when the caller can grant on this path (admin on it). */
  canGrant: boolean;
}

/** What the Access section is asked about. */
export type AccessTarget =
  | { kind: "local"; path: string }
  | { kind: "personal-unshared"; path: string }
  | {
      kind: "vault";
      path: string;
      isDir: boolean;
      companyUid: string;
      /** The ACL prefix: company-relative, folders end in "/". */
      prefix: string;
      /** HQ-relative root of the vault, to turn a source prefix back into a path. */
      root: string;
    };

interface WireEntry {
  granteeType?: unknown;
  granteeId?: unknown;
  permission?: unknown;
  sourcePrefix?: unknown;
}

interface WireIdentity {
  uid?: unknown;
  type?: unknown;
  name?: unknown;
  email?: unknown;
  slug?: unknown;
}

const LEVEL_RANK: Record<AccessLevel, number> = { read: 1, write: 2, admin: 3 };

export function levelLabel(level: AccessLevel): string {
  return level === "admin" ? "Admin" : level === "write" ? "Read and write" : "Read";
}

function asLevel(v: unknown): AccessLevel | null {
  return v === "read" || v === "write" || v === "admin" ? v : null;
}

/** HQ top-level folders in the personal vault that never sync. */
const LOCAL_ONLY_TOP = new Set([".claude", ".agents", ".codex", ".obsidian", "core", "workspace", "repos", "docs", "sync-manifests"]);

/** Company-relative ACL prefix for a vault path; folders end in "/". */
export function accessPrefix(vault: Vault, path: string, isDir: boolean): string {
  const rel = vault.kind === "company" && path.startsWith(`${vault.root}/`) ? path.slice(vault.root.length + 1) : path;
  const clean = rel.replace(/\/+$/, "");
  return isDir ? `${clean}/` : clean;
}

/**
 * Decide what to ask for a focused item. `companyUid` is the vault's cloud
 * uid (company, or the person's own vault); null means the vault is not in
 * the cloud, so the item is on this Mac only.
 */
export function accessTargetFor(
  vault: Vault,
  path: string,
  isDir: boolean,
  companyUid: string | null,
): AccessTarget {
  if (vault.kind === "personal") {
    const top = path.split("/")[0] ?? "";
    if (LOCAL_ONLY_TOP.has(top) || top.endsWith(".md") && !path.includes("/")) {
      return { kind: "local", path };
    }
  }
  if (!companyUid) return { kind: "local", path };
  return { kind: "vault", path, isDir, companyUid, prefix: accessPrefix(vault, path, isDir), root: vault.root };
}

/** Group names by id from GET /secrets/{companyUid}/groups. */
export function groupNames(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = body && typeof body === "object" ? (body as { groups?: unknown }).groups : null;
  if (!Array.isArray(list)) return out;
  for (const g of list) {
    if (!g || typeof g !== "object") continue;
    const { groupId, name } = g as { groupId?: unknown; name?: unknown };
    if (typeof groupId === "string" && typeof name === "string" && name.trim()) out.set(groupId, name.trim());
  }
  return out;
}

function folderOfPrefix(prefix: string): string {
  return prefix.replace(/\/?\*$/, "").replace(/\/+$/, "");
}

/**
 * Rows from an access tree body. One row per person, bot, group, email or
 * company-wide grant, at its highest level; direct grants win the reason.
 * Owners always reach everything, so they lead the list.
 */
export function accessView(body: unknown, groups: Map<string, string> = new Map()): AccessView {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const direct = Array.isArray(b.direct) ? (b.direct as WireEntry[]) : [];
  const inherited = Array.isArray(b.inherited) ? (b.inherited as WireEntry[]) : [];
  const identities = (b.identities && typeof b.identities === "object" ? b.identities : {}) as Record<string, WireIdentity>;
  const directRow = (b.directRow && typeof b.directRow === "object" ? b.directRow : null) as { creatorUid?: unknown; open?: unknown } | null;

  const rows = new Map<string, AccessRow>();
  const put = (row: AccessRow) => {
    const prev = rows.get(row.key);
    if (!prev || LEVEL_RANK[row.level] > LEVEL_RANK[prev.level]) rows.set(row.key, row);
  };

  rows.set("owner", {
    key: "owner",
    kind: "owner",
    name: "Company owners",
    detail: null,
    person: null,
    level: "admin",
    levelLabel: levelLabel("admin"),
    reason: "Owner of this company",
  });

  const add = (entry: WireEntry, fromParent: boolean) => {
    const level = asLevel(entry.permission);
    const type = entry.granteeType;
    const id = typeof entry.granteeId === "string" ? entry.granteeId : "";
    if (!level) return;
    if (type === "person") {
      const who = identities[id];
      const name = typeof who?.name === "string" && who.name.trim() ? who.name.trim() : null;
      const email = typeof who?.email === "string" && who.email.trim() ? who.email.trim() : null;
      const isBot = who?.type === "agent" || id.startsWith("agt_");
      // Never an id: a person with no name shows their email; with neither, a plain label.
      const shown = name ?? email ?? (isBot ? "A bot" : "A teammate");
      const detail = isBot ? "Bot" : name && email ? email : null;
      put({
        key: `person:${id}`,
        kind: isBot ? "bot" : "person",
        name: shown,
        detail,
        person: { key: `person:${id}`, kind: isBot ? "agent" : "human", name: shown, detail, resolved: Boolean(name ?? email) },
        level,
        levelLabel: levelLabel(level),
        reason: fromParent ? "via the parent folder" : "granted directly",
      });
    } else if (type === "group") {
      const name = groups.get(id);
      put({
        key: `group:${id}`,
        kind: "group",
        name: name ? `Group ${name}` : "A group",
        detail: null,
        person: null,
        level,
        levelLabel: levelLabel(level),
        reason: name ? `via group ${name}` : "via a group",
      });
    } else if (type === "email") {
      put({ key: `email:${id}`, kind: "email", name: id, detail: null, person: null, level, levelLabel: levelLabel(level), reason: "granted by email" });
    } else if (type === "company-wide") {
      put({ key: "company", kind: "company", name: "Everyone in the company", detail: null, person: null, level, levelLabel: levelLabel(level), reason: "shared company-wide" });
    }
  };
  for (const e of direct) add(e, false);
  for (const e of inherited) add(e, true);

  if (directRow?.open === true) {
    put({ key: "company", kind: "company", name: "Everyone in the company", detail: null, person: null, level: "read", levelLabel: levelLabel("read"), reason: "open to everyone" });
  }
  const creator = typeof directRow?.creatorUid === "string" ? directRow.creatorUid : "";
  if (creator) {
    const who = identities[creator];
    const name = typeof who?.name === "string" && who.name.trim() ? who.name.trim() : typeof who?.email === "string" ? who.email : null;
    if (name && !rows.has(`person:${creator}`)) {
      const isBot = who?.type === "agent" || creator.startsWith("agt_");
      const detail = isBot ? "Bot" : typeof who?.email === "string" && who.email !== name ? who.email : null;
      put({
        key: `person:${creator}`,
        kind: isBot ? "bot" : "person",
        name,
        detail,
        person: { key: `person:${creator}`, kind: isBot ? "agent" : "human", name, detail, resolved: true },
        level: "admin",
        levelLabel: levelLabel("admin"),
        reason: "they created it",
      });
    }
  }

  // The nearest ancestor that grants anything is where access is inherited from.
  let inheritedFrom: string | null = null;
  for (const e of inherited) {
    if (typeof e.sourcePrefix !== "string") continue;
    const folder = folderOfPrefix(e.sourcePrefix);
    if (inheritedFrom === null || folder.length > inheritedFrom.length) inheritedFrom = folder;
  }

  return { rows: [...rows.values()], inheritedFrom, canGrant: b.effectivePermission === "admin" };
}

/** HQ-relative path of an inherited source folder ("" is the vault root). */
export function inheritedPath(root: string, folder: string): string {
  if (!folder) return root;
  return root ? `${root}/${folder}` : folder;
}

/** Per-path cache of the last good read; refreshed in the background. */
export class AccessCache {
  private map = new Map<string, AccessView>();
  key(t: { companyUid: string; prefix: string }): string {
    return `${t.companyUid}|${t.prefix}`;
  }
  get(t: { companyUid: string; prefix: string }): AccessView | null {
    return this.map.get(this.key(t)) ?? null;
  }
  set(t: { companyUid: string; prefix: string }, v: AccessView): void {
    this.map.set(this.key(t), v);
  }
}

export const accessCache = new AccessCache();
