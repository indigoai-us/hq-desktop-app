/**
 * The first-run handoff hint (US-010).
 *
 * When the welcome window hands off to the desktop window, Rust queues this
 * hint as the desktop window's pending route (`first_run_handoff_hint` in
 * `apps/sync/src-tauri/src/commands/first_run.rs`). It carries the two flags
 * and the setup status the shell's first-run route needs, so the shell can
 * choose between the first-run takeover and the ordinary shell on its first
 * frame instead of waiting up to 2 s for its own reads.
 *
 * Wire shape: `first-run-handoff:` followed by JSON
 * `{"route":null,"flags":{"desktop.visual-first-run":bool|null,
 * "desktop.first-run-found-apps-v1":bool|null},"welcomeSetupOwed":bool,
 * "welcomeTourShown":bool}`. A `null` flag is unknown and the shell reads it
 * itself, as it did before the hint existed.
 */

/** Pending-route prefix that marks a handoff hint. Matches the Rust constant. */
export const FIRST_RUN_HANDOFF_PREFIX = "first-run-handoff:";

export interface FirstRunHandoffHint {
  /** A route to open after first run, or null for the default. */
  route: string | null;
  flags: {
    /** `desktop.visual-first-run`, or null when the read did not answer. */
    visualFirstRun: boolean | null;
    /** `desktop.first-run-found-apps-v1`, or null when the read did not answer. */
    foundApps: boolean | null;
  };
  welcomeSetupOwed: boolean;
  welcomeTourShown: boolean;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Split a pending-route value into the route to restore and the handoff hint.
 * A plain string is a route with no hint. A prefixed string is a hint (its
 * `route` field, when a string, is the route). Anything malformed yields no
 * hint, so the shell falls back to its own reads.
 */
export function parseFirstRunHandoffHint(pending: unknown): {
  route: string | null;
  hint: FirstRunHandoffHint | null;
} {
  if (typeof pending !== "string" || pending === "") return { route: null, hint: null };
  if (!pending.startsWith(FIRST_RUN_HANDOFF_PREFIX)) return { route: pending, hint: null };
  let raw: unknown;
  try {
    raw = JSON.parse(pending.slice(FIRST_RUN_HANDOFF_PREFIX.length));
  } catch {
    return { route: null, hint: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { route: null, hint: null };
  const record = raw as Record<string, unknown>;
  const flags =
    record.flags && typeof record.flags === "object" && !Array.isArray(record.flags)
      ? (record.flags as Record<string, unknown>)
      : {};
  if (typeof record.welcomeSetupOwed !== "boolean" || typeof record.welcomeTourShown !== "boolean") {
    return { route: null, hint: null };
  }
  const route = typeof record.route === "string" && record.route !== "" ? record.route : null;
  return {
    route,
    hint: {
      route,
      flags: {
        visualFirstRun: boolOrNull(flags["desktop.visual-first-run"]),
        foundApps: boolOrNull(flags["desktop.first-run-found-apps-v1"]),
      },
      welcomeSetupOwed: record.welcomeSetupOwed,
      welcomeTourShown: record.welcomeTourShown,
    },
  };
}
