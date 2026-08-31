/**
 * DEV-ONLY local session bypass.
 *
 * Purpose: let a developer run the SvelteKit dev server (`vite dev`) on their
 * own machine and open the hosted-web MQTT + REST shell WITHOUT a Cognito
 * login. On localhost there is no `hq_id_token` cookie, so the auth gate in
 * hooks.server.ts would 303 every page to /auth/signin and the shell would
 * never render locally. This is not a local-mesh / ~/.hq reader.
 *
 * SAFETY — this can NEVER affect the deployed Vercel/production build. It is
 * protected by TWO independent guards, BOTH of which must be true:
 *   1. `import.meta.env.DEV` — Vite sets this to `true` only under `vite dev`.
 *      In any production build (`vite build`) it is statically replaced with
 *      `false`, so the whole synthetic-session branch is dead-code eliminated
 *      from the bundle. It is impossible to flip on at runtime in prod.
 *   2. `process.env.HQ_LOCAL_MESH === "1"` — an explicit, opt-in env flag the
 *      developer sets by hand. Absent by default, so `vite dev` alone does NOT
 *      bypass auth.
 *
 * This module ONLY adds a synthetic-session branch under that double guard. It
 * never touches real token validation (see verifyIdToken in ./auth). When the
 * guards are off, callers get `null` and behavior is byte-identical to today.
 */

import type { Session } from "./auth";

/** The two guard inputs, passed in so the decision is deterministic + testable. */
export interface LocalDevGuards {
  /** `import.meta.env.DEV` — true ONLY under `vite dev`, false in every build. */
  dev: boolean;
  /** `process.env.HQ_LOCAL_MESH` — the explicit opt-in flag (must equal "1"). */
  meshFlag: string | undefined;
}

/** Stable identity for the synthetic local-dev session. */
export const LOCAL_DEV_SUB = "local-dev";
export const LOCAL_DEV_EMAIL = "local@localhost";

/**
 * Return a synthetic local-dev {@link Session} ONLY when BOTH guards pass;
 * otherwise `null`. The expiry is set far in the future so downstream checks
 * treat it as live for the whole dev session.
 */
export function localDevSession(guards: LocalDevGuards): Session | null {
  if (guards.dev && guards.meshFlag === "1") {
    return {
      sub: LOCAL_DEV_SUB,
      email: LOCAL_DEV_EMAIL,
      name: "Local Dev",
      // One year out — a dev server session never needs to "expire".
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      local: true,
    };
  }
  return null;
}
