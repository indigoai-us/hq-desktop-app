// @vitest-environment happy-dom

/**
 * US-019 in the office view: a real Knock action on a row (with an optional
 * note), honest feedback for duplicate / suppressed / rate-limited, and one
 * card per knock however many times it was observed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type Json } from "@hq/platform";

import OfficeHours from "./OfficeHours.svelte";
import { createOfficeStore, type OfficeStore } from "./office-store.svelte.js";
import { createKnockStore, type KnockStore } from "./knocks.svelte.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const NOW = 1_000_000;
const COMPANY = "cmp_a";

/** Let the send's resolveRoom + createKnock hops finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

/**
 * A knock names the TARGET's room, so every knockable row in this file has one.
 * `room` omitted = no live door, which is its own row state.
 */
function person(
  personUid: string,
  willingness: string,
  room?: Record<string, unknown> | null,
) {
  return {
    personUid,
    connectivity: "online",
    connectivityExpiresAt: NOW + 60_000,
    willingness,
    willingnessExpiresAt: NOW + 60_000,
    occupancy: room ? "occupied" : "unoccupied",
    occupancyExpiresAt: room ? NOW + 60_000 : null,
    ...(room ? { room } : {}),
  };
}

function roomOf(who: string, visibility?: string) {
  return {
    roomId: `room_${who}`,
    callId: `call_${who}`,
    epoch: 3,
    participants: [who],
    ...(visibility ? { visibility } : {}),
  };
}

const ROSTER = ok({
  version: "hq-meet/1",
  observedAt: NOW,
  people: [
    person("prs_self", "open"),
    // Knock-first, with a live room: the ordinary knockable row.
    person("prs_open", "knock", roomOf("prs_open")),
    person("prs_quiet", "dnd", roomOf("prs_quiet")),
    // Door open and company-visible: walk in, no permission needed.
    person("prs_walkin", "open", roomOf("prs_walkin", "company")),
    // Open, but the room is private: the server still decides. Knock.
    person("prs_private", "open", roomOf("prs_private", "private")),
    // No room at all: there is nothing to knock on.
    person("prs_nodoor", "knock"),
  ],
} as unknown as Json);

function officeStore(): OfficeStore {
  return createOfficeStore({
    calls: {
      discoverOffice: (async () => ROSTER) as never,
      setOfficePreference: (async () => ok({} as Json)) as never,
      setOfficeConnectivity: (async () => ok({} as Json)) as never,
    },
    selfPersonUid: "prs_self",
    now: () => NOW,
  });
}

function knockWire(overrides: Record<string, unknown> = {}) {
  return {
    knockId: "knk_1",
    companyUid: COMPANY,
    roomId: "room_1",
    callId: "call_1",
    epoch: 3,
    from: "prs_open",
    target: "prs_self",
    note: "got a sec?",
    state: "pending",
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    ...overrides,
  };
}

function knockStore(calls: Record<string, unknown>): KnockStore {
  return createKnockStore({
    calls: calls as never,
    now: () => NOW,
    companyUid: COMPANY,
    newKey: () => "idem_1",
    resolveRoom: async () => ({ roomId: "room_1", callId: "call_1", epoch: 3 }),
  });
}

async function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const office = (props.store as OfficeStore | undefined) ?? officeStore();
  await office.load(COMPANY);
  component = mount(OfficeHours, {
    target: host,
    props: {
      store: office,
      selfPersonUid: "prs_self",
      now: () => NOW,
      tickMs: 0,
      ...props,
    } as never,
  });
  flushSync();
  return host!;
}

