/**
 * The only door into personal Secrets and Connections (US-033).
 * The shell imports this file; the page chunk loads on first open.
 */
type PersonalModule = typeof import("../personal/PersonalRailPage.svelte");

let pending: Promise<PersonalModule> | null = null;

export function loadPersonalRail(): Promise<PersonalModule> {
  pending ??= import("../personal/PersonalRailPage.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
