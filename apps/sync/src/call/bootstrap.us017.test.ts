/**
 * US-017 — the call window wired to the active account.
 *
 * `auth.test.ts` and `permissions.test.ts` pin the units. This file pins the
 * wiring: that the identity gate stands in front of the signer and the join,
 * that a grant landing after an account switch is discarded rather than used,
 * and that no path through the bootstrap reaches `getUserMedia` on its own.
 */

import { describe, expect, it, vi } from "vitest";
import { PINNED_CONTRACT_HASH } from "@hq/platform";

import { AUTH_SESSION_EVENT } from "./auth";
import {
  startCallWindow,
  type CallInvoke,
  type CallWindowDeps,
} from "./bootstrap";
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

const SESSION_ID = "cmp-1:room-1:call-1:7";

function target(overrides: Partial<CallWindowTarget> = {}): CallWindowTarget {
  return {
    sessionId: SESSION_ID,
    companyUid: "cmp-1",
    roomId: "room-1",
    callId: "call-1",
    epoch: 7,
    grant: {
      grantId: "grant-1",
      expiresAt: 1_800_000_000_000,
      renewAfterMs: 30_000,
      trafficStopMs: 10_000,
      controlPollMs: 1_000,
    },
    self: { personUid: "prs_1", deviceId: "dev-1" },
    evidence: EVIDENCE,
    ...overrides,
  };
}

interface Bench {
  deps: CallWindowDeps;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  commands: () => string[];
  argsOf: (command: string) => Record<string, unknown> | undefined;
  emit: (event: string, payload: unknown) => void;
  getUserMedia: ReturnType<typeof vi.fn>;
  whoami: ReturnType<typeof vi.fn>;
}

function bench(
  options: {
    generation?: number;
    personUid?: string | null;
    invoke?: CallInvoke;
    target?: CallWindowTarget;
  } = {},
): Bench {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const invoke: CallInvoke = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    const custom = await options.invoke?.(command, args);
    if (custom !== undefined) return custom;
    if (command === "calls_take_pending_target") {
      return options.target ?? target();
    }
    if (command === "get_auth_session") {
      return {
        accountId: "acct-1",
        generation: options.generation ?? 1,
        status: "active",
        reason: null,
      };
    }
    // Every hq-pro round trip refuses politely; this story never needs a live
    // signaling exchange, and a refusal keeps the test free of network shape.
    if (command === "hq_pro_fetch") return { status: 503, body: "{}" };
    return null;
  };

  const whoami = vi.fn(async () =>
    options.personUid === null
      ? { ok: false as const, reason: "error" as const }
      : {
          ok: true as const,
          value: { personUid: options.personUid ?? "prs_1", email: "a@b.c" },
        },
  );
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ id: "audio-1", kind: "audio", stop: vi.fn() }],
  }));

  const deps: CallWindowDeps = {
    invoke,
    listen: async (event, handler) => {
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
    targetWaitMs: 20,
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
    identity: { whoami: whoami as never },
    getUserMedia: getUserMedia as never,
    storage: null,
  };

  return {
    deps,
    calls,
    commands: () => calls.map((entry) => entry.command),
    argsOf: (command) =>
      calls.find((entry) => entry.command === command)?.args,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
    getUserMedia,
    whoami,
  };
}

describe("identity gate", () => {
  it("pauses with a recoverable error and never mints a key when identity is unresolved", async () => {
    const createSigner = vi.fn();
    const harness = bench({
      personUid: "6f0a1e2c-1111-4222-8333-444455556666",
    });
    harness.deps.createSigner = createSigner as never;
    const handle = await startCallWindow(harness.deps);

    expect(handle.state().status).toBe("identity");
    expect(handle.state().code).toBe("IDENTITY_UNRESOLVED");
    expect(handle.state().recoverable).toBe(true);
    expect(handle.session).toBeNull();
    expect(createSigner).not.toHaveBeenCalled();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    // The window still holds the call: the registry entry must NOT be released
    // on a recoverable refusal, or the Retry would have nothing to join.
    expect(harness.commands()).not.toContain("calls_release");
    await handle.close();
  });

  it("joins on Retry once the canonical identity resolves", async () => {
    let personUid = "6f0a1e2c-1111-4222-8333-444455556666";
    const harness = bench();
    harness.deps.identity = {
      whoami: (async () => ({
        ok: true as const,
        value: { personUid },
      })) as never,
    };
    const handle = await startCallWindow(harness.deps);
    expect(handle.session).toBeNull();

    personUid = "prs_1";
    await handle.retryIdentity();
    expect(handle.session).not.toBeNull();
    expect(handle.state().status).not.toBe("identity");
    await handle.close();
  });

  it("refuses and releases when the account is not the one the grant names", async () => {
    const harness = bench({ personUid: "prs_2" });
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().status).toBe("error");
    expect(handle.state().code).toBe("IDENTITY_MISMATCH");
    expect(handle.state().recoverable).toBe(false);
    expect(handle.session).toBeNull();
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "identity_mismatch",
    });
    await handle.close();
  });
});

