/**
 * Company display-name map from the caller's live memberships.
 *
 * Mesh / PROJECT_VIEW rows only carry `companyUid`. Names live on the
 * membership roster (`GET /membership/me`) so a rename updates every
 * surface without rewriting cached project documents.
 */

import type { Workspace } from "../chat/workspaces.js";

const COMPANY_UID = /^(cmp|co)_[A-Za-z0-9]+$/i;

export function looksLikeCompanyUid(value: string | null | undefined): boolean {
  return Boolean(value && COMPANY_UID.test(value.trim()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readableName(value: unknown): string | null {
  const label = str(value);
  if (!label || looksLikeCompanyUid(label)) return null;
  return label;
}

/** Accept a membership array or a `{ memberships | companies | workspaces }` envelope. */
export function membershipRowsFrom(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter(isRecord);
  }
  if (!isRecord(raw)) return [];
  for (const key of ["memberships", "companies", "workspaces"] as const) {
    if (Array.isArray(raw[key])) {
      return raw[key].filter(isRecord);
    }
  }
  return [];
}

/**
 * uid + slug → display name. Never stores a raw `cmp_` / `co_` id as the
 * label. Missing names are omitted so callers can fall back to "Company".
 */
export function buildCompanyDisplayMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const add = (key: string, name: string | null) => {
    if (key && name) map.set(key, name);
  };
  for (const row of membershipRowsFrom(raw)) {
    const uid = str(row.companyUid) || str(row.cloudUid) || str(row.uid);
    const slug = str(row.companySlug) || str(row.slug);
    const name =
      readableName(row.companyName) ||
      readableName(row.displayName) ||
      readableName(row.name) ||
      readableName(slug);
    add(uid, name);
    add(slug, name);
  }
  return map;
}

/**
 * uid + slug → presigned company icon url.
 *
 * Mirrors `buildCompanyDisplayMap`: mesh/PROJECT_VIEW rows only carry a
 * `companyUid`, so the icon (like the name) is resolved from the membership
 * roster. Only the server's presigned `iconUrl` is accepted — the durable
 * `brand.faviconUrl` API path is deliberately ignored because the packaged CSP
 * cannot paint it (see `companyIconSrc`).
 */
export function buildCompanyIconMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const add = (key: string, icon: string) => {
    if (key && icon) map.set(key, icon);
  };
  for (const row of membershipRowsFrom(raw)) {
    const uid = str(row.companyUid) || str(row.cloudUid) || str(row.uid);
    const slug = str(row.companySlug) || str(row.slug);
    const icon = str(row.iconUrl);
    if (!icon) continue;
    add(uid, icon);
    add(slug, icon);
  }
  return map;
}

/** Presigned company icon for a uid/slug, or null when there is none. */
export function companyIconUrl(
  companyUid: string | null | undefined,
  icons: Map<string, string>,
  fallback?: string | null,
): string | null {
  const key = companyUid?.trim();
  if (key) {
    const hit = icons.get(key);
    if (hit) return hit;
  }
  return fallback?.trim() || null;
}

export function companyDisplayName(
  companyUid: string | null | undefined,
  names: Map<string, string>,
  fallback?: string | null,
): string | null {
  const key = companyUid?.trim();
  if (key) {
    const hit = names.get(key);
    if (hit) return hit;
  }
  const fb = fallback?.trim();
  if (fb && !looksLikeCompanyUid(fb)) return fb;
  return null;
}

const WORKSPACE_KINDS = new Set(["personal", "company"]);
const WORKSPACE_STATES = new Set([
  "personal",
  "synced",
  "cloud-only",
  "local-only",
  "broken",
]);

function optStr(value: unknown): string | null {
  const s = str(value);
  return s || null;
}

/**
 * True when `row` is already a `Workspace` from `list_syncable_workspaces`
 * (it carries a `kind`), as opposed to a bare membership row from
 * `GET /membership/me` (which never does).
 */
function isWorkspaceRow(row: Record<string, unknown>): boolean {
  return WORKSPACE_KINDS.has(str(row.kind).toLowerCase());
}

/**
 * Turn membership rows into the Workspace list the shell already consumes.
 *
 * Two shapes arrive here and they must NOT be treated alike:
 *
 * - Membership rows (`GET /membership/me`) know nothing about local state, so
 *   they are synthesized as an active, synced company — that is all a
 *   membership can mean.
 * - Real `Workspace` rows (`list_syncable_workspaces`) already carry `kind`,
 *   `state` and `membershipStatus`. Those pass through INTACT. Flattening them
 *   to "active company" was a real bug: the personal vault (kind `personal`,
 *   displayName = the person's own name, sorted first) came out as an active
 *   company named after the user, became the default "In" target of the
 *   create modal, and the server refused it with "not an active member".
 */
export function workspacesFromMembershipRows(raw: unknown): Workspace[] {
  const seen = new Set<string>();
  const out: Workspace[] = [];
  for (const row of membershipRowsFrom(raw)) {
    const uid = str(row.companyUid) || str(row.cloudUid) || str(row.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const slug = str(row.companySlug) || str(row.slug) || uid;
    const displayName =
      readableName(row.companyName) ||
      readableName(row.displayName) ||
      readableName(row.name) ||
      readableName(row.companySlug) ||
      readableName(row.slug) ||
      "Company";

    if (isWorkspaceRow(row)) {
      const kind = str(row.kind).toLowerCase() as Workspace["kind"];
      const rawState = str(row.state).toLowerCase();
      const state = (
        WORKSPACE_STATES.has(rawState)
          ? rawState
          : kind === "personal"
            ? "personal"
            : "synced"
      ) as Workspace["state"];
      out.push({
        slug,
        displayName,
        kind,
        state,
        cloudUid: uid,
        bucketName: optStr(row.bucketName),
        hasLocalFolder: row.hasLocalFolder === true,
        localPath: optStr(row.localPath),
        // Preserve null: for a real workspace row "unknown" is a fact, not
        // something to paper over with "active".
        membershipStatus: optStr(row.membershipStatus) ?? optStr(row.status),
        role: optStr(row.role),
        ...(typeof row.syncEnabled === "boolean"
          ? { syncEnabled: row.syncEnabled }
          : {}),
        lastSyncedAt: optStr(row.lastSyncedAt),
        brokenReason: optStr(row.brokenReason),
        invitedBy: optStr(row.invitedBy),
        invitedAt: optStr(row.invitedAt),
        ...(typeof row.brandingEnabled === "boolean"
          ? { brandingEnabled: row.brandingEnabled }
          : {}),
        ...(isRecord(row.brand) || row.brand === null
          ? { brand: row.brand as Workspace["brand"] }
          : {}),
        ...(optStr(row.iconUrl) ? { iconUrl: optStr(row.iconUrl) } : {}),
      });
      continue;
    }

    out.push({
      slug,
      displayName,
      kind: "company",
      state: "synced",
      cloudUid: uid,
      bucketName: optStr(row.bucketName),
      hasLocalFolder: false,
      localPath: null,
      membershipStatus: str(row.status) || "active",
      role: typeof row.role === "string" ? row.role : null,
      lastSyncedAt: null,
      brokenReason: null,
      invitedBy: null,
      invitedAt: null,
      // Membership rows from GET /membership/me carry the every-plan company
      // brand + icon; dropping them here would leave the switcher and header
      // without an icon on the web/HQ-Work path.
      ...(isRecord(row.brand) || row.brand === null
        ? { brand: row.brand as Workspace["brand"] }
        : {}),
      ...(optStr(row.iconUrl) ? { iconUrl: optStr(row.iconUrl) } : {}),
    });
  }
  return out;
}
