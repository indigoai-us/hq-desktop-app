// @vitest-environment happy-dom

/**
 * US-019 story acceptance tests (surface half) — "Deliver subtle knocks and
 * explicit open-door actions".
 *
 * Story-level regression cover for the three PRD e2e statements plus the named
 * failure and authorization paths:
 *
 *   e2e 1 — a knock delivered twice is ONE quiet actionable item, announced
 *           once, with no media capture; do not disturb suppresses the banner
 *           without touching the server's record of the knock.
 *   e2e 2 — accepting after expiry / revocation / capacity exhaustion fails in
 *           words and does NOT enter the room.
 *   e2e 3 — defer / text reply / dismiss complete without starting a call, and
 *           every window converges on the same state.
 *
 * `knocks.svelte.test.ts`, `KnockCard.svelte.test.ts` and
 * `OfficeHours.knocks.test.ts` pin the units. This file pins what they add up
 * to when someone is actually at the door: the panel's notification decision,
 * the accept path's refusals, and the three quiet answers.
 *
 * Everything drives the public `meet` barrel with an injected fake `calls`
 * group and fake timers. No network, no hq-pro, no real clock, no capture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick as svelteTick, unmount } from "svelte";
import { failure, ok, type Json } from "@hq/platform";

import { meet } from "../index.js";

const { OfficeHours, OfficePanel, createKnockStore, createOfficeStore } = meet;

type KnockStore = meet.KnockStore;
type OfficeStore = meet.OfficeStore;

const BASE = 1_700_000_000_000;
const COMPANY = "cmp_a";
const SELF = "prs_self";
const PEER = "prs_open";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;
let getUserMedia: ReturnType<typeof vi.fn>;

function teardown(): void {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(BASE);
  // The capture seam, watched for the whole file: opening a door must never
  // reach for a microphone or a camera on its own.
  getUserMedia = vi.fn(async () => {
    throw new Error("capture must not start from a knock");
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [] },
  });
});

afterEach(() => {
  teardown();
  vi.useRealTimers();
});

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function text(root: HTMLElement, id: string): string {
  return testid(root, id)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function cards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-testid^="knock-card-"]')];
}

/** Let a chain of already-resolved adapter promises and effects settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
    await svelteTick();
    flushSync();
  }
}

// ── wire fixtures ────────────────────────────────────────────────────────────

interface KnockOverrides {
  [key: string]: unknown;
}

function knockWire(overrides: KnockOverrides = {}): Record<string, unknown> {
  return {
    knockId: "knk_1",
    companyUid: COMPANY,
    roomId: "room_peer",
    callId: "call_peer",
    epoch: 4,
    from: PEER,
    target: SELF,
    note: "two minutes on pricing?",
    state: "pending",
    createdAt: BASE - 1_000,
    updatedAt: BASE - 1_000,
    expiresAt: BASE + 30_000,
    ...overrides,
  };
}

function personWire(personUid: string, willingness: string) {
  return {
    personUid,
    connectivity: "online",
    connectivityExpiresAt: BASE + 600_000,
    willingness,
    willingnessExpiresAt: BASE + 600_000,
    occupancy: "unoccupied",
    occupancyExpiresAt: null,
  };
}

function roster(selfWillingness: string) {
  return ok({
    companyUid: COMPANY,
    observedAt: BASE,
    people: [personWire(SELF, selfWillingness), personWire(PEER, "knock")],
  } as unknown as Json);
}

// ── panel harness ────────────────────────────────────────────────────────────

interface PanelOptions {
  selfWillingness?: string;
  /** Answers for `GET /knocks`, consumed one per call (last one repeats). */
  listings?: Array<Record<string, unknown>[]>;
  getKnock?: (knockId: string) => Promise<unknown>;
  respondToKnock?: (knockId: string, action: string) => Promise<unknown>;
  createKnock?: (input: Record<string, unknown>) => Promise<unknown>;
  createRoom?: () => Promise<unknown>;
  sendDm?: (to: string, body: string) => Promise<unknown>;
  osNotifications?: boolean;
}

interface PanelHarness {
  root: HTMLElement;
  notifications: Array<Record<string, unknown>>;
  openCallWindow: ReturnType<typeof vi.fn>;
  sendDm: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  created: Array<Record<string, unknown>>;
  listCalls: () => number;
}

/**
 * Mount the shared OfficePanel over a fake adapter. This is the surface that
 * actually decides whether to notify, so DND suppression and the "no window on
 * a refusal" rule are pinned here rather than simulated.
 */
