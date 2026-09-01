/**
 * Account/company-scoped renderer persistence.
 *
 * There is intentionally no legacy-key fallback: a global cache has no proven
 * owner, so reading it during migration would be a cross-tenant disclosure.
 */

export interface TenantStorageScope {
  accountId: string | null | undefined;
  companyId: string | null | undefined;
}

type StorageReadWrite = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "hq.work.tenant.v1";

function segment(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalized(scope: TenantStorageScope): { accountId: string; companyId: string } | null {
  const accountId = scope.accountId?.trim() ?? "";
  const companyId = scope.companyId?.trim() || "all";
  return accountId ? { accountId, companyId } : null;
}

export function tenantStorageKey(scope: TenantStorageScope, key: string): string {
  const current = normalized(scope);
  if (!current) return "";
  return `${PREFIX}.${segment(current.accountId)}.${segment(current.companyId)}.${key}`;
}

/**
 * A no-fallback Storage facade. Calls made before native has established a
 * stable account are safe no-ops; callers therefore cannot accidentally claim
 * data from a former global key while a new session is still loading.
 */
export function createTenantStorage(
  storage: StorageReadWrite | null | undefined,
  scope: TenantStorageScope,
): StorageReadWrite {
  const scopedKey = (key: string) => tenantStorageKey(scope, key);
  return {
    getItem(key) {
      const next = scopedKey(key);
      if (!next || !storage) return null;
      try {
        return storage.getItem(next);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      const next = scopedKey(key);
      if (!next || !storage) return;
      try {
        storage.setItem(next, value);
      } catch {
        // Private mode / quota does not affect the tenant boundary.
      }
    },
    removeItem(key) {
      const next = scopedKey(key);
      if (!next || !storage) return;
      try {
        storage.removeItem(next);
      } catch {
        // Best-effort persistence cleanup only.
      }
    },
  };
}
