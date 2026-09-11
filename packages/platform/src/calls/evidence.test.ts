import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVIDENCE_MAX_AGE_MS,
  EVIDENCE_SCHEMA,
  PINNED_CONTRACT_HASH,
  validateServiceEvidence,
} from "./evidence.js";

/**
 * Mirrors the US-011 staging receipt
 * (orchestrator/.../US-011-staging/proof-receipt.json). Content-free by
 * construction: no ids, tokens, hostnames beyond the recorded apiBase/turnHost.
 */
const RECEIPT = {
  schema: EVIDENCE_SCHEMA,
  story: "US-011",
  stage: "hq-meet",
  apiBase: "https://bceoxnnnv0.execute-api.us-east-1.amazonaws.com",
  deployedRevision: {
    serviceCommit: "848a966101536036cab01efec69b3439735b5ec6",
    configHash:
      "9d19dbca229f2213fd651239ba6a724562f999abe93edfdc9c8ae2dbdb0c0f79",
  },
  contractHash: PINNED_CONTRACT_HASH,
  turnHost: "turn.getindigo.ai",
  runAt: "2026-09-11T05:45:20.265Z",
  failures: 0,
  passed: true,
} as const;

const NOW = Date.parse("2026-09-12T00:00:00.000Z");

const validate = (input: unknown, options = {}) =>
  validateServiceEvidence(input, { now: NOW, ...options });

describe("validateServiceEvidence", () => {
  it("accepts the US-011 receipt and preserves its fields", () => {
    const result = validate(RECEIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deployedRevision.serviceCommit).toBe(
      RECEIPT.deployedRevision.serviceCommit,
    );
    expect(result.value.contractHash).toBe(PINNED_CONTRACT_HASH);
    expect(result.value.passed).toBe(true);
  });

  it("refuses missing evidence", () => {
    for (const input of [undefined, null, "receipt", 7, []]) {
      const result = validate(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unavailable");
      expect(result.code).toBe("EVIDENCE_MISSING");
    }
  });

  it("refuses a foreign or malformed schema", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...RECEIPT, schema: "hq-meet-staging-proof/v2" },
      { ...RECEIPT, apiBase: "http://insecure.example.com" },
      { ...RECEIPT, apiBase: "not a url" },
      { ...RECEIPT, deployedRevision: { serviceCommit: "abc", configHash: "x" } },
      { ...RECEIPT, deployedRevision: undefined },
      { ...RECEIPT, contractHash: "short" },
      { ...RECEIPT, failures: "0" },
      { ...RECEIPT, passed: "true" },
      { ...RECEIPT, runAt: "not-a-date" },
      { ...RECEIPT, story: "" },
    ];
    for (const input of cases) {
      const result = validate(input);
      expect(result.ok, JSON.stringify(input.schema)).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("EVIDENCE_SCHEMA");
    }
  });

  it("refuses a receipt for a different contract", () => {
    const result = validate({ ...RECEIPT, contractHash: "a".repeat(64) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EVIDENCE_CONTRACT_MISMATCH");
  });

  it("refuses a failing run", () => {
    for (const input of [
      { ...RECEIPT, passed: false },
      { ...RECEIPT, failures: 3 },
    ]) {
      const result = validate(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("EVIDENCE_FAILED");
    }
  });

  it("refuses stale or future-dated evidence against the injected clock", () => {
    const runAt = Date.parse(RECEIPT.runAt);
    const stale = validateServiceEvidence(RECEIPT, {
      now: runAt + DEFAULT_EVIDENCE_MAX_AGE_MS + 1,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("EVIDENCE_STALE");

    const future = validateServiceEvidence(RECEIPT, {
      now: runAt - DEFAULT_EVIDENCE_MAX_AGE_MS - 1,
    });
    expect(future.ok).toBe(false);
    if (future.ok) return;
    expect(future.code).toBe("EVIDENCE_STALE");

    // Still inside a widened window.
    expect(
      validateServiceEvidence(RECEIPT, {
        now: runAt + DEFAULT_EVIDENCE_MAX_AGE_MS + 1,
        maxAgeMs: DEFAULT_EVIDENCE_MAX_AGE_MS * 2,
      }).ok,
    ).toBe(true);
  });

  it("accepts a Date clock and an overridden contract hash", () => {
    expect(validateServiceEvidence(RECEIPT, { now: new Date(NOW) }).ok).toBe(
      true,
    );
    expect(
      validateServiceEvidence(
        { ...RECEIPT, contractHash: "b".repeat(64) },
        { now: NOW, contractHash: "b".repeat(64) },
      ).ok,
    ).toBe(true);
  });

  it("keeps receipt contents out of failure messages", () => {
    const result = validate({ ...RECEIPT, passed: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain(RECEIPT.apiBase);
    expect(result.message).not.toContain(RECEIPT.turnHost);
  });
});
