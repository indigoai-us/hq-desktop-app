/**
 * US-019 knock store: `GET knocks` is the only authority, duplicates converge
 * on one row, expiry comes from the server's `expiresAt` against an injected
 * clock, and a company switch takes the previous company's knocks with it.
 */

import { describe, expect, it, vi } from "vitest";
import { failure, ok, type AdapterResult, type Json } from "@hq/platform";

import {
  expireKnock,
  isNoteTooLong,
  mergeKnock,
  parseKnock,
  parseKnockList,
  type Knock,
} from "./knocks.js";
import { createKnockStore } from "./knocks.svelte.js";

const NOW = 1_000_000;
const COMPANY = "cmp_a";

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "hq-meet/1",
    companyUid: COMPANY,
    roomId: "room_1",
    callId: "call_1",
    epoch: 3,
    knockId: "knk_1",
    from: "prs_knocker",
    target: "prs_self",
    note: "two minutes?",
    state: "pending",
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    idempotencyKey: "idem_1",
    ...overrides,
  };
}

function store(calls: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return createKnockStore({
    calls: calls as never,
    now: () => NOW,
    companyUid: COMPANY,
    newKey: () => "idem_1",
    resolveRoom: async () => ({ roomId: "room_1", callId: "call_1", epoch: 3 }),
    ...extra,
  });
}

const listing = (rows: unknown[]): AdapterResult<Json> =>
  ok({ version: "hq-meet/1", knocks: rows } as unknown as Json);

describe("knock parsing", () => {
  it("refuses a row missing its binding rather than guessing one", () => {
    expect(parseKnock(wire({ callId: undefined }))).toBeNull();
    expect(parseKnock(null)).toBeNull();
  });

  it("treats an unknown state as expired, never as an actionable door", () => {
    expect(parseKnock(wire({ state: "gremlin" }))?.state).toBe("expired");
  });

  it("carries the admission capability only when the server disclosed one", () => {
    expect(parseKnock(wire())?.admissionCapability).toBeUndefined();
    const accepted = parseKnock(
      wire({
        state: "accepted",
        admissionCapability: { grantId: "grant_1", expiresAt: NOW + 20_000 },
      }),
    );
    expect(accepted?.admissionCapability).toEqual({
      grantId: "grant_1",
      expiresAt: NOW + 20_000,
    });
  });

  it("drops unparseable rows from a listing instead of failing the page", () => {
    expect(parseKnockList({ knocks: [wire(), { nonsense: true }] })).toHaveLength(1);
  });

  it("expires against the server's own expiresAt", () => {
    const knock = parseKnock(wire())!;
    expect(expireKnock(knock, NOW).state).toBe("pending");
    expect(expireKnock(knock, NOW + 40_000).state).toBe("expired");
    // Local expiry never rewrites a decision the server already made.
    const accepted = { ...knock, state: "accepted" as const };
    expect(expireKnock(accepted, NOW + 40_000).state).toBe("accepted");
  });

  it("merges by knockId and keeps the newer observation", () => {
    const first = parseKnock(wire())!;
    const newer: Knock = { ...first, state: "accepted", updatedAt: NOW };
    const stale: Knock = { ...first, state: "pending", updatedAt: NOW - 5_000 };
    expect(mergeKnock([first], newer)).toHaveLength(1);
    expect(mergeKnock([first], newer)[0].state).toBe("accepted");
    expect(mergeKnock([newer], stale)[0].state).toBe("accepted");
  });

  it("measures the note cap in bytes, as the server does", () => {
    expect(isNoteTooLong("a".repeat(512))).toBe(false);
    expect(isNoteTooLong("a".repeat(513))).toBe(true);
    // 171 three-byte characters = 513 bytes, under the character count.
    expect(isNoteTooLong("あ".repeat(171))).toBe(true);
  });
});