async function renderPanel(options: PanelOptions = {}): Promise<PanelHarness> {
  teardown();
  const notifications: Array<Record<string, unknown>> = [];
  const openCallWindow = vi.fn(async () => undefined);
  const sendDm = vi.fn(
    options.sendDm ?? (async () => ok({} as Json) as unknown),
  );
  const respond = vi.fn(
    options.respondToKnock ??
      (async (_id: string, _action: string) => ok({} as Json) as unknown),
  );
  const created: Array<Record<string, unknown>> = [];
  const listings = options.listings ?? [[]];
  let listIndex = 0;
  let listCount = 0;
  let roomSeq = 0;

  const adapter = {
    kind: "desktop",
    capabilities: {
      nativeCalls: true,
      osNotifications: options.osNotifications !== false,
    },
    isAvailable: () => true,
    calls: {
      preflight: async () => ok({ passed: true } as never),
      discoverOffice: async () => roster(options.selfWillingness ?? "knock"),
      setOfficePreference: async () => ok({} as Json),
      setOfficeConnectivity: async () => ok({} as Json),
      createRoom:
        options.createRoom ??
        (async () => {
          roomSeq += 1;
          return ok({
            room: { roomId: `room_self_${roomSeq}` },
            call: { callId: `call_self_${roomSeq}`, epoch: roomSeq },
          } as unknown as Json);
        }),
      createKnock: async (input: Record<string, unknown>) => {
        created.push(input);
        return options.createKnock
          ? await options.createKnock(input)
          : ok({ created: true, waked: true } as unknown as Json);
      },
      listKnocks: async () => {
        listCount += 1;
        const rows = listings[Math.min(listIndex, listings.length - 1)] ?? [];
        if (listIndex < listings.length - 1) listIndex += 1;
        return ok({ knocks: rows } as unknown as Json);
      },
      getKnock: options.getKnock
        ? async (knockId: string) => await options.getKnock!(knockId)
        : async () => ok(knockWire() as unknown as Json),
      respondToKnock: respond,
    },
    identity: { whoami: async () => ok({ personUid: SELF } as never) },
    messaging: { sendDm },
    appShell: {
      showOsNotification: async (payload: Record<string, unknown>) => {
        notifications.push(payload);
        return ok({} as Json);
      },
    },
  };

  const callsHost = {
    serviceEvidence: {},
    evidenceMaxAgeMs: 10_000_000,
    openCallWindow,
    resolveDeviceId: async () => "dev_self",
  };

  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(OfficePanel as never, {
    target: host,
    props: {
      adapter,
      callsHost,
      companyUid: COMPANY,
      knockPollMs: 1_000,
    } as never,
  });
  flushSync();
  await settle();
  return {
    root: host!,
    notifications,
    openCallWindow,
    sendDm,
    respond,
    created,
    listCalls: () => listCount,
  };
}

/** Run the panel's knock poll `times` times and let each answer land. */
async function poll(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
  }
}

// ── store + view harness ─────────────────────────────────────────────────────

function officeStore(): OfficeStore {
  return createOfficeStore({
    calls: {
      discoverOffice: (async () => roster("knock")) as never,
      setOfficePreference: (async () => ok({} as Json)) as never,
      setOfficeConnectivity: (async () => ok({} as Json)) as never,
    },
    selfPersonUid: SELF,
    now: () => BASE,
  });
}

function knockStore(calls: Record<string, unknown>, extra: {
  onKnockArrived?: (knock: meet.Knock) => void;
} = {}): KnockStore {
  return createKnockStore({
    calls: calls as never,
    now: () => BASE,
    companyUid: COMPANY,
    newKey: () => "idem_1",
    resolveRoom: async () => ({
      roomId: "room_self",
      callId: "call_self",
      epoch: 1,
    }),
    ...(extra.onKnockArrived ? { onKnockArrived: extra.onKnockArrived } : {}),
  });
}

async function renderOffice(props: Record<string, unknown>): Promise<HTMLElement> {
  teardown();
  const office = officeStore();
  await office.load(COMPANY);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(OfficeHours as never, {
    target: host,
    props: {
      store: office,
      selfPersonUid: SELF,
      now: () => BASE,
      tickMs: 0,
      ...props,
    } as never,
  });
  flushSync();
  return host!;
}

// ── e2e 1 ────────────────────────────────────────────────────────────────────

