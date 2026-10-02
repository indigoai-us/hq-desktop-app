/**
 * The only door into the account pages chunk (US-035).
 * Call when Profile, Billing, or Settings mounts. The promise is memoized.
 */
type AccountModule = typeof import("../account/AccountPages.svelte");

let pending: Promise<AccountModule> | null = null;

export function loadAccountPages(): Promise<AccountModule> {
  pending ??= import("../account/AccountPages.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
