/**
 * US-014 acceptance tests (from PRD e2eTests):
 *
 *  1. Given missing or incompatible service evidence, when Desktop adapter
 *     preflight runs, then it remains failing and dependent integration does
 *     not proceed.
 *  2. Given the native adapter and web fallback, when calling capability is
 *     queried, then native invokes authorized methods and unsupported host is
 *     explicit.
 *  3. Given identical golden contract bytes, when backend and Desktop parse
 *     them, then fields/version/error behavior match.
 *
 * Everything is exercised through the real shipped modules — the adapters are
 * constructed with recorded invoke/fetch stubs, the clock is injected, and the
 * golden vectors are the service's own bytes carried in this repo (a
 * standalone checkout must never reach for a sibling clone of hq-pro).
 */
import { describe, expect, it } from "vitest";

import {
  CALLS_PREFLIGHT_REQUIRED,
  CALLS_UNSUPPORTED_HOST,
  CALLS_VERSION,
  DEFAULT_EVIDENCE_MAX_AGE_MS,
  EVIDENCE_SCHEMA,
  PINNED_CONTRACT_HASH,
  WebPlatformAdapter,
  createSyncPlatformAdapter,
  parseEnvelope,
  parseEnvelopeOfKind,
  safeParseEnvelope,
  validateServiceEvidence,
} from "./index.js";
import {
  GOLDEN_PROVENANCE,
  GOLDEN_RAW,
  goldenJson,
} from "./calls/golden/index.js";

/** A passing US-011 staging proof for the pinned contract. */
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

/** Fixed clock: one day after the receipt ran. No timers, no Date.now(). */
const NOW = Date.parse("2026-09-12T00:00:00.000Z");

const COMPANY = "company_a";

/** The company-scoped envelope vectors mirrored from the service. */
const ENVELOPE_VECTORS = [
  ["room", "room.json"],
  ["grant", "grant.json"],
  ["admission", "admission.json"],
  ["knock", "knock.json"],
  ["signal", "signal.json"],
  ["consent", "consent.json"],
  ["segment", "segment.json"],
  ["correction", "correction.json"],
  ["receipt", "receipt.json"],
  ["completionManifest", "completionManifest.json"],
  ["uploadCapability", "uploadCapability.json"],
  ["chunk", "chunk.json"],
  ["chunkReceipt", "chunkReceipt.json"],
  ["finalizationReceipt", "finalizationReceipt.json"],
  ["completion", "completion.json"],
] as const;

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

