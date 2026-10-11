/**
 * Settings > Storage visibility gate (hq-flags key `hq-storage`).
 *
 * Owner decision (Corey, 2026-10-11): ship Storage behind a flag for Indigo
 * users only. That holds the default-on kill-switch rule: the row is
 * `defaultValue: false` with a company override for Indigo, so this is an
 * ALLOWLIST and it FAILS CLOSED. Anything other than a configured `true`
 * hides the entry and the page: signed out, no memberships, a failed
 * membership read, a missing / archived / unreadable row, or a thrown read.
 *
 * Same rule as `hq storage` in hq-cli: Storage is on for the signed-in person
 * when the flag resolves true for any company they are an active member of.
 * A company override only fires when the read names that company, so each
 * membership is read with `hasCompanyFeature` (the app's existing company
 * flag path); hq-pro only answers for companies the caller belongs to.
 *
 * The CLI also refuses with `{"code":"feature_disabled"}` when the flag is off
 * for the caller; the Rust bridge maps that to `STORAGE_FEATURE_DISABLED_CODE`
 * and the pane hides itself (`isStorageFeatureDisabled`).
 */
import { HQ_STORAGE_FLAG } from "@hq/platform";

export { HQ_STORAGE_FLAG };

/** Error code the Rust storage bridge returns for the CLI `feature_disabled` refusal. */
export const STORAGE_FEATURE_DISABLED_CODE = "storage-feature-disabled";

const COMPANY_UID_RE = /^cmp_[A-Za-z0-9]{3,128}$/;

type StorageFeatureIdentity = {
  listWorkspaces?: () => Promise<{ ok: boolean; value?: unknown }>;
  hasCompanyFeature?: (flag: string, companyUid: string) => Promise<boolean>;
};

function activeCompanyUids(rows: unknown): string[] {
  const uids = new Set<string>();
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    // Desktop rows carry `membershipStatus` / `cloudUid`; web membership rows
    // carry `status` / `companyUid`. A pending invite is not a membership.
    const status = row.membershipStatus ?? row.status;
    if (typeof status === "string" && status !== "active") continue;
    const uid = row.companyUid ?? row.cloudUid;
    if (typeof uid === "string" && COMPANY_UID_RE.test(uid.trim())) uids.add(uid.trim());
  }
  return [...uids];
}

/** True only when `hq-storage` resolves true for one of the person's companies. Never rejects. */
export async function resolveStorageFeature(
  identity: StorageFeatureIdentity | null | undefined,
): Promise<boolean> {
  try {
    if (!identity?.listWorkspaces || !identity.hasCompanyFeature) return false;
    const res = await identity.listWorkspaces();
    if (!res?.ok) return false;
    const uids = activeCompanyUids(res.value);
    if (uids.length === 0) return false;
    const read = identity.hasCompanyFeature.bind(identity);
    const answers = await Promise.all(
      uids.map((uid) => read(HQ_STORAGE_FLAG, uid).then((value) => value === true, () => false)),
    );
    return answers.some(Boolean);
  } catch {
    return false;
  }
}

/** True when a storage call failed because the CLI says the feature is off. */
export function isStorageFeatureDisabled(message: string | null | undefined): boolean {
  return typeof message === "string" && message.includes(STORAGE_FEATURE_DISABLED_CODE);
}
