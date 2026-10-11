/**
 * Settings → Companies row model. Pure so the pane's storage/role/sync
 * decisions are testable without mounting Svelte.
 *
 * Backends this reads from (no new sync model):
 *  - `list_syncable_workspaces` (`Workspace.state`) for local-only vs cloud.
 *  - `get_sync_mode` / `set_sync_mode` for the per-company download footprint
 *    (`all` | `shared`; `custom` is CLI-only).
 *  - `connect_workspace_to_cloud` (`hq cloud provision company <slug>`) to
 *    convert a local-only company into a cloud vault.
 */
import type { Workspace } from "../chat/workspaces.js";

export type CompanyStorage = "cloud" | "local" | "reconnect" | "invite";

export interface CompanySettingsRow {
  slug: string;
  name: string;
  /** Cloud company uid when one exists (opens the company pane). */
  uid: string | null;
  /** Display role ("Owner", "Member", …) or null when unknown. */
  role: string | null;
  storage: CompanyStorage;
  /** Cloud-backed and active: the Sync all / Sync shared choice applies. */
  canChooseSyncMode: boolean;
  /** Local-only or broken: offer Convert / Reconnect via connect_workspace_to_cloud. */
  canConvert: boolean;
  /** Owners and admins: shared mode never widens what downloads for them. */
  isOwnerOrAdmin: boolean;
}

export interface ProfileCompanyRole {
  uid: string;
  label: string;
  role: string | null;
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

export function storageLabel(storage: CompanyStorage): string {
  switch (storage) {
    case "cloud":
      return "Cloud vault";
    case "local":
      return "Local only";
    case "reconnect":
      return "Needs reconnect";
    case "invite":
      return "Invite";
  }
}

/**
 * One row per company (personal excluded), deduped by slug. Roles prefer the
 * membership-roster role the host already resolved for Profile, then the
 * workspace row's own role. Owners sort first, then by name.
 */
export function companySettingsRows(
  workspaces: ReadonlyArray<Workspace> | null | undefined,
  roles: ReadonlyArray<ProfileCompanyRole> = [],
): CompanySettingsRow[] {
  const roleByUid = new Map(roles.map((row) => [row.uid, row.role]));
  const seen = new Set<string>();
  const rows: CompanySettingsRow[] = [];
  for (const workspace of workspaces ?? []) {
    if (workspace.kind !== "company" || workspace.slug === "personal") continue;
    if (seen.has(workspace.slug)) continue;
    seen.add(workspace.slug);
    const uid = workspace.cloudUid?.trim() || null;
    const status = (workspace.membershipStatus ?? "").trim().toLowerCase();
    // Revoked or otherwise ended memberships are not this account's companies.
    if (!["", "active", "accepted", "pending"].includes(status)) continue;
    const pending = status === "pending";
    const storage: CompanyStorage = pending
      ? "invite"
      : workspace.state === "local-only"
        ? "local"
        : workspace.state === "broken"
          ? "reconnect"
          : "cloud";
    const rosterRole = uid ? roleByUid.get(uid) ?? null : null;
    const role = rosterRole ?? (workspace.role ? titleCase(workspace.role) : null);
    const roleKey = (role ?? "").toLowerCase();
    rows.push({
      slug: workspace.slug,
      name: workspace.displayName?.trim() || workspace.slug,
      uid,
      role,
      storage,
      canChooseSyncMode: storage === "cloud",
      canConvert: storage === "local" || storage === "reconnect",
      isOwnerOrAdmin: roleKey === "owner" || roleKey === "admin",
    });
  }
  return rows.sort((a, b) => {
    const ao = a.role === "Owner" ? 0 : 1;
    const bo = b.role === "Owner" ? 0 : 1;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
  });
}

/**
 * Run an action up to `tries` times with backoff. Returns the last result so
 * the caller keeps the raw error for logs only, never for display.
 */
export async function withRetry<T extends { ok: boolean }>(
  run: () => Promise<T>,
  { tries = 3, baseDelayMs = 600, sleep = defaultSleep }: {
    tries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  let last: T | null = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    try {
      last = await run();
    } catch (error) {
      console.warn("[settings/companies] attempt threw", error);
      last = { ok: false, message: String(error) } as unknown as T;
    }
    if (last.ok) return last;
  }
  return last as T;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