/** A real Sync (native) adapter over a recorded hq_pro_fetch seam. */
function nativeAdapter(
  respond: (args: Record<string, unknown>) => unknown = () => ({
    status: 200,
    body: JSON.stringify({ ok: true }),
  }),
) {
  const invocations: Invocation[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      invocations.push({ cmd, args });
      if (cmd === "hq_pro_fetch") return respond(args ?? {});
      return null;
    },
    fetch: (() => {
      throw new Error("native calling must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
  });
  const calls = () => invocations.filter((c) => c.cmd === "hq_pro_fetch");
  return { adapter, invocations, calls };
}

function webAdapter() {
  return new WebPlatformAdapter({
    baseUrl: "https://api.example.test",
    fetch: (() => {
      throw new Error("the web host has no native calling to reach for");
    }) as unknown as typeof globalThis.fetch,
  });
}

function record(name: string): Record<string, unknown> {
  return goldenJson(name) as Record<string, unknown>;
}

describe("US-014: Implement the versioned call platform adapter", () => {
  it("keeps the Desktop adapter failing — and dependent integration blocked — on missing or incompatible service evidence", async () => {
    const { adapter, calls } = nativeAdapter();

    // Nothing supplied at all.
    const missing = await adapter.calls.preflight(undefined, { now: NOW });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("EVIDENCE_MISSING");

    // A receipt for a contract this mirror was not written against.
    const foreignContract = await adapter.calls.preflight(
      { ...RECEIPT, contractHash: "b".repeat(64) },
      { now: NOW },
    );
    expect(foreignContract.ok).toBe(false);
    if (!foreignContract.ok) {
      expect(foreignContract.code).toBe("EVIDENCE_CONTRACT_MISMATCH");
    }

    // Structurally wrong receipts are refused too.
    const wrongSchema = await adapter.calls.preflight(
      { ...RECEIPT, schema: "hq-meet-staging-proof/v2" },
      { now: NOW },
    );
    expect(wrongSchema.ok).toBe(false);
    if (!wrongSchema.ok) expect(wrongSchema.code).toBe("EVIDENCE_SCHEMA");

    // The gate stays shut: status is still unavailable and dependent calling
    // work never reaches the backend.
    const status = adapter.calls.preflightStatus();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.code).toBe(CALLS_PREFLIGHT_REQUIRED);

    const room = await adapter.calls.createRoom({
      companyUid: COMPANY,
      visibility: "private",
    });
    expect(room.ok).toBe(false);
    if (!room.ok) {
      expect(room.reason).toBe("unavailable");
      expect(room.code).toBe(CALLS_PREFLIGHT_REQUIRED);
    }
    expect(calls()).toHaveLength(0);

    // A passing receipt then unlocks the same instance — proving the failure
    // above was the gate and not a broken transport.
    const pass = await adapter.calls.preflight(RECEIPT, { now: NOW });
    expect(pass.ok).toBe(true);
    expect(adapter.calls.preflightStatus().ok).toBe(true);
    expect((await adapter.calls.createRoom({
      companyUid: COMPANY,
      visibility: "private",
    })).ok).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  it("answers the calling-capability query per host: native invokes the authorized methods, the web host is explicitly unsupported", async () => {
    const { adapter, calls } = nativeAdapter();
    expect(adapter.capabilities.nativeCalls).toBe(true);
    expect(adapter.isAvailable("nativeCalls")).toBe(true);
    expect(adapter.calls.contractVersion).toBe(CALLS_VERSION);

    expect((await adapter.calls.preflight(RECEIPT, { now: NOW })).ok).toBe(true);
    const baseline = calls().length;

    await adapter.calls.discoverOffice(COMPANY);
    await adapter.calls.createRoom({ companyUid: COMPANY, visibility: "company" });
    await adapter.calls.getRoom("room_a", COMPANY);
    await adapter.calls.joinRoom("room_a", { companyUid: COMPANY });
    await adapter.calls.signalingControl("admit", { companyUid: COMPANY });
    await adapter.calls.completion("finalize", { companyUid: COMPANY });

    const made = calls().slice(baseline);
    expect(made.map((c) => c.args?.url)).toEqual([
      "/v1/meet-native/office?companyUid=company_a",
      "/v1/meet-native/rooms",
      "/v1/meet-native/rooms/room_a?companyUid=company_a",
      "/v1/meet-native/rooms/room_a/join",
      "/v1/meet-native/signaling/admit",
      "/v1/meet-native/completion/finalize",
    ]);
    expect(made.map((c) => c.args?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "POST",
      "POST",
    ]);
    // Every mutating request carries the contract version.
    for (const call of made.filter((c) => c.args?.method === "POST")) {
      const body = JSON.parse(call.args!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.version).toBe(CALLS_VERSION);
    }

    // The shared web host advertises no native calling and exposes no working
    // native control behind that flag.
    const web = webAdapter();
    expect(web.capabilities.nativeCalls).toBe(false);
    expect(web.isAvailable("nativeCalls")).toBe(false);
    const webResults = [
      await web.calls.preflight(RECEIPT, { now: NOW }),
      await web.calls.discoverOffice(COMPANY),
      await web.calls.createRoom({ companyUid: COMPANY, visibility: "company" }),
      await web.calls.joinRoom("room_a", { companyUid: COMPANY }),
      await web.calls.signalingControl("admit", { companyUid: COMPANY }),
      await web.calls.completion("finalize", { companyUid: COMPANY }),
      web.calls.preflightStatus(),
    ];
    for (const result of webResults) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("unavailable");
      expect(result.code).toBe(CALLS_UNSUPPORTED_HOST);
    }
  });

  it("parses the identical golden contract bytes the backend does — fields, version and error behavior all match", () => {
    // The vectors are the service's own bytes, carried in-repo (no sibling
    // repository import) and pinned by PROVENANCE.json.
    expect(GOLDEN_PROVENANCE.serviceRepo).toBe("indigoai-us/hq-pro");
    expect(GOLDEN_PROVENANCE.contractHash).toBe(PINNED_CONTRACT_HASH);

    for (const [kind, file] of ENVELOPE_VECTORS) {
      const raw = GOLDEN_RAW[file];
      expect(raw, `${file} is missing from the golden set`).toBeDefined();
      const input = JSON.parse(raw!) as Record<string, unknown>;

      // Field-for-field identity against the raw JSON object: nothing dropped,
      // renamed, coerced or defaulted on the Desktop side.
      const parsed = parseEnvelope(input, { companyUid: COMPANY });
      expect(parsed, kind).toEqual(input);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(input).sort());
      expect(parsed.version).toBe(CALLS_VERSION);
      expect(parseEnvelopeOfKind(kind, input, { companyUid: COMPANY })).toEqual(
        input,
      );

      // Version and authorization errors use the backend's own codes.
      expect(safeParseEnvelope({ ...input, version: "hq-meet/2" })).toEqual({
        ok: false,
        code: "UNSUPPORTED_VERSION",
      });
      expect(safeParseEnvelope(input, { companyUid: "company_b" })).toEqual({
        ok: false,
        code: "COMPANY_ACCESS_DENIED",
      });
    }
  });

  it("refuses stale evidence and evidence dated in the future", async () => {
    const { adapter, calls } = nativeAdapter();
    const runAt = Date.parse(RECEIPT.runAt);

    const stale = await adapter.calls.preflight(RECEIPT, {
      now: runAt + DEFAULT_EVIDENCE_MAX_AGE_MS + 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("EVIDENCE_STALE");

    const future = await adapter.calls.preflight(RECEIPT, {
      now: runAt - DEFAULT_EVIDENCE_MAX_AGE_MS - 1,
    });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.code).toBe("EVIDENCE_STALE");

    // Still inside the window it passes, so the refusals above are the clock.
    expect(
      (await adapter.calls.preflight(RECEIPT, {
        now: runAt + DEFAULT_EVIDENCE_MAX_AGE_MS,
      })).ok,
    ).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("refuses a receipt pinned to a different contract hash", () => {
    const result = validateServiceEvidence(
      { ...RECEIPT, contractHash: "c".repeat(64) },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unavailable");
      expect(result.code).toBe("EVIDENCE_CONTRACT_MISMATCH");
      // Content-free message: the receipt body never leaks into logs.
      expect(result.message).not.toContain(RECEIPT.apiBase);
    }

    // Pointing the validator at that hash accepts it — the pin is the check.
    const pinned = validateServiceEvidence(
      { ...RECEIPT, contractHash: "c".repeat(64) },
      { now: NOW, contractHash: "c".repeat(64) },
    );
    expect(pinned.ok).toBe(true);
  });

  it("refuses a receipt that records failures, even when it claims to have passed", async () => {
    const { adapter, calls } = nativeAdapter();

    const withFailures = await adapter.calls.preflight(
      { ...RECEIPT, failures: 1 },
      { now: NOW },
    );
    expect(withFailures.ok).toBe(false);
    if (!withFailures.ok) expect(withFailures.code).toBe("EVIDENCE_FAILED");

    const notPassed = await adapter.calls.preflight(
      { ...RECEIPT, passed: false },
      { now: NOW },
    );
    expect(notPassed.ok).toBe(false);
    if (!notPassed.ok) expect(notPassed.code).toBe("EVIDENCE_FAILED");

    // A recorded pass is revoked by a later failing receipt.
    expect((await adapter.calls.preflight(RECEIPT, { now: NOW })).ok).toBe(true);
    const revoked = await adapter.calls.preflight(
      { ...RECEIPT, failures: 3, passed: false },
      { now: NOW },
    );
    expect(revoked.ok).toBe(false);
    const blocked = await adapter.calls.discoverOffice(COMPANY);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe(CALLS_PREFLIGHT_REQUIRED);
    expect(calls()).toHaveLength(0);
  });

  it("rejects an unsupported contract version in a golden vector with UNSUPPORTED_VERSION", () => {
    const room = record("room.json");
    for (const version of ["hq-meet/0", "hq-meet/2", "hq-meet", 1, null]) {
      expect(safeParseEnvelope({ ...room, version })).toEqual({
        ok: false,
        code: "UNSUPPORTED_VERSION",
      });
    }
    expect(() =>
      parseEnvelope({ ...room, version: "hq-meet/2" }, { companyUid: COMPANY }),
    ).toThrowError("UNSUPPORTED_VERSION");
  });

  it("rejects another company's envelope with COMPANY_ACCESS_DENIED", () => {
    const grant = record("grant.json");
    expect(grant.companyUid).toBe(COMPANY);
    expect(safeParseEnvelope(grant, { companyUid: "company_b" })).toEqual({
      ok: false,
      code: "COMPANY_ACCESS_DENIED",
    });
    // Version is checked before company scoping, exactly as the service does.
    expect(
      safeParseEnvelope(
        { ...grant, version: "hq-meet/2" },
        { companyUid: "company_b" },
      ),
    ).toEqual({ ok: false, code: "UNSUPPORTED_VERSION" });
    // The matching company still parses.
    expect(safeParseEnvelope(grant, { companyUid: COMPANY }).ok).toBe(true);
  });

  it("makes the web host's refusal explicit rather than degrading to a silent success or a crash", async () => {
    const web = webAdapter();
    // The typed calls API is present on every adapter (uniform surface)…
    expect(typeof web.calls.createRoom).toBe("function");
    expect(web.calls.contractVersion).toBe(CALLS_VERSION);
    // …but it resolves an explicit unavailable result, never throws and never
    // returns ok.
    const result = await web.calls.createRoom({
      companyUid: COMPANY,
      visibility: "private",
    });
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      code: CALLS_UNSUPPORTED_HOST,
      message: "Native calling is not available on this host.",
    });
    // Even a valid receipt cannot unlock a host with no native transport.
    expect((await web.calls.preflight(RECEIPT, { now: NOW })).ok).toBe(false);
    expect(web.calls.preflightStatus().ok).toBe(false);
  });

  it("locks every native calls method behind preflight on a fresh adapter instance", async () => {
    const { adapter, calls } = nativeAdapter();
    const results = await Promise.all([
      adapter.calls.discoverOffice(COMPANY),
      adapter.calls.setOfficePreference({
        companyUid: COMPANY,
        willingness: "open",
      }),
      adapter.calls.setOfficeConnectivity({
        companyUid: COMPANY,
        connectivity: "good",
      }),
      adapter.calls.createRoom({ companyUid: COMPANY, visibility: "private" }),
      adapter.calls.getRoom("room_a", COMPANY),
      adapter.calls.joinRoom("room_a", { companyUid: COMPANY }),
      adapter.calls.roomLifecycle("room_a", "end", { companyUid: COMPANY }),
      adapter.calls.createKnock({
        companyUid: COMPANY,
        roomId: "room_a",
        callId: "call_a",
        epoch: 1,
        target: "bob",
        note: "",
        idempotencyKey: "key_a",
      }),
      adapter.calls.listKnocks(COMPANY),
      adapter.calls.getKnock("knock_a", COMPANY),
      adapter.calls.respondToKnock("knock_a", "accept", COMPANY),
      adapter.calls.signalingControl("admit", { companyUid: COMPANY }),
      adapter.calls.sendSignal({ signal: {}, signature: "sig" }),
      adapter.calls.iceConfig({ companyUid: COMPANY }),
      adapter.calls.completionConsent({ companyUid: COMPANY }),
      adapter.calls.completion("create", { companyUid: COMPANY }),
    ]);
    for (const result of [...results, adapter.calls.preflightStatus()]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("unavailable");
      expect(result.code).toBe(CALLS_PREFLIGHT_REQUIRED);
    }
    expect(calls()).toHaveLength(0);

    // The gate is per instance: unlocking one adapter leaves a fresh one shut.
    expect((await adapter.calls.preflight(RECEIPT, { now: NOW })).ok).toBe(true);
    const other = nativeAdapter();
    expect(other.adapter.calls.preflightStatus().ok).toBe(false);
    const blocked = await other.adapter.calls.discoverOffice(COMPANY);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe(CALLS_PREFLIGHT_REQUIRED);
  });
});
