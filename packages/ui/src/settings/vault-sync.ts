/**
 * Settings › Sync vault switches (usage-only-pricing US-016).
 *
 * One list: the personal vault and every company vault the person belongs to,
 * each with its own switch, plus one "Turn off all cloud sync" switch. The
 * host owns the saved values (the desktop settings file, so they survive
 * restarts and app updates, and the HQ CLI honours them). This module builds
 * the rows and holds the copy. It does no I/O.
 */

import type { VaultSyncSwitches } from "@hq/platform";
import type { Workspace } from "../chat/workspaces.js";

/** The `vault` id the host uses for the personal vault. */
export const PERSONAL_VAULT_ID = "personal";

export const VAULT_SYNC_COPY = {
  heading: "Cloud sync",
  intro:
    "Choose which vaults sync with HQ cloud from this computer. This only changes this computer. Teammates keep syncing.",
  allOffLabel: "Turn off all cloud sync",
  allOffDescription:
    "Turns sync off for every vault below. No more sync charges from this computer. Files stay on this computer. Teammates stop getting this computer's changes.",
  allOffTitle: "Cloud sync is off for every vault",
  allOffBody:
    "Nothing uploads or downloads on this computer. Sign-in, messages, deploys and local HQ keep working.",
  allOffHint: "To sync again, switch off Turn off all cloud sync.",
  personalName: "Personal vault",
  companyOffDescription:
    "Turn off: no more sync charges for this vault. Files stay on this computer. Teammates stop getting this computer's changes.",
  personalOffDescription:
    "Turn off: no more sync charges for this vault. Files stay on this computer. Your other computers stop getting this computer's changes.",
  vaultOffHint: "To sync it again, turn its switch back on.",
  heldByAllOff: "Off while all cloud sync is off.",
  noCompanies: "You are not in any company with a cloud vault yet.",
} as const;

/** "Sync is off for <vault>" — the plain off state for one vault. */
export function vaultOffTitle(name: string): string {
  return `Sync is off for ${name}`;
}

export interface VaultSyncRow {
  /** `"personal"` or the company slug, as the host expects. */
  id: string;
  name: string;
  personal: boolean;
  /** This vault's own switch. */
  enabled: boolean;
  /** What turning this switch off does, in plain words. */
  description: string;
}

/**
 * Company vaults the person can sync: a cloud vault (has a cloud id and is
 * not local only) with an accepted membership. Pending invites have nothing
 * to sync yet.
 */
function syncableCompanies(workspaces: ReadonlyArray<Workspace>): Workspace[] {
  const seen = new Set<string>();
  const out: Workspace[] = [];
  for (const w of workspaces) {
    if (w.kind !== "company" || !w.cloudUid) continue;
    if (w.state === "local-only") continue;
    const status = (w.membershipStatus ?? "").trim().toLowerCase();
    if (!["", "active", "accepted"].includes(status)) continue;
    if (w.slug === PERSONAL_VAULT_ID || seen.has(w.slug)) continue;
    seen.add(w.slug);
    out.push(w);
  }
  return out.sort((a, b) =>
    (a.displayName || a.slug).localeCompare(b.displayName || b.slug),
  );
}

/**
 * The personal row first, then one row per company vault. A company's value
 * comes from, in order: a switch moved in this session (`overrides`), the
 * host's saved switches, the workspace list's `syncEnabled`, then on.
 */
export function vaultSyncRows(
  workspaces: ReadonlyArray<Workspace> | null | undefined,
  switches: Pick<VaultSyncSwitches, "personalEnabled" | "companies"> | null,
  overrides: Readonly<Record<string, boolean>> = {},
): VaultSyncRow[] {
  const personalWs = (workspaces ?? []).find((w) => w.kind === "personal");
  const personalEnabled =
    overrides[PERSONAL_VAULT_ID] ??
    switches?.personalEnabled ??
    personalWs?.syncEnabled ??
    true;
  const rows: VaultSyncRow[] = [
    {
      id: PERSONAL_VAULT_ID,
      name: VAULT_SYNC_COPY.personalName,
      personal: true,
      enabled: personalEnabled,
      description: VAULT_SYNC_COPY.personalOffDescription,
    },
  ];
  for (const w of syncableCompanies(workspaces ?? [])) {
    rows.push({
      id: w.slug,
      name: w.displayName || w.slug,
      personal: false,
      enabled:
        overrides[w.slug] ?? switches?.companies?.[w.slug] ?? w.syncEnabled ?? true,
      description: VAULT_SYNC_COPY.companyOffDescription,
    });
  }
  return rows;
}
