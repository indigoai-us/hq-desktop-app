/**
 * US-016 — the call window's bootstrap contract.
 *
 * Proves invoke actually reaches the native seam by pinning the exact command
 * names and their order, and pins the two things that must never happen: a
 * target read from the URL, and a credential riding in on one.
 */

import { describe, expect, it, vi } from "vitest";
import { PINNED_CONTRACT_HASH } from "@hq/platform";

import {
  CALL_DISPOSE_EVENT,
  CALL_TARGET_EVENT,
  pendingCompletionState,
  resolveCallTarget,
  startCallWindow,
  type CallInvoke,
  type CallWindowDeps,
} from "./bootstrap";
import { hasNoCredentialFields, isCallWindowTarget } from "./target";
import type { CallWindowTarget } from "./target";

const EVIDENCE = {
  schema: "hq-meet-staging-proof/v1",
  story: "US-011",
  stage: "staging",
  apiBase: "https://hqapi.example.com",
  deployedRevision: {
    serviceCommit: "a".repeat(40),
    configHash: "b".repeat(64),
  },
  contractHash: PINNED_CONTRACT_HASH,
  runAt: new Date().toISOString(),
  failures: 0,
  passed: true,
};

function target(overrides: Partial<CallWindowTarget> = {}): CallWindowTarget {
  return {
    sessionId: "cmp-1:room-1:call-1:7",
    companyUid: "cmp-1",
    roomId: "room-1",
    callId: "call-1",
    epoch: 7,
    grant: {
      grantId: "grant-1",
      expiresAt: Date.now() + 600_000,
      renewAfterMs: 30_000,
      trafficStopMs: 10_000,
      controlPollMs: 1_000,
    },
    self: { personUid: "prs-1", deviceId: "dev-1" },
    evidence: EVIDENCE,
    ...overrides,
  };
}

interface Harness {
  deps: CallWindowDeps;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  emit: (event: string, payload: unknown) => void;
  listened: string[];
}

function harness(
  options: {
    pending?: unknown;
    invoke?: CallInvoke;
    targetWaitMs?: number;
  } = {},
): Harness {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const invoke: CallInvoke = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    if (options.invoke) return options.invoke(command, args);
    if (command === "calls_take_pending_target") return options.pending ?? null;
    return null;
  };
  const listened: string[] = [];
  const deps: CallWindowDeps = {
    invoke,
    listen: async (event, handler) => {
      listened.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((entry) => entry !== handler),
        );
      };
    },
    targetWaitMs: options.targetWaitMs ?? 50,
    createSigner: async () => ({
      peerKey: "d".repeat(64),
      publicKey: "e".repeat(43),
      sign: async () => "f".repeat(86),
    }),
    connections: {
      create: () => {
        throw new Error("no peer connection expected in this test");
      },
    },
  };
  return {
    deps,
    calls,
    listened,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
  };
}

describe("resolveCallTarget", () => {
  it("drains exactly one pending target on a cold open", async () => {
    const bench = harness({ pending: target() });
    const resolved = await resolveCallTarget(bench.deps);
    expect(resolved).toEqual(target());
    expect(bench.calls.map((call) => call.command)).toEqual([
      "calls_take_pending_target",
    ]);
    // No global listener needed when the pending slot answered.
    expect(bench.listened).toEqual([]);
  });

  it("accepts exactly one warm target from the window-scoped event", async () => {
    const bench = harness({ targetWaitMs: 1_000 });
    const pending = resolveCallTarget(bench.deps);
    await Promise.resolve();
    bench.emit(CALL_TARGET_EVENT, target());
    bench.emit(CALL_TARGET_EVENT, target({ sessionId: "other" }));
    expect(await pending).toEqual(target());
    expect(bench.listened).toEqual([CALL_TARGET_EVENT]);
  });

  it("gives up, bounded, when nothing authorizes this window", async () => {
    const bench = harness({ targetWaitMs: 5 });
    expect(await resolveCallTarget(bench.deps)).toBeNull();
  });

  it("never reads a target from the URL or query string", async () => {
    const bench = harness({ targetWaitMs: 5 });
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./bootstrap.ts", import.meta.url), "utf8"),
    );
    for (const forbidden of [
      "location.search",
      "URLSearchParams",
      "window.location",
      "localStorage",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(await resolveCallTarget(bench.deps)).toBeNull();
  });
});

describe("startCallWindow", () => {
  it("acknowledges the mount and reaches Rust in the pinned order", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    expect(handle.target?.sessionId).toBe("cmp-1:room-1:call-1:7");
    expect(bench.calls.slice(0, 2).map((call) => call.command)).toEqual([
      "calls_take_pending_target",
      "calls_window_ready",
    ]);
    expect(bench.calls[1]?.args).toEqual({
      sessionId: "cmp-1:room-1:call-1:7",
    });
    expect(bench.listened).toContain(CALL_DISPOSE_EVENT);
    await handle.close();
  });

  it("leaves, persists pending work and releases the registry entry", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    await handle.leave("window-close");
    const commands = bench.calls.map((call) => call.command);
    expect(commands).toContain("calls_persist_pending");
    expect(commands.indexOf("calls_persist_pending")).toBeLessThan(
      commands.indexOf("calls_release"),
    );
    const release = bench.calls.find(
      (call) => call.command === "calls_release",
    );
    expect(release?.args).toEqual({
      sessionId: "cmp-1:room-1:call-1:7",
      reason: "window-close",
    });
    expect(handle.state().status).toBe("left");
    await handle.close();
  });

  it("answers the app-quit dispose event with calls_disposed", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    await handle.dispose();
    expect(bench.calls.map((call) => call.command)).toContain("calls_disposed");
    await handle.close();
  });

  it("shows a clear error state when no target ever arrives", async () => {
    const bench = harness({ targetWaitMs: 5 });
    const seen: string[] = [];
    const handle = await startCallWindow({
      ...bench.deps,
      onState: (state) => seen.push(state.status),
    });
    expect(handle.target).toBeNull();
    expect(handle.state().code).toBe("NO_CALL_TARGET");
    expect(seen).toContain("error");
    // Nothing is acknowledged for a call this window was never authorized for.
    expect(bench.calls.map((call) => call.command)).not.toContain(
      "calls_window_ready",
    );
  });

  it("refuses to run on failing service evidence", async () => {
    const bench = harness({ pending: target({ evidence: { nope: true } }) });
    const handle = await startCallWindow(bench.deps);
    expect(handle.session).toBeNull();
    expect(handle.state().status).toBe("error");
    expect(handle.state().code).toBe("EVIDENCE_SCHEMA");
  });
});

