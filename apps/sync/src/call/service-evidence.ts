/**
 * The bundled US-011 service-evidence receipt.
 *
 * `adapter.calls` stays locked until `calls.preflight(evidence)` passes, so
 * BOTH windows need a receipt before they touch a native Meet route. Carrying
 * one through the window target would make the opener the authority on whether
 * the backend is verified; bundling it at build time instead means the check is
 * a property of this build, identical in the main window and the call window,
 * and nothing a caller sends can weaken it.
 *
 * The file is `service-evidence.json`, copied BYTE-FOR-BYTE from the US-011
 * staging proof (`executions/US-011-staging/proof-receipt.json`). It is
 * content-free: a schema id, the deployed revision, the contract hash, and the
 * step results — no token, key, company or person.
 *
 * ── REFRESHING IT (do this before the deadline below) ───────────────────────
 *   1. Re-run the US-011 staging proof.
 *   2. Copy the emitted `executions/US-011-staging/proof-receipt.json` over
 *      `apps/sync/src/call/service-evidence.json`, byte for byte.
 *   3. Run `pnpm --dir apps/sync exec vitest run src/call` — the lifetime test
 *      in `service-evidence.test.ts` is what tells you the deadline moved.
 *
 * ── WHY THIS RECEIPT HAS ITS OWN MAX AGE ────────────────────────────────────
 * `DEFAULT_EVIDENCE_MAX_AGE_MS` (30 days) is sized for a receipt a *session*
 * obtains: a running app can go and get a fresh one. A BUNDLED receipt cannot
 * — it ages with the shipped build, and a user on a three-month-old install
 * has no way to refresh it. Inheriting the 30-day default would mean shipped
 * builds silently going dark for everyone who has not updated.
 *
 * So the bundled artifact gets its own explicit, longer bound —
 * `BUNDLED_EVIDENCE_MAX_AGE_MS` — passed at BOTH preflight call sites (the
 * call window's `bootstrap.ts` and the main window's Office host). This is a
 * lifetime, not a bypass: the gate still fails CLOSED with EVIDENCE_STALE past
 * the bound, and still refuses a receipt pinned to a different contract hash
 * with EVIDENCE_CONTRACT_MISMATCH. `service-evidence.test.ts` fails while the
 * bundled receipt is within 14 days of the limit, so CI warns before any
 * shipped build reaches it.
 */

import receipt from "./service-evidence.json";

/** The receipt handed to `calls.preflight`. Treated as opaque `unknown`. */
export const SERVICE_EVIDENCE: unknown = receipt;

/**
 * Staleness window for the BUNDLED receipt: 90 days from its `runAt`.
 *
 * Long enough that a normal release cadence refreshes it well before a user
 * can hit it; short enough that a build stops trusting a long-abandoned
 * staging proof rather than calling an unverified backend forever.
 */
export const BUNDLED_EVIDENCE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How close to `BUNDLED_EVIDENCE_MAX_AGE_MS` the bundled receipt may get
 * before the unit test fails. The gap is the window in which someone must run
 * the refresh steps above.
 */
export const BUNDLED_EVIDENCE_REFRESH_WARNING_MS = 14 * 24 * 60 * 60 * 1000;
