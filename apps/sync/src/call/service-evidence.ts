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
 * REFRESHING IT: re-run the US-011 staging proof and copy the new
 * `proof-receipt.json` over this file. `validateServiceEvidence` refuses a
 * receipt older than its max age (30 days by default,
 * `DEFAULT_EVIDENCE_MAX_AGE_MS`) with EVIDENCE_STALE, and refuses one pinned to
 * a different contract hash with EVIDENCE_CONTRACT_MISMATCH — so a stale bundle
 * fails closed (calling refuses) rather than silently calling an unverified
 * backend.
 */

import receipt from "./service-evidence.json";

/** The receipt handed to `calls.preflight`. Treated as opaque `unknown`. */
export const SERVICE_EVIDENCE: unknown = receipt;