describe("US-019 e2e 1: a knock delivered twice is one quiet item", () => {
  it("renders ONE actionable card however many times the same knock is observed", async () => {
    const announced: string[] = [];
    const knocks = knockStore(
      {
        listKnocks: async () => ok({ knocks: [knockWire()] } as unknown as Json),
        getKnock: async () => ok(knockWire() as unknown as Json),
      },
      { onKnockArrived: (knock) => announced.push(knock.knockId) },
    );
    // Three independent observations of the same door: two list reads and a
    // single-row re-read, exactly what a poll plus a duplicate wake produces.
    await knocks.refresh();
    await knocks.refresh();
    await knocks.reload("knk_1");

    const root = await renderOffice({ knocks });
    expect(cards(root)).toHaveLength(1);
    expect(testid(root, "knock-card-knk_1")?.dataset.state).toBe("pending");
    expect(testid(root, "knock-accept-knk_1")).not.toBeNull();
    expect(announced).toEqual(["knk_1"]);
  });

  it("is a polite status region, not a ring — and nothing reaches for capture", async () => {
    const harness = await renderPanel({ listings: [[], [knockWire()]] });
    await poll(1);

    const card = testid(harness.root, "knock-card-knk_1")!;
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-live")).toBe("polite");
    // No modal, no media element, and — the authorization point — no capture.
    expect(harness.root.querySelector("dialog")).toBeNull();
    expect(harness.root.querySelector("audio")).toBeNull();
    expect(harness.root.querySelector("video")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    // The card says what a join WOULD take in, before anything is taken in.
    expect(text(harness.root, "knock-join-intent-knk_1")).toContain(
      "Camera stays off",
    );
  });

  it("announces a duplicated wake exactly once", async () => {
    // The same row keeps coming back on every poll — three deliveries, one
    // notification, because the store dedupes by knockId.
    const harness = await renderPanel({ listings: [[], [knockWire()]] });
    await poll(3);

    expect(cards(harness.root)).toHaveLength(1);
    expect(harness.notifications).toHaveLength(1);
    expect(String(harness.notifications[0].title)).toContain("knocked");
    expect(String(harness.notifications[0].body)).toContain("two minutes");
  });

  it("suppresses the banner on do not disturb but keeps the server's knock", async () => {
    const harness = await renderPanel({
      selfWillingness: "dnd",
      listings: [[], [knockWire()]],
    });
    await poll(2);

    // Nothing disturbed anyone…
    expect(harness.notifications).toEqual([]);
    // …and the server's record is untouched: the knock is still listed, in its
    // own state, still answerable in the app.
    expect(cards(harness.root)).toHaveLength(1);
    expect(text(harness.root, "knock-state-knk_1")).toContain(
      "Waiting for an answer",
    );
    expect(testid(harness.root, "knock-accept-knk_1")).not.toBeNull();
  });

  it("never offers a door for a wire state it does not understand", async () => {
    const knocks = knockStore({
      listKnocks: async () =>
        ok({
          knocks: [knockWire({ knockId: "knk_x", state: "ringing" })],
        } as unknown as Json),
    });
    await knocks.refresh();
    const root = await renderOffice({ knocks });

    expect(testid(root, "knock-card-knk_x")?.dataset.state).toBe("expired");
    expect(testid(root, "knock-accept-knk_x")).toBeNull();
    expect(testid(root, "knock-defer-knk_x")).toBeNull();
    expect(testid(root, "knock-dismiss-knk_x")).toBeNull();
  });
});

// ── e2e 2 ────────────────────────────────────────────────────────────────────

/**
 * Every refusal below is the SERVER's: acceptance re-checks membership, epoch,
 * capacity and the seal, so the surface must report what came back and stay
 * out of the room rather than opening a window optimistically.
 */
describe("US-019 e2e 2: opening a door the server will not open", () => {
  async function refusedAccept(
    code: string,
    reloadState: string,
  ): Promise<PanelHarness> {
    const harness = await renderPanel({
      listings: [[], [knockWire()]],
      respondToKnock: async () => failure(code, `${code} from the server`),
      getKnock: async () =>
        ok(
          knockWire({ state: reloadState, updatedAt: BASE + 1 }) as unknown as Json,
        ),
    });
    await poll(1);
    testid(harness.root, "knock-accept-knk_1")!.click();
    await settle();
    return harness;
  }

  it("says the room is full, and does not enter it", async () => {
    const harness = await refusedAccept("CAPACITY_EXCEEDED", "pending");
    const error = testid(harness.root, "office-action-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("That room is full");
    expect(harness.openCallWindow).not.toHaveBeenCalled();
    // The server still holds the knock open, so the card still says so.
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      "pending",
    );
  });

  it("says the invitation expired before the door was opened", async () => {
    const harness = await refusedAccept("GRANT_EXPIRED", "expired");
    expect(testid(harness.root, "office-action-error")?.textContent).toContain(
      "expired before you opened the door",
    );
    expect(harness.openCallWindow).not.toHaveBeenCalled();
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      "expired",
    );
    expect(testid(harness.root, "knock-accept-knk_1")).toBeNull();
  });

  it("says the room ended, and the card follows the server's state", async () => {
    const harness = await refusedAccept("CALL_SEALED", "cancelled");
    expect(testid(harness.root, "office-action-error")?.textContent).toContain(
      "Room ended",
    );
    expect(harness.openCallWindow).not.toHaveBeenCalled();
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      "cancelled",
    );
    expect(testid(harness.root, "knock-accept-knk_1")).toBeNull();
  });

  it("drops a knock the server no longer knows about instead of leaving a dead door", async () => {
    const harness = await renderPanel({
      listings: [[], [knockWire()]],
      respondToKnock: async () => failure("NOT_FOUND", "gone"),
      getKnock: async () => failure("NOT_FOUND", "gone"),
    });
    await poll(1);
    testid(harness.root, "knock-accept-knk_1")!.click();
    await settle();

    expect(testid(harness.root, "office-action-error")?.textContent).toContain(
      "no longer exists",
    );
    expect(harness.openCallWindow).not.toHaveBeenCalled();
    expect(testid(harness.root, "knock-card-knk_1")).toBeNull();
  });

  it("stops offering the door once the knock has run out of time on this device", async () => {
    const harness = await renderPanel({
      listings: [[], [knockWire({ expiresAt: BASE + 3_000 })]],
    });
    await poll(1);
    expect(testid(harness.root, "knock-accept-knk_1")).not.toBeNull();

    // Past `expiresAt` with no fresh read: the countdown itself closes the door.
    await poll(5);
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      "expired",
    );
    expect(testid(harness.root, "knock-accept-knk_1")).toBeNull();
    expect(text(harness.root, "knock-countdown-knk_1")).toContain(
      "No time left",
    );
    expect(harness.respond).not.toHaveBeenCalled();
    expect(harness.openCallWindow).not.toHaveBeenCalled();
  });

  it("opens the room only when the server actually accepted, with no capability of its own", async () => {
    const accepted = knockWire({ state: "accepted", updatedAt: BASE + 1 });
    const harness = await renderPanel({
      listings: [[], [knockWire()]],
      respondToKnock: async () => ok(accepted as unknown as Json),
      getKnock: async () => ok(accepted as unknown as Json),
    });
    await poll(1);
    testid(harness.root, "knock-accept-knk_1")!.click();
    await settle();

    expect(testid(harness.root, "office-action-error")).toBeNull();
    expect(harness.openCallWindow).toHaveBeenCalledTimes(1);
    const target = harness.openCallWindow.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    // We join the KNOCKER's room, on our own membership: the capability the
    // acceptance minted was issued to them, never to us.
    expect(target.roomId).toBe("room_peer");
    expect(target.callId).toBe("call_peer");
    expect(target).not.toHaveProperty("knock");
    // Opening a door is still not capture.
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

// ── e2e 3 ────────────────────────────────────────────────────────────────────

describe("US-019 e2e 3: defer, reply and dismiss end the knock without a call", () => {
  /**
   * A second window over the SAME backend answers. Both surfaces read
   * `GET /knocks`, so the one that did not act still converges on the state the
   * one that acted produced.
   */
  function mirrorStore(state: () => string): KnockStore {
    return knockStore({
      listKnocks: async () =>
        ok({
          knocks: [knockWire({ state: state(), updatedAt: BASE + 5 })],
        } as unknown as Json),
      getKnock: async () =>
        ok(knockWire({ state: state(), updatedAt: BASE + 5 }) as unknown as Json),
    });
  }

  async function answer(
    action: "defer" | "dismiss",
    serverState: string,
  ): Promise<PanelHarness> {
    let decided = "pending";
    const harness = await renderPanel({
      listings: [[], [knockWire()]],
      respondToKnock: async (_id: string, act: string) => {
        decided = act === "defer" ? "deferred" : "declined";
        return ok(
          knockWire({ state: decided, updatedAt: BASE + 5 }) as unknown as Json,
        );
      },
      getKnock: async () =>
        ok(knockWire({ state: decided, updatedAt: BASE + 5 }) as unknown as Json),
    });
    await poll(1);
    const before = harness.listCalls();
    testid(harness.root, `knock-${action}-knk_1`)!.click();
    await settle();

    expect(harness.openCallWindow).not.toHaveBeenCalled();
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      serverState,
    );
    // Reconciliation is not optional: another `GET /knocks` follows the answer.
    await poll(1);
    expect(harness.listCalls()).toBeGreaterThan(before);
    return harness;
  }

  it("defers without starting a call, and every window agrees", async () => {
    const harness = await answer("defer", "deferred");
    expect(harness.respond.mock.calls[0][1]).toBe("defer");
    expect(getUserMedia).not.toHaveBeenCalled();

    const other = mirrorStore(() => "deferred");
    await other.refresh();
    const root = await renderOffice({ knocks: other });
    expect(testid(root, "knock-card-knk_1")?.dataset.state).toBe("deferred");
    expect(text(root, "knock-state-knk_1")).toContain("come back later");
    expect(testid(root, "knock-accept-knk_1")).toBeNull();
  });

  it("dismisses as a decline, without starting a call, and every window agrees", async () => {
    const harness = await answer("dismiss", "declined");
    expect(harness.respond.mock.calls[0][1]).toBe("decline");
    expect(getUserMedia).not.toHaveBeenCalled();

    const other = mirrorStore(() => "declined");
    await other.refresh();
    const root = await renderOffice({ knocks: other });
    expect(testid(root, "knock-card-knk_1")?.dataset.state).toBe("declined");
    expect(testid(root, "knock-accept-knk_1")).toBeNull();
  });

  it("sends a text reply as a DM and then closes the door politely", async () => {
    let decided = "pending";
    const harness = await renderPanel({
      listings: [[], [knockWire()]],
      respondToKnock: async (_id: string, act: string) => {
        decided = act === "decline" ? "declined" : decided;
        return ok(
          knockWire({ state: decided, updatedAt: BASE + 5 }) as unknown as Json,
        );
      },
      getKnock: async () =>
        ok(knockWire({ state: decided, updatedAt: BASE + 5 }) as unknown as Json),
    });
    await poll(1);

    testid(harness.root, "knock-reply-knk_1")!.click();
    flushSync();
    const box = testid(harness.root, "knock-reply-text-knk_1") as
      | HTMLTextAreaElement
      | null;
    expect(box).not.toBeNull();
    // The suggestion is already there; a person can send it as-is.
    expect(box!.value).toContain("knock");
    box!.value = "in a meeting — ten minutes?";
    box!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const before = harness.listCalls();
    testid(harness.root, "knock-reply-send-knk_1")!.click();
    await settle();

    expect(harness.sendDm).toHaveBeenCalledTimes(1);
    expect(harness.sendDm.mock.calls[0][0]).toBe(PEER);
    expect(harness.sendDm.mock.calls[0][1]).toBe("in a meeting — ten minutes?");
    // Words instead of a room: declined, and no call anywhere.
    expect(harness.respond.mock.calls[0][1]).toBe("decline");
    expect(harness.openCallWindow).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      "declined",
    );
    await poll(1);
    expect(harness.listCalls()).toBeGreaterThan(before);
  });

  it("keeps the knock open while a reply is only being typed", async () => {
    const harness = await renderPanel({ listings: [[], [knockWire()]] });
    await poll(1);
    testid(harness.root, "knock-reply-knk_1")!.click();
    flushSync();
    testid(harness.root, "knock-reply-cancel-knk_1")!.click();
    flushSync();

    expect(harness.respond).not.toHaveBeenCalled();
    expect(harness.sendDm).not.toHaveBeenCalled();
    expect(testid(harness.root, "knock-card-knk_1")?.dataset.state).toBe(
      "pending",
    );
  });

  it("refuses an oversized note before it costs a request", async () => {
    const harness = await renderPanel();
    testid(harness.root, `office-knock-${PEER}`)!.click();
    flushSync();
    const note = testid(harness.root, `office-knock-note-${PEER}`) as
      | HTMLInputElement
      | null;
    // 512 bytes is the server's cap, in bytes: 513 ASCII characters is over it.
    note!.value = "a".repeat(513);
    note!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();

    expect(testid(harness.root, "office-knock-note-too-long")).not.toBeNull();
    expect(
      (testid(harness.root, `office-knock-send-${PEER}`) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await settle();
    expect(harness.created).toEqual([]);
  });

  it("drops a company's knocks the moment the surface is bound elsewhere", async () => {
    const knocks = knockStore({
      listKnocks: async () => ok({ knocks: [knockWire()] } as unknown as Json),
    });
    await knocks.refresh();
    const root = await renderOffice({ knocks });
    expect(cards(root)).toHaveLength(1);

    // The generation guard is synchronous: the previous company's door is gone
    // in the same tick, before any answer for the new company arrives.
    knocks.bind("cmp_b");
    flushSync();
    expect(cards(root)).toHaveLength(0);
    expect(testid(root, "office-knocks-empty")).not.toBeNull();
    expect(root.textContent).not.toContain("two minutes on pricing?");
  });
});