describe("no credential ever reaches this window", () => {
  it("rejects a target carrying credential-shaped fields, at any depth", () => {
    expect(isCallWindowTarget(target())).toBe(true);
    expect(
      isCallWindowTarget({
        ...target(),
        grant: { ...target().grant, token: "x" },
      }),
    ).toBe(false);
    expect(hasNoCredentialFields({ a: { b: { authorization: "x" } } })).toBe(
      false,
    );
    expect(hasNoCredentialFields([{ "API-Key": "x" }])).toBe(false);
    expect(hasNoCredentialFields(target())).toBe(true);
  });

  it("keeps the durable pending record content-free", () => {
    const state = pendingCompletionState(target());
    expect(state).toEqual({
      version: 1,
      sessionId: "cmp-1:room-1:call-1:7",
      binding: {
        companyUid: "cmp-1",
        roomId: "room-1",
        callId: "call-1",
        epoch: 7,
      },
      pendingCompletion: null,
    });
    expect(hasNoCredentialFields(state)).toBe(true);
  });
});

describe("native wiring", () => {
  it("registers every command it invokes in the Rust invoke handler", async () => {
    const fs = await import("node:fs/promises");
    const main = await fs.readFile(
      new URL("../../src-tauri/src/main.rs", import.meta.url),
      "utf8",
    );
    for (const command of [
      "calls_open_window",
      "calls_take_pending_target",
      "calls_window_ready",
      "calls_release",
      "calls_persist_pending",
      "calls_take_recovered",
      "calls_disposed",
    ]) {
      expect(main).toContain(`commands::calls::${command},`);
    }
  });

  it("scopes the call capability to the exact window label", async () => {
    const fs = await import("node:fs/promises");
    const capability = JSON.parse(
      await fs.readFile(
        new URL("../../src-tauri/capabilities/call-window.json", import.meta.url),
        "utf8",
      ),
    ) as { windows: string[]; permissions: string[] };
    expect(capability.windows).toEqual(["call"]);
    expect(capability.permissions).toContain("core:window:allow-start-dragging");
    for (const widened of ["http:default", "fs:allow-write-file", "shell:allow-open"]) {
      expect(capability.permissions).not.toContain(widened);
    }
  });
});

describe("signer vectors", () => {
  it("produces a signature the platform verifier accepts", async () => {
    const { createDeviceSigner } = await import("./signer");
    const { verifyEnvelope } = await import("@hq/platform");
    const signer = await createDeviceSigner();
    const envelope: Record<string, unknown> = {
      version: "hq-meet/1",
      kind: "control",
      companyUid: "cmp-1",
      roomId: "room-1",
      callId: "call-1",
      epoch: 7,
      operation: "renew",
      personUid: "prs-1",
      deviceId: "dev-1",
      peerKey: signer.peerKey,
      requestId: "req-1",
      sentAt: 1_700_000_000_000,
    };
    envelope.signature = await signer.sign(envelope);
    expect(String(envelope.signature)).toHaveLength(86);
    await expect(
      verifyEnvelope(envelope, signer.publicKey),
    ).resolves.toBeUndefined();
  });

  it("matches the golden vectors' keyId derivation", async () => {
    const { keyId } = await import("@hq/platform");
    const fs = await import("node:fs/promises");
    const rows = JSON.parse(
      await fs.readFile(
        new URL(
          "../../../../packages/platform/src/calls/golden/crypto-vectors.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{ publicKey: string; peerKey: string }>;
    const row = rows[0]!;
    expect(await keyId(row.publicKey)).toBe(row.peerKey);
  });
});

describe("mock invoke failures never wedge the window", () => {
  it("surfaces a refusal instead of throwing when Rust rejects readiness", async () => {
    const failing = vi.fn(async (command: string) => {
      if (command === "calls_take_pending_target") return target();
      if (command === "calls_window_ready") throw new Error("unknown call session");
      return null;
    });
    const bench = harness({ invoke: failing as unknown as CallInvoke });
    await expect(startCallWindow(bench.deps)).rejects.toThrow(
      "unknown call session",
    );
  });
});