describe("office knocks", () => {
  it("offers a Knock action on a row, and says why it does not on DND", async () => {
    const knocks = knockStore({ createKnock: async () => ok({} as Json) });
    const root = await render({ knocks });
    const button = testid(root, "office-knock-prs_open")!;
    expect(button.tagName).toBe("BUTTON");
    expect(testid(root, "office-knock-prs_quiet")).toBeNull();
    expect(testid(root, "office-knock-dnd-prs_quiet")?.textContent).toContain(
      "Do not disturb",
    );
  });

  it("offers Join instead of a knock where the door is open and company-visible", async () => {
    const knocks = knockStore({});
    const opened: string[] = [];
    const root = await render({
      knocks,
      onopenroom: (p: { personUid: string }) => opened.push(p.personUid),
    });
    // Walking into an open, company-visible room needs nobody's permission, so
    // there is no knock to send — asking would be pure ceremony.
    expect(testid(root, "office-knock-prs_walkin")).toBeNull();
    const join = testid(root, "office-open-room-prs_walkin")!;
    expect(join.textContent?.trim()).toBe("Join");
    join.click();
    flushSync();
    expect(opened).toEqual(["prs_walkin"]);
  });

  it("knocks rather than walking in when the room is private, even on an open door", async () => {
    const knocks = knockStore({});
    const root = await render({ knocks });
    expect(testid(root, "office-open-room-prs_private")).toBeNull();
    expect(testid(root, "office-knock-prs_private")).not.toBeNull();
  });

  it("says there is no door yet instead of offering a knock bound to nothing", async () => {
    const knocks = knockStore({});
    const root = await render({ knocks });
    expect(testid(root, "office-knock-prs_nodoor")).toBeNull();
    expect(testid(root, "office-open-room-prs_nodoor")).toBeNull();
    const reason = testid(root, "office-knock-none-prs_nodoor")!;
    expect(reason.tagName).toBe("SPAN");
    expect(reason.textContent).toContain("No open door yet");
  });

  it("shows an action refusal even after a later list read succeeds", async () => {
    const knocks = knockStore({
      listKnocks: async () => ok({ knocks: [] } as unknown as Json),
      getKnock: async () => ok(knockWire() as unknown as Json),
      respondToKnock: async () => failure("CAPACITY_EXCEEDED", "full"),
    });
    await knocks.accept("knk_1");
    await knocks.refresh();
    const root = await render({ knocks });
    expect(testid(root, "office-knock-error")?.textContent).toContain(
      "That room is full",
    );
  });

  it("sends an optional note through the host and reports the outcome", async () => {
    const knocks = knockStore({});
    const onknock = vi.fn(async (_person: unknown, _note: string) => undefined);
    const root = await render({ knocks, onknock });
    testid(root, "office-knock-prs_open")!.click();
    flushSync();
    const note = testid(root, "office-knock-note-prs_open") as HTMLInputElement;
    note.value = "two minutes on pricing?";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    testid(root, "office-knock-send-prs_open")!.click();
    flushSync();
    expect(onknock).toHaveBeenCalled();
    expect(onknock.mock.calls[0][1]).toBe("two minutes on pricing?");
  });

  it("refuses an oversized note in words instead of sending it", async () => {
    const knocks = knockStore({});
    const onknock = vi.fn();
    const root = await render({ knocks, onknock });
    testid(root, "office-knock-prs_open")!.click();
    flushSync();
    const note = testid(root, "office-knock-note-prs_open") as HTMLInputElement;
    note.value = "a".repeat(513);
    note.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(testid(root, "office-knock-note-too-long")).not.toBeNull();
    expect(
      testid(root, "office-knock-send-prs_open")!.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says a suppressed knock was recorded but not shown", async () => {
    const knocks = knockStore({
      createKnock: async () =>
        ok({ created: false, duplicate: false, suppressed: "dnd", waked: false } as unknown as Json),
    });
    const root = await render({
      knocks,
      onknock: (_p: unknown, n: string) => knocks.send("prs_open", n),
    });
    testid(root, "office-knock-prs_open")!.click();
    flushSync();
    testid(root, "office-knock-send-prs_open")!.click();
    await settle();
    flushSync();
    const feedback = testid(root, "office-knock-feedback")!.textContent ?? "";
    expect(feedback).toContain("do not disturb");
    expect(feedback).toContain("recorded");
  });

  it("surfaces a rate-limited knock as the server's own refusal", async () => {
    const knocks = knockStore({
      createKnock: async () => failure("RATE_LIMITED", "slow down"),
    });
    const root = await render({
      knocks,
      onknock: () => knocks.send("prs_open"),
    });
    testid(root, "office-knock-prs_open")!.click();
    flushSync();
    testid(root, "office-knock-send-prs_open")!.click();
    await settle();
    flushSync();
    expect(testid(root, "office-knock-feedback")?.textContent).toContain(
      "Too many knocks",
    );
  });

  it("renders ONE card for a knock delivered twice, with no media on it", async () => {
    const knocks = knockStore({
      listKnocks: async () => ok({ knocks: [knockWire()] } as unknown as Json),
    });
    await knocks.refresh();
    await knocks.refresh();
    const root = await render({ knocks });
    expect(root.querySelectorAll('[data-testid^="knock-card-"]')).toHaveLength(1);
    expect(root.querySelector("audio")).toBeNull();
    expect(root.querySelector("video")).toBeNull();
    expect(testid(root, "knock-accept-knk_1")).not.toBeNull();
  });

  it("keeps the old note when no knock surface was wired at all", async () => {
    const root = await render({});
    expect(testid(root, "office-knock-prs_open")).toBeNull();
    expect(testid(root, "office-knock-soon-prs_open")).not.toBeNull();
    expect(testid(root, "office-knock-list")).toBeNull();
  });
});
