/**
 * Service evidence receipt (US-011) validation — the Desktop preflight gate.
 *
 * Desktop calling is only allowed to talk to a *deployed, verified* hq-meet
 * backend. The proof of that is the content-free staging receipt US-011 emits
 * (`hq-meet-staging-proof/v1`). This module is the only place that decides
 * whether a receipt counts, and `calls.preflight()` is the only way an adapter
 * instance is unlocked: there is no environment variable, flag or ambient
 * bypass, by design.
 */

export const EVIDENCE_SCHEMA = "hq-meet-staging-proof/v1";

/**
 * sha256 of hq-pro `src/meetings/native/contract.ts` at the commit this mirror
 * was written against. A receipt for any other contract text is refused: the
 * Desktop validators below would no longer be a mirror of what is deployed.
 */
export const PINNED_CONTRACT_HASH =
  "6480e4a0c45e1dc40903152357c5f58ee06c36b1b6c31a62afdd7b2745740e76";

/** Receipts older than this are treated as stale evidence (30 days). */
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How far ahead of the local clock a receipt may be dated (5 minutes).
 *
 * A receipt is evidence of a run that already happened, so a `runAt` in the
 * future is either clock skew or a forged date. Only genuine skew is tolerated;
 * anything beyond it fails as EVIDENCE_STALE, the same code a too-old receipt
 * gets. Widening `maxAgeMs` does not widen this — the two bounds are separate.
 */
export const DEFAULT_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const EVIDENCE_FAILURE_CODES = [
  /** Nothing was supplied, or it was not an object. */
  "EVIDENCE_MISSING",
  /** Wrong schema id, or a required field is missing/malformed. */
  "EVIDENCE_SCHEMA",
  /** A well-formed receipt that records failures or `passed !== true`. */
  "EVIDENCE_FAILED",
  /** The receipt pins a different contract hash than this mirror. */
  "EVIDENCE_CONTRACT_MISMATCH",
  /** Older than the configured max age, or dated ahead beyond clock skew. */
  "EVIDENCE_STALE",
] as const;

export type EvidenceFailureCode = (typeof EVIDENCE_FAILURE_CODES)[number];

export interface ServiceEvidenceRevision {
  serviceCommit: string;
  configHash: string;
}

/** The fields the preflight depends on. Unknown extra fields are preserved. */
export interface ServiceEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  story: string;
  stage: string;
  apiBase: string;
  deployedRevision: ServiceEvidenceRevision;
  contractHash: string;
  turnHost?: string;
  runAt: string;
  failures: number;
  passed: true;
}

export interface EvidenceOptions {
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number | Date;
  /** Override the staleness window. */
  maxAgeMs?: number;
  /** Override the forward clock-skew tolerance for a future-dated `runAt`. */
  futureSkewMs?: number;
  /** Override the pinned contract hash (tests / a future contract bump). */
  contractHash?: string;
}

const SHA_40 = /^[0-9a-f]{40}$/;
const SHA_64 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structurally identical to `AdapterFailure` with `reason: "unavailable"`, but
 * declared here so this module stays importable without pulling in the adapter
 * surface (adapter.ts imports these types, so the dependency runs one way).
 */
export interface EvidenceFailure {
  ok: false;
  reason: "unavailable";
  code: EvidenceFailureCode;
  message: string;
}

export type EvidenceResult =
  | { ok: true; value: ServiceEvidence }
  | EvidenceFailure;

function fail(code: EvidenceFailureCode, message: string): EvidenceFailure {
  return { ok: false, reason: "unavailable", code, message };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a service evidence receipt.
 *
 * Returns the receipt on success; on failure an `unavailable` result whose
 * `code` is a stable `EvidenceFailureCode`. Messages stay content-free — they
 * never echo the receipt body, which keeps hosts, tokens and TURN credentials
 * out of logs even if a caller logs the failure.
 */
export function validateServiceEvidence(
  input: unknown,
  options: EvidenceOptions = {},
): EvidenceResult {
  if (input === null || input === undefined) {
    return fail("EVIDENCE_MISSING", "No service evidence receipt was supplied.");
  }
  if (!isRecord(input)) {
    return fail(
      "EVIDENCE_MISSING",
      "Service evidence must be a receipt object.",
    );
  }
  if (input.schema !== EVIDENCE_SCHEMA) {
    return fail(
      "EVIDENCE_SCHEMA",
      `Service evidence schema must be ${EVIDENCE_SCHEMA}.`,
    );
  }
  if (!nonEmptyString(input.story) || !nonEmptyString(input.stage)) {
    return fail("EVIDENCE_SCHEMA", "Service evidence is missing story/stage.");
  }
  if (!nonEmptyString(input.apiBase) || !isHttpsUrl(input.apiBase)) {
    return fail("EVIDENCE_SCHEMA", "Service evidence apiBase must be https.");
  }
  const revision = input.deployedRevision;
  if (
    !isRecord(revision) ||
    typeof revision.serviceCommit !== "string" ||
    !SHA_40.test(revision.serviceCommit) ||
    typeof revision.configHash !== "string" ||
    !SHA_64.test(revision.configHash)
  ) {
    return fail(
      "EVIDENCE_SCHEMA",
      "Service evidence deployedRevision is missing or malformed.",
    );
  }
  if (typeof input.contractHash !== "string" || !SHA_64.test(input.contractHash)) {
    return fail("EVIDENCE_SCHEMA", "Service evidence contractHash is malformed.");
  }
  if (typeof input.failures !== "number" || !Number.isInteger(input.failures)) {
    return fail("EVIDENCE_SCHEMA", "Service evidence failures must be an integer.");
  }
  if (typeof input.passed !== "boolean") {
    return fail("EVIDENCE_SCHEMA", "Service evidence passed must be a boolean.");
  }
  if (!nonEmptyString(input.runAt)) {
    return fail("EVIDENCE_SCHEMA", "Service evidence runAt is missing.");
  }
  const runAt = Date.parse(input.runAt);
  if (Number.isNaN(runAt)) {
    return fail("EVIDENCE_SCHEMA", "Service evidence runAt is not a timestamp.");
  }

  const expectedHash = options.contractHash ?? PINNED_CONTRACT_HASH;
  if (input.contractHash !== expectedHash) {
    return fail(
      "EVIDENCE_CONTRACT_MISMATCH",
      "Service evidence pins a different contract than this Desktop mirror.",
    );
  }
  if (input.passed !== true || input.failures !== 0) {
    return fail(
      "EVIDENCE_FAILED",
      "Service evidence records a failing verification run.",
    );
  }

  const nowOption = options.now;
  const now =
    nowOption === undefined
      ? Date.now()
      : nowOption instanceof Date
        ? nowOption.getTime()
        : nowOption;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;
  const futureSkewMs =
    options.futureSkewMs ?? DEFAULT_EVIDENCE_FUTURE_SKEW_MS;
  const age = now - runAt;
  if (age > maxAgeMs) {
    return fail("EVIDENCE_STALE", "Service evidence is older than the allowed window.");
  }
  if (age < -futureSkewMs) {
    return fail("EVIDENCE_STALE", "Service evidence is dated in the future.");
  }

  return {
    ok: true,
    value: {
      ...(input as unknown as ServiceEvidence),
      schema: EVIDENCE_SCHEMA,
      passed: true,
    },
  };
}