describe("account-generation binding", () => {
  it("invalidates the call, stops capture and releases on an account change", async () => {
    const stop = vi.fn();
    const harness = bench();
    harness.deps.getUserMedia = (async () => ({
      getTracks: () => [{ id: "audio-1", kind: "audio", stop }],
    })) as never;
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    expect(handle.media?.tracks()).toHaveLength(1);

    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-2",
      generation: 2,
      status: "active",
      reason: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.account?.invalidated).toBe(true);
    expect(handle.state().code).toBe("ACCOUNT_CHANGED");
    expect(stop).toHaveBeenCalled();
    expect(handle.media?.tracks()).toEqual([]);
    expect(handle.content.open()).toBe(false);
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "account-changed",
    });
    await handle.close();
  });

  it("ignores a replayed envelope for its own generation", async () => {
    const harness = bench({ generation: 4 });
    const handle = await startCallWindow(harness.deps);
    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-1",
      generation: 4,
      status: "active",
      reason: null,
    });
    expect(handle.account?.invalidated).toBe(false);
    expect(handle.state().code).not.toBe("ACCOUNT_CHANGED");
    await handle.close();
  });

  it("discards a grant that resolves after the account changed", async () => {
    const harness = bench();
    let signal: (() => void) | undefined;
    harness.deps.createSigner = (async () => {
      // The account switches while the device key is being minted, i.e. while
      // the join is in flight and its grant is still in the air.
      signal?.();
      return {
        peerKey: "d".repeat(64),
        publicKey: "e".repeat(43),
        sign: async () => "f".repeat(86),
      };
    }) as never;
    const started = startCallWindow(harness.deps);
    signal = () =>
      harness.emit(AUTH_SESSION_EVENT, {
        accountId: "acct-2",
        generation: 9,
        status: "active",
        reason: null,
      });
    const handle = await started;

    expect(handle.account?.invalidated).toBe(true);
    // The session built under the old account never became usable.
    expect(handle.session).toBeNull();
    expect(handle.media?.tracks()).toEqual([]);
    await handle.close();
  });

  it("holds its own company uid and subscribes to nothing company-scoped", async () => {
    const listened: string[] = [];
    const harness = bench();
    const inner = harness.deps.listen;
    harness.deps.listen = async (event, handler) => {
      listened.push(event);
      return inner(event, handler);
    };
    const handle = await startCallWindow(harness.deps);
    expect(handle.account?.companyUid).toBe("cmp-1");
    expect(
      listened.some((event) => /company|workspace|navigat/i.test(event)),
    ).toBe(false);
    await handle.close();
  });
});

describe("capture is explicit", () => {
  it("captures nothing on mount, and nothing on a received knock", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(harness.getUserMedia).not.toHaveBeenCalled();

    // Nothing in this window subscribes to knocks, and delivering one anyway
    // must not reach capture.
    harness.emit("calls:knock", { knockId: "knk-1" });
    await Promise.resolve();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(handle.state().media.microphone.status).toBe("idle");
    await handle.close();
  });

  it("captures only from the explicit join control, and republishes in place", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    const refresh = vi.spyOn(
      handle.session as { refreshLocalTracks: () => void },
      "refreshLocalTracks",
    );

    await handle.setDevice("microphone", true);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    expect(handle.state().media.microphone.active).toBe(true);
    expect(handle.state().preferences.microphone).toBe(true);
    expect(refresh).toHaveBeenCalled();

    await handle.setDevice("microphone", false);
    expect(handle.state().media.microphone.active).toBe(false);
    expect(handle.state().preferences.microphone).toBe(false);
    await handle.close();
  });

  it("stops every local track on leave", async () => {
    const stop = vi.fn();
    const harness = bench();
    harness.deps.getUserMedia = (async () => ({
      getTracks: () => [{ id: "audio-1", kind: "audio", stop }],
    })) as never;
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    await handle.leave("leave-button");
    expect(stop).toHaveBeenCalled();
    expect(handle.content.open()).toBe(false);
    await handle.close();
  });
});

describe("native wiring", () => {
  it("publishes the auth session envelope to the call window, not only the shell", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../../src-tauri/src/commands/auth.rs", import.meta.url),
      "utf8",
    );
    // Without this emit the call window never learns about a sign-out or an
    // account switch, and a live call outlives the account that authorized it.
    expect(source).toContain("commands::calls::CALL_WINDOW_LABEL");
    expect(source).toContain('pub const AUTH_SESSION_CHANGED_EVENT: &str = "auth:session-changed"');
    expect(AUTH_SESSION_EVENT).toBe("auth:session-changed");
  });
});

describe("transcription barrier", () => {
  it("starts off and never reports ready without a consent acknowledgement", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().transcription).toBe("off");

    await handle.setTranscription(true);
    // hq-pro refuses in this bench, so the acknowledgement is unavailable:
    // the barrier must stay visibly paused rather than optimistically ready.
    expect(handle.state().transcription).toBe("paused");
    expect(handle.state().consentUnavailable).toBe(true);
    expect(handle.consent?.recognitionAllowed()).toBe(false);

    await handle.setTranscription(false);
    expect(handle.state().transcription).toBe("off");
    await handle.close();
  });
});
