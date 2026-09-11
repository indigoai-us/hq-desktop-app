import { describe, expect, it } from "vitest";

import { createSyncPlatformAdapter } from "../tauri/sync-adapter.js";
import { WebPlatformAdapter } from "../web/index.js";
import { createDesktopAdapter } from "../desktop/index.js";
import { TauriPlatformAdapter } from "../tauri/index.js";
import {
  CALLS_PREFLIGHT_REQUIRED,
  CALLS_UNSUPPORTED_HOST,
  createUnsupportedCallsApi,
} from "./api.js";
import { CALLS_VERSION } from "./contract.js";
import { EVIDENCE_SCHEMA, PINNED_CONTRACT_HASH } from "./evidence.js";

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
};

const NOW = Date.parse("2026-09-12T00:00:00.000Z");

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeSync(
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
      throw new Error("production must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
  });
  return { adapter, invocations };
}

describe("calls capability across hosts", () => {
  it("reports nativeCalls per host", () => {
    const { adapter } = makeSync();
    expect(adapter.capabilities.nativeCalls).toBe(true);
    expect(adapter.isAvailable("nativeCalls")).toBe(true);

    const web = new WebPlatformAdapter({
      baseUrl: "https://api.example.com",
      fetch: (async () => {
        throw new Error("web calls must not reach the network");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(web.capabilities.nativeCalls).toBe(false);
    expect(web.isAvailable("nativeCalls")).toBe(false);
  });

  it("makes the web host explicit instead of exposing native controls", async () => {
    const web = new WebPlatformAdapter({
      baseUrl: "https://api.example.com",
      fetch: (async () => {
        throw new Error("web calls must not reach the network");
      }) as unknown as typeof globalThis.fetch,
    });
    const results = await Promise.all([
      web.calls.preflight(RECEIPT, { now: NOW }),
      web.calls.discoverOffice("company_a"),
      web.calls.createRoom({ companyUid: "company_a", visibility: "private" }),
      web.calls.joinRoom("room_a", {}),
      web.calls.signalingControl("admit", {}),
      web.calls.sendSignal({ signal: {}, signature: "sig" }),
      web.calls.iceConfig({}),
      web.calls.completionConsent({}),
      web.calls.completion("create", {}),
      web.calls.createKnock({
        companyUid: "company_a",
        roomId: "room_a",
        callId: "call_a",
        epoch: 1,
        target: "bob",
        note: "",
        idempotencyKey: "key_a",
      }),
      web.calls.listKnocks("company_a"),
      web.calls.getKnock("knock_a", "company_a"),
      web.calls.respondToKnock("knock_a", "accept", "company_a"),
      web.calls.getRoom("room_a", "company_a"),
      web.calls.roomLifecycle("room_a", "end", {}),
      web.calls.setOfficePreference({
        companyUid: "company_a",
        willingness: "open",
      }),
      web.calls.setOfficeConnectivity({
        companyUid: "company_a",
        connectivity: "good",
      }),
    ]);
    for (const result of [...results, web.calls.preflightStatus()]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("unavailable");
      expect(result.code).toBe(CALLS_UNSUPPORTED_HOST);
    }
    expect(web.calls.contractVersion).toBe("hq-meet/1");
  });

  it("keeps the desktop composite on the native calls group", () => {
    const desktop = createDesktopAdapter({
      invoke: async () => null,
      baseUrl: "https://api.example.com",
      fetch: (async () => {
        throw new Error("unused");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(desktop.capabilities.nativeCalls).toBe(true);
    const tauri = new TauriPlatformAdapter({ invoke: async () => null });
    expect(typeof tauri.calls.preflight).toBe("function");
  });

  it("lets an unsupported group declare its own code", async () => {
    const api = createUnsupportedCallsApi("CALLS_NO_TRANSPORT", "nope");
    const result = await api.discoverOffice("company_a");
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      code: "CALLS_NO_TRANSPORT",
      message: "nope",
    });
  });
});

describe("native calls preflight gate", () => {
  it("refuses every method until a passing preflight is recorded", async () => {
    const { adapter, invocations } = makeSync();
    const before = await adapter.calls.discoverOffice("company_a");
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.reason).toBe("unavailable");
      expect(before.code).toBe(CALLS_PREFLIGHT_REQUIRED);
    }
    expect(adapter.calls.preflightStatus().ok).toBe(false);
    // Nothing reached the backend.
    expect(invocations.filter((c) => c.cmd === "hq_pro_fetch")).toHaveLength(0);
  });

  it("stays failing on missing or incompatible evidence", async () => {
    const { adapter, invocations } = makeSync();
    const missing = await adapter.calls.preflight(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("EVIDENCE_MISSING");

    const mismatched = await adapter.calls.preflight(
      { ...RECEIPT, contractHash: "a".repeat(64) },
      { now: NOW },
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.code).toBe("EVIDENCE_CONTRACT_MISMATCH");
    }

    const failed = await adapter.calls.preflight(
      { ...RECEIPT, failures: 2, passed: false },
      { now: NOW },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("EVIDENCE_FAILED");

    const after = await adapter.calls.createRoom({
      companyUid: "company_a",
      visibility: "private",
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe(CALLS_PREFLIGHT_REQUIRED);
    expect(invocations.filter((c) => c.cmd === "hq_pro_fetch")).toHaveLength(0);
  });

  it("clears a recorded pass when later evidence fails", async () => {
    const { adapter } = makeSync();
    expect((await adapter.calls.preflight(RECEIPT, { now: NOW })).ok).toBe(true);
    expect(adapter.calls.preflightStatus().ok).toBe(true);
    await adapter.calls.preflight({ ...RECEIPT, passed: false }, { now: NOW });
    expect(adapter.calls.preflightStatus().ok).toBe(false);
    const blocked = await adapter.calls.discoverOffice("company_a");
    expect(blocked.ok).toBe(false);
  });
});

describe("native calls transport", () => {
  async function unlocked() {
    const made = makeSync();
    const pass = await made.adapter.calls.preflight(RECEIPT, { now: NOW });
    expect(pass.ok).toBe(true);
    made.invocations.length = 0;
    return made;
  }

  it("invokes the authorized hq-pro routes through hq_pro_fetch", async () => {
    const { adapter, invocations } = await unlocked();
    await adapter.calls.discoverOffice("company_a");
    await adapter.calls.createRoom({
      companyUid: "company_a",
      visibility: "private",
      cohosts: ["bob"],
    });
    await adapter.calls.getRoom("room_a", "company_a");
    await adapter.calls.joinRoom("room_a", { companyUid: "company_a" });
    await adapter.calls.roomLifecycle("room_a", "end", {
      companyUid: "company_a",
    });
    await adapter.calls.listKnocks("company_a", 20);
    await adapter.calls.respondToKnock("knock_a", "accept", "company_a");
    await adapter.calls.signalingControl("admit", { companyUid: "company_a" });
    await adapter.calls.sendSignal({
      signal: { kind: "signal" },
      signature: "sig",
    });
    await adapter.calls.iceConfig({ companyUid: "company_a", mode: "relay-only" });
    await adapter.calls.completionConsent({ companyUid: "company_a" });
    await adapter.calls.completion("finalize", { companyUid: "company_a" });

    expect(invocations.every((c) => c.cmd === "hq_pro_fetch")).toBe(true);
    expect(invocations.map((c) => c.args?.url)).toEqual([
      "/v1/meet-native/office?companyUid=company_a",
      "/v1/meet-native/rooms",
      "/v1/meet-native/rooms/room_a?companyUid=company_a",
      "/v1/meet-native/rooms/room_a/join",
      "/v1/meet-native/rooms/room_a/end",
      "/v1/meet-native/knocks?companyUid=company_a&limit=20",
      "/v1/meet-native/knocks/knock_a/accept",
      "/v1/meet-native/signaling/admit",
      "/v1/meet-native/signaling/send",
      "/v1/meet-native/ice-config",
      "/v1/meet-native/completion/consent",
      "/v1/meet-native/completion/finalize",
    ]);
    expect(invocations.map((c) => c.args?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "POST",
      "GET",
      "POST",
      "POST",
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
  });

  it("stamps the contract version on every request body", async () => {
    const { adapter, invocations } = await unlocked();
    await adapter.calls.createRoom({
      companyUid: "company_a",
      visibility: "company",
    });
    const body = JSON.parse(invocations[0]!.args!.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      version: "hq-meet/1",
      companyUid: "company_a",
      visibility: "company",
      cohosts: [],
    });
  });

  it("sends the signal envelope untouched (already signed)", async () => {
    const { adapter, invocations } = await unlocked();
    const signal = { kind: "signal", version: "hq-meet/1", payload: "v=0" };
    await adapter.calls.sendSignal({ signal, signature: "sig" });
    expect(JSON.parse(invocations[0]!.args!.body as string)).toEqual({
      signal,
      signature: "sig",
    });
  });

  it("preserves the backend error code on non-2xx responses", async () => {
    const made = makeSync(() => ({
      status: 403,
      body: JSON.stringify({
        version: "hq-meet/1",
        code: "COMPANY_ACCESS_DENIED",
        error: "denied",
      }),
    }));
    expect((await made.adapter.calls.preflight(RECEIPT, { now: NOW })).ok).toBe(
      true,
    );
    const result = await made.adapter.calls.getRoom("room_a", "company_b");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("error");
    expect(result.code).toBe("COMPANY_ACCESS_DENIED");
  });

  it("stamps the pinned contract version, ignoring a caller-supplied version", async () => {
    const { adapter, invocations } = await unlocked();
    await adapter.calls.createKnock({
      companyUid: "company_a",
      version: "hq-meet/2",
    } as unknown as Parameters<typeof adapter.calls.createKnock>[0]);
    await adapter.calls.roomLifecycle("room_a", "end", {
      companyUid: "company_a",
      version: "hq-meet/99",
    } as unknown as Parameters<typeof adapter.calls.roomLifecycle>[2]);

    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      const body = JSON.parse(invocation.args!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.version).toBe(CALLS_VERSION);
    }
  });

  it("rejects empty company scoping before touching the network", async () => {
    const { adapter, invocations } = await unlocked();
    const result = await adapter.calls.discoverOffice("  ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.code).toBe("INVALID_INPUT");
    }
    expect(invocations).toHaveLength(0);
  });
});
