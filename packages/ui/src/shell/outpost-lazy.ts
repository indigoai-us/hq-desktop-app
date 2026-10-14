/**
 * The only door into personal Outpost (US-034).
 * The shell imports this file; the page chunk loads on first open.
 */
type OutpostModule = typeof import("../outpost/OutpostPage.svelte");

let pending: Promise<OutpostModule> | null = null;

export function loadOutpost(): Promise<OutpostModule> {
  pending ??= import("../outpost/OutpostPage.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