describe("knock store", () => {
  it("renders ONE card for a knock observed twice, and announces it once", async () => {
    const arrived = vi.fn();
    const listKnocks = vi.fn(async () => listing([wire()]));
    const subject = store({ listKnocks }, { onKnockArrived: arrived });
    await subject.refresh();
    await subject.refresh();
    expect(subject.visibleReceived()).toHaveLength(1);
    expect(arrived).toHaveBeenCalledTimes(1);
  });

  it("never announces a knock that is already past its expiry", async () => {
    const arrived = vi.fn();
    const subject = store(
      { listKnocks: async () => listing([wire({ expiresAt: NOW - 1 })]) },
      { onKnockArrived: arrived },
    );
    await subject.refresh();
    expect(arrived).not.toHaveBeenCalled();
    expect(subject.visibleReceived()[0].state).toBe("expired");
  });

  it("drops a company's knocks synchronously on a switch, and ignores its late answer", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const subject = store({
      listKnocks: async () => {
        await gate;
        return listing([wire()]);
      },
    });
    const inflight = subject.refresh();
    subject.bind("cmp_b");
    expect(subject.state.received).toHaveLength(0);
    release!();
    await inflight;
    expect(subject.visibleReceived()).toHaveLength(0);
  });

  it("surfaces the server's refusal on accept and re-reads the row", async () => {
    const getKnock = vi.fn(async () => ok(wire({ state: "expired" }) as unknown as Json));
    const subject = store({
      listKnocks: async () => listing([wire()]),
      getKnock,
      respondToKnock: async () => failure("CAPACITY_EXCEEDED", "full"),
    });
    await subject.refresh();
    const accepted = await subject.accept("knk_1");
    expect(accepted).toBeNull();
    expect(subject.state.error?.code).toBe("CAPACITY_EXCEEDED");
    expect(subject.state.error?.message).toBe("That room is full.");
    expect(getKnock).toHaveBeenCalledWith("knk_1", COMPANY);
    expect(subject.visibleReceived()[0].state).toBe("expired");
  });

  it("reports a suppressed knock as sent-but-not-shown, not as a failure", async () => {
    const subject = store({
      createKnock: async () =>
        ok({ created: false, duplicate: false, suppressed: "dnd", waked: false } as unknown as Json),
    });
    const outcome = await subject.send("prs_target", "hi");
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toBe(false);
    expect(outcome.suppressed).toBe("dnd");
  });

  it("reports a repeated idempotency key as a duplicate, with the same knock", async () => {
    const subject = store({
      createKnock: async () =>
        ok({ created: false, duplicate: true, waked: false, knock: wire({ from: "prs_self", target: "prs_other" }) } as unknown as Json),
    });
    const outcome = await subject.send("prs_other");
    expect(outcome.duplicate).toBe(true);
    expect(subject.visibleSent()).toHaveLength(1);
  });

  it("refuses locally when there is no room to knock about — no request goes out", async () => {
    const createKnock = vi.fn();
    const subject = store({ createKnock }, { resolveRoom: async () => null });
    const outcome = await subject.send("prs_other");
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("KNOCK_NO_ROOM");
    expect(createKnock).not.toHaveBeenCalled();
  });

  it("refuses an oversized note before spending a request on it", async () => {
    const createKnock = vi.fn();
    const subject = store({ createKnock });
    const outcome = await subject.send("prs_other", "a".repeat(513));
    expect(outcome.ok).toBe(false);
    expect(createKnock).not.toHaveBeenCalled();
  });

  it("folds a decline into the row every window then reads back", async () => {
    const subject = store({
      listKnocks: async () => listing([wire()]),
      respondToKnock: async () => ok(wire({ state: "declined", updatedAt: NOW }) as unknown as Json),
    });
    await subject.refresh();
    const declined = await subject.decline("knk_1");
    expect(declined?.state).toBe("declined");
    expect(subject.visibleReceived()).toHaveLength(1);
    expect(subject.visibleReceived()[0].state).toBe("declined");
  });

  it("says so, in words, on a host with no knock methods at all", async () => {
    const subject = store({});
    await subject.refresh();
    expect(subject.state.error?.code).toBe("CALLS_UNSUPPORTED_HOST");
    const outcome = await subject.send("prs_other");
    expect(outcome.ok).toBe(false);
  });
});
