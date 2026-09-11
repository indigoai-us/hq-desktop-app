// @vitest-environment happy-dom

/**
 * US-018 office view: every distinction is visible as text (never colour
 * alone), the own controls are keyboard-operable native buttons, and the
 * disabled/unsupported/error states say what to do instead of rendering blank.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type AdapterResult, type Json } from "@hq/platform";

import OfficeHours from "./OfficeHours.svelte";
import { createOfficeStore, type OfficeStore } from "./office-store.svelte.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(OfficeHours, { target: host, props: props as never });
  flushSync();
  return host;
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

const NOW = 1_000_000;

function buildStore(
  discover: () => Promise<AdapterResult<Json>>,
  extra: {
    preference?: () => Promise<AdapterResult<Json>>;
    connectivity?: () => Promise<AdapterResult<Json>>;
  } = {},
): OfficeStore {
  return createOfficeStore({
    calls: {
      discoverOffice: discover as never,
      setOfficePreference: (extra.preference ??
        (async () => ok({} as Json))) as never,
      setOfficeConnectivity: (extra.connectivity ??
        (async () => ok({} as Json))) as never,
    },
    selfPersonUid: "prs_self",
    now: () => NOW,
  });
}

const ROSTER = ok({
  companyUid: "cmp_a",
  observedAt: NOW,
  people: [
    { personUid: "prs_self", connectivity: "online", willingness: "knock" },
    {
      personUid: "prs_open",
      connectivity: "offline",
      willingness: "open",
      willingnessExpiresAt: NOW + 45_000,
      occupancy: "unoccupied",
    },
    {
      personUid: "prs_busy",
      connectivity: "online",
      willingness: "dnd",
      occupancy: "occupied",
      occupancyExpiresAt: NOW + 60_000,
      room: { roomId: "room1", callId: "call1", epoch: 2, participants: ["prs_busy"] },
    },
  ],
} as Json) as AdapterResult<Json>;

describe("OfficeHours", () => {
  it("shows reachability, willingness and occupancy as three separate labels", async () => {
    const store = buildStore(async () => ROSTER);
    await store.load("cmp_a");
    const root = render({ store, selfPersonUid: "prs_self", now: () => NOW, tickMs: 0 });

    expect(testid(root, "office-connectivity-prs_open")?.textContent).toContain(
      "Not reachable",
    );
    expect(testid(root, "office-willingness-badge-prs_open")?.textContent).toContain(
      "Door open",
    );
    expect(testid(root, "office-occupancy-prs_open")?.textContent).toContain(
      "Not in a room",
    );
    // Online is rendered on its own, never as "available".
    expect(testid(root, "office-connectivity-prs_busy")?.textContent).toContain(
      "Reachable",
    );
    expect(testid(root, "office-willingness-badge-prs_busy")?.textContent).toContain(
      "Do not disturb",
    );
    expect(testid(root, "office-occupancy-prs_busy")?.textContent).toContain(
      "In a room",
    );
    // The willingness lease is visible as a countdown.
    expect(testid(root, "office-willingness-badge-prs_open")?.textContent).toContain(
      "45s left",
    );
    // Own row is not repeated in the member list.
    expect(testid(root, "office-row-prs_self")).toBeNull();
  });

  it("offers Open room only where the office payload says the room is joinable", async () => {
    const store = buildStore(async () => ROSTER);
    await store.load("cmp_a");
    const opened: string[] = [];
    const root = render({
      store,
      selfPersonUid: "prs_self",
      now: () => NOW,
      tickMs: 0,
      onopenroom: (person: { personUid: string }) => opened.push(person.personUid),
    });

    expect(testid(root, "office-open-room-prs_open")).toBeNull();
    const open = testid(root, "office-open-room-prs_busy");
    expect(open).not.toBeNull();
    open!.click();
    flushSync();
    expect(opened).toEqual(["prs_busy"]);
  });

  it("disables Knock with the US-019 explanation", async () => {
    const store = buildStore(async () => ROSTER);
    await store.load("cmp_a");
    const root = render({ store, selfPersonUid: "prs_self", now: () => NOW, tickMs: 0 });
    const knock = testid(root, "office-knock-prs_open") as HTMLButtonElement;
    expect(knock.disabled).toBe(true);
    expect(knock.title).toBe("Knocks arrive in the next update");
  });

  it("sets willingness from a keyboard-reachable button and shows the expiry", async () => {
    const preference = vi.fn(async () =>
      ok({
        preference: {
          companyUid: "cmp_a",
          personUid: "prs_self",
          willingness: "open",
          expiresAt: NOW + 90_000,
        },
      } as Json) as AdapterResult<Json>,
    );
    const store = buildStore(async () => ROSTER, { preference });
    await store.load("cmp_a");
    const root = render({ store, selfPersonUid: "prs_self", now: () => NOW, tickMs: 0 });

    const openDoor = testid(root, "office-open-door") as HTMLButtonElement;
    // Native buttons: reachable by Tab and activated by Enter/Space for free.
    expect(openDoor.tagName).toBe("BUTTON");
    expect(openDoor.getAttribute("disabled")).toBeNull();
    openDoor.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(preference).toHaveBeenCalledTimes(1);
    expect(testid(root, "office-self-state")?.textContent).toContain("Door open");
    expect(testid(root, "office-self-state")?.textContent).toContain("2m left");
    const segment = testid(root, "office-willingness-open") as HTMLButtonElement;
    expect(segment.getAttribute("aria-pressed")).toBe("true");
  });

  it("explains a disabled company instead of rendering a blank page", async () => {
    const store = buildStore(async () => failure("FEATURE_DISABLED", "off"));
    await store.load("cmp_a");
    const root = render({ store, selfPersonUid: "prs_self", now: () => NOW, tickMs: 0 });
    const notice = testid(root, "office-disabled");
    expect(notice?.textContent).toContain("Native calls are not enabled for this company");
    expect(testid(root, "office-list")).toBeNull();
  });

  it("offers a keyboard Try again on an error state", async () => {
    const store = buildStore(async () => failure("COMPANY_ACCESS_DENIED", "no"));
    await store.load("cmp_a");
    let retried = 0;
    const root = render({
      store,
      selfPersonUid: "prs_self",
      now: () => NOW,
      tickMs: 0,
      onretry: () => {
        retried += 1;
      },
    });
    const error = testid(root, "office-error");
    expect(error?.textContent).toContain("do not have access");
    const retry = error!.querySelector("button") as HTMLButtonElement;
    retry.click();
    flushSync();
    expect(retried).toBe(1);
  });

  it("renders an empty-state that says what to do", async () => {
    const store = buildStore(
      async () =>
        ok({ companyUid: "cmp_a", observedAt: NOW, people: [] } as Json) as AdapterResult<Json>,
    );
    await store.load("cmp_a");
    const root = render({ store, selfPersonUid: "prs_self", now: () => NOW, tickMs: 0 });
    expect(testid(root, "office-empty")?.textContent).toContain("Open your door");
  });
});
