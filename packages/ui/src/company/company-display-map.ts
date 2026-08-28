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

/** Turn membership rows into the Workspace list the shell already consumes. */
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
    out.push({
      slug,
      displayName,
      kind: "company",
      state: "synced",
      cloudUid: uid,
      bucketName: str(row.bucketName) || null,
      hasLocalFolder: false,
      localPath: null,
      membershipStatus: str(row.status) || "active",
      role: typeof row.role === "string" ? row.role : null,
      lastSyncedAt: null,
      brokenReason: null,
      invitedBy: null,
      invitedAt: null,
    });
  }
  return out;
}
