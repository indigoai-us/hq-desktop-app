// @vitest-environment happy-dom

/**
 * US-018 story acceptance tests — "Show company office hours and room
 * availability".
 *
 * Story-level regression cover for the three PRD e2e statements plus the named
 * failure and authorization paths. `OfficeHours.test.ts` and
 * `office-store.svelte.test.ts` pin the units; this file pins the behaviour
 * those units are supposed to add up to when a person actually opens the
 * office: three independent facts that never collapse into "available", a
 * company switch that cannot leak the previous company's private data, and a
 * surface that is fully operable from the keyboard and never renders blank.
 *
 * Everything drives public seams only — the exported `meet` barrel, an injected
 * `calls` triple, and an injected clock. No network, no timers (`tickMs: 0`),
 * no hq-pro.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type AdapterResult, type Json } from "@hq/platform";

import { meet } from "../index.js";

const {
  OfficeHours,
  createOfficeStore,
  expireOfficePerson,
  isRoomJoinable,
  parseOfficePerson,
  OFFICE_DURATIONS,
  OFFICE_LIMITS,
  OFFICE_WILLINGNESS,
  OFFICE_CONNECTIVITY,
} = meet;

type OfficeStore = ReturnType<typeof createOfficeStore>;
type OfficePerson = meet.OfficePerson;

/** Fixed clock. Every countdown in this file is derived from it, never Date.now. */
const NOW = 1_000_000;
const SELF = "prs_self";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

function teardown(): void {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
}

afterEach(teardown);

/** Mount OfficeHours fresh (unmounting any previous mount) and flush. */
function render(props: Record<string, unknown>): HTMLElement {
  teardown();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(OfficeHours, {
    target: host,
    props: { selfPersonUid: SELF, now: () => NOW, tickMs: 0, ...props } as never,
  });
  flushSync();
  return host;
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function text(root: HTMLElement, id: string): string {
  return testid(root, id)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

type Discover = (
  companyUid: string,
  options?: { limit?: number; cursor?: string },
) => Promise<AdapterResult<Json>>;

function buildStore(
  discover: Discover,
  extra: {
    preference?: (input: never) => Promise<AdapterResult<Json>>;
    connectivity?: (input: never) => Promise<AdapterResult<Json>>;
    now?: () => number;
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
    selfPersonUid: SELF,
    now: extra.now ?? (() => NOW),
  });
}

/** Let a chain of already-resolved adapter promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  flushSync();
}

/**
 * The three-way cross product the story is about: reachable + willing is NOT
 * one fact. `prs_busy` is ONLINE and DO NOT DISTURB and in a room — the case
 * that must never read as "available".
 */
const MIXED_ROSTER = ok({
  companyUid: "cmp_a",
  observedAt: NOW,
  people: [
    { personUid: SELF, connectivity: "online", willingness: "knock" },
    {
      personUid: "prs_open",
      connectivity: "online",
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
      room: {
        roomId: "room_busy",
        callId: "call_busy",
        epoch: 3,
        participants: ["prs_busy", "prs_other"],
      },
    },
    {
      personUid: "prs_away",
      connectivity: "offline",
      willingness: "open",
      occupancy: "unoccupied",
    },
  ],
} as Json) as AdapterResult<Json>;

describe("US-018 e2e-1: distinct willingness and occupancy are each visible, and online never means available", () => {
  it("labels reachability, willingness and occupancy as three separate texts for every member", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    const root = render({ store });

    // (online, open, unoccupied)
    expect(text(root, "office-connectivity-prs_open")).toContain("Reachable");
    expect(text(root, "office-willingness-badge-prs_open")).toContain("Door open");
    expect(text(root, "office-occupancy-prs_open")).toContain("Not in a room");

    // (online, dnd, occupied)
    expect(text(root, "office-connectivity-prs_busy")).toContain("Reachable");
    expect(text(root, "office-willingness-badge-prs_busy")).toContain(
      "Do not disturb",
    );
    expect(text(root, "office-occupancy-prs_busy")).toContain("In a room");

    // (offline, open, unoccupied) — the door is open even though nobody is home.
    expect(text(root, "office-connectivity-prs_away")).toContain("Not reachable");
    expect(text(root, "office-willingness-badge-prs_away")).toContain("Door open");
    expect(text(root, "office-occupancy-prs_away")).toContain("Not in a room");

    // The three badges are three distinct nodes per row, so no two facts can be
    // collapsed into one chip by a future refactor without failing here.
    const badges = ["connectivity", "willingness-badge", "occupancy"].map((kind) =>
      testid(root, `office-${kind}-prs_busy`),
    );
    expect(new Set(badges).size).toBe(3);
    expect(badges.every((badge) => badge !== null)).toBe(true);
  });

  it("never presents an online do-not-disturb member as available or walk-in-able", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    const root = render({ store });

    const row = testid(root, "office-row-prs_busy")!;
    const rowText = row.textContent ?? "";
    // The word "available" is never rendered — reachability is its own label.
    expect(rowText.toLowerCase()).not.toContain("available");
    expect(rowText).toContain("Do not disturb");
    // There is no walk-in affordance at all in this release: knocking is an
    // inert note, not a dead button, so DND offers nothing to press.
    expect(testid(root, "office-knock-prs_busy")).toBeNull();
    expect(testid(root, "office-knock-soon-prs_busy")?.textContent).toContain(
      "Knocks coming next",
    );

    // And nothing anywhere reads "online" as a standalone availability claim.
    expect((root.textContent ?? "").toLowerCase()).toContain(
      "being online does not mean being available",
    );
  });

  it("shows occupancy independently of willingness, including its own expiry", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    const root = render({ store });

    // Willingness carries a 45s lease, occupancy a separate 60s lease. Two
    // facts, two countdowns — neither borrows the other's.
    expect(text(root, "office-willingness-badge-prs_open")).toContain("45s left");
    expect(text(root, "office-occupancy-prs_busy")).toContain("1m left");
    expect(text(root, "office-willingness-badge-prs_busy")).not.toContain("left");
    expect(text(root, "office-occupancy-prs_open")).not.toContain("left");
  });

  it("renders neither title nor attendance for a room the caller may not see", async () => {
    // The service omits `room` (and may still report occupancy) when the caller
    // is not permitted to see a private room. There is no cache to fall back
    // on, so nothing about that room may appear.
    const store = buildStore(
      async () =>
        ok({
          companyUid: "cmp_a",
          observedAt: NOW,
          people: [
            { personUid: SELF, connectivity: "online", willingness: "knock" },
            {
              personUid: "prs_private",
              connectivity: "online",
              willingness: "knock",
              occupancy: "occupied",
            },
          ],
        } as Json) as AdapterResult<Json>,
    );
    await store.load("cmp_a");
    const root = render({ store });

    // The public fact (someone is in a room) is shown…
    expect(text(root, "office-occupancy-prs_private")).toContain("In a room");
    // …but no room identity, no title, no attendance, and no way in.
    expect(testid(root, "office-open-room-prs_private")).toBeNull();
    const rendered = root.textContent ?? "";
    expect(rendered).not.toContain("room_");
    expect(rendered).not.toContain("call_");
    expect(rendered).not.toContain("prs_other");

    const person = store.visiblePeople().find((p) => p.personUid === "prs_private")!;
    expect(person.room).toBeUndefined();
    expect(isRoomJoinable(person, NOW)).toBe(false);
  });

  it("offers Open room only where the payload actually granted a joinable room", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    const opened: string[] = [];
    const root = render({
      store,
      onopenroom: (person: OfficePerson) => opened.push(person.personUid),
    });

    expect(testid(root, "office-open-room-prs_open")).toBeNull();
    expect(testid(root, "office-open-room-prs_away")).toBeNull();
    const open = testid(root, "office-open-room-prs_busy") as HTMLButtonElement;
    open.focus();
    expect(document.activeElement).toBe(open);
    open.click();
    flushSync();
    expect(opened).toEqual(["prs_busy"]);
  });

  it("defaults an unknown or absent willingness to Knock first, never to Door open", () => {
    // A forward-compatible server value must degrade to the most conservative
    // reading; anything else would invent consent nobody gave.
    const unknown = parseOfficePerson({
      personUid: "prs_x",
      connectivity: "supernova",
      willingness: "telepathy",
    })!;
    expect(unknown.willingness).toBe("knock");
    expect(unknown.connectivity).toBe("offline");
    expect(unknown.occupancy).toBe("unoccupied");
    expect(OFFICE_WILLINGNESS).toContain("knock");
    expect(OFFICE_CONNECTIVITY).toContain("offline");
  });
});

describe("US-018 e2e-2: switching companies and late answers never show another company's private data", () => {
  it("drops a slow company-A answer that lands after company B is showing", async () => {
    let releaseA: (() => void) | null = null;
    const pendingA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const rosterA = ok({
      companyUid: "cmp_a",
      observedAt: NOW,
      people: [
        {
          personUid: "prs_secret_a",
          connectivity: "online",
          willingness: "open",
          occupancy: "occupied",
          room: {
            roomId: "room_private_a",
            callId: "call_private_a",
            epoch: 1,
            participants: ["prs_secret_a"],
          },
        },
      ],
    } as Json) as AdapterResult<Json>;
    const rosterB = ok({
      companyUid: "cmp_b",
      observedAt: NOW,
      people: [
        { personUid: "prs_b_member", connectivity: "online", willingness: "open" },
      ],
    } as Json) as AdapterResult<Json>;

    const store = buildStore(async (companyUid) => {
      if (companyUid === "cmp_a") {
        await pendingA;
        return rosterA;
      }
      return rosterB;
    });

    const loadA = store.load("cmp_a");
    // B is requested — and answers — while A is still in flight.
    await store.load("cmp_b");
    expect(store.state.companyUid).toBe("cmp_b");

    // A's answer lands late. It must be discarded, not merged.
    releaseA!();
    await loadA;
    await settle();

    expect(store.state.companyUid).toBe("cmp_b");
    expect(store.state.people.map((p) => p.personUid)).toEqual(["prs_b_member"]);

    const root = render({ store });
    expect(testid(root, "office-row-prs_b_member")).not.toBeNull();
    expect(testid(root, "office-row-prs_secret_a")).toBeNull();
    const rendered = root.textContent ?? "";
    expect(rendered).not.toContain("prs_secret_a");
    expect(rendered).not.toContain("room_private_a");
  });

  it("clears the previous company's roster the instant the switch starts, before any answer arrives", async () => {
    let releaseB: (() => void) | null = null;
    const pendingB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const store = buildStore(async (companyUid) => {
      if (companyUid === "cmp_b") {
        await pendingB;
        return ok({ companyUid: "cmp_b", observedAt: NOW, people: [] } as Json) as
          AdapterResult<Json>;
      }
      return MIXED_ROSTER;
    });

    await store.load("cmp_a");
    expect(store.state.people.length).toBeGreaterThan(0);

    const loadB = store.load("cmp_b");
    // No await: this is the frame between the switch and the answer.
    expect(store.state.status).toBe("loading");
    expect(store.state.companyUid).toBe("cmp_b");
    expect(store.state.people).toEqual([]);
    expect(store.state.self).toBeNull();

    const root = render({ store });
    expect(testid(root, "office-row-prs_busy")).toBeNull();
    expect(text(root, "office-loading")).toContain("Loading the office");

    releaseB!();
    await loadB;
  });

  it("drops a page whose body answers for a different company than the one requested", async () => {
    const store = buildStore(
      async () =>
        ok({
          // A mis-routed or stale response: we asked for cmp_b, this is cmp_a.
          companyUid: "cmp_a",
          observedAt: NOW,
          people: [
            { personUid: "prs_wrong", connectivity: "online", willingness: "open" },
          ],
        } as Json) as AdapterResult<Json>,
    );
    await store.load("cmp_b");

    expect(store.state.people).toEqual([]);
    expect(store.state.status).not.toBe("ready");
    const root = render({ store });
    expect(testid(root, "office-row-prs_wrong")).toBeNull();
    expect(root.textContent ?? "").not.toContain("prs_wrong");
  });

  it("leaves no roster behind when a refresh is refused for the company being viewed", async () => {
    let refuse = false;
    const store = buildStore(async () =>
      refuse
        ? (failure("COMPANY_ACCESS_DENIED", "no") as AdapterResult<Json>)
        : MIXED_ROSTER,
    );
    await store.load("cmp_a");
    expect(store.state.people.length).toBeGreaterThan(0);

    // Access is revoked between reads. A stale roster would keep asserting who
    // is reachable in a company the viewer can no longer see.
    refuse = true;
    await store.refresh();
    await settle();

    expect(store.state.status).toBe("error");
    expect(store.state.people).toEqual([]);
    expect(store.state.self).toBeNull();
    const root = render({ store });
    expect(text(root, "office-error")).toContain("do not have access");
    expect(testid(root, "office-list")).toBeNull();
    expect(root.textContent ?? "").not.toContain("prs_busy");
  });

  it("expires willingness and occupancy on their own server leases once the clock passes them", async () => {
    let clock = NOW;
    const store = buildStore(
      async () =>
        ok({
          companyUid: "cmp_a",
          observedAt: NOW,
          people: [
            { personUid: SELF, connectivity: "online", willingness: "knock" },
            {
              personUid: "prs_lease",
              connectivity: "online",
              connectivityExpiresAt: NOW + 120_000,
              willingness: "open",
              willingnessExpiresAt: NOW + 30_000,
              occupancy: "occupied",
              occupancyExpiresAt: NOW + 30_000,
              room: {
                roomId: "room_lease",
                callId: "call_lease",
                epoch: 1,
                participants: ["prs_lease"],
              },
            },
          ],
        } as Json) as AdapterResult<Json>,
      { now: () => clock },
    );
    await store.load("cmp_a");

    const before = render({ store, now: () => clock });
    expect(text(before, "office-willingness-badge-prs_lease")).toContain("Door open");
    expect(text(before, "office-occupancy-prs_lease")).toContain("In a room");
    expect(testid(before, "office-open-room-prs_lease")).not.toBeNull();

    // Advance past the willingness/occupancy leases but NOT the connectivity one.
    clock = NOW + 31_000;
    const after = render({ store, now: () => clock });
    expect(text(after, "office-willingness-badge-prs_lease")).toContain("Knock first");
    expect(text(after, "office-occupancy-prs_lease")).toContain("Not in a room");
    // The expired room is gone entirely — no stale door into a finished call.
    expect(testid(after, "office-open-room-prs_lease")).toBeNull();
    expect(after.textContent ?? "").not.toContain("room_lease");
    // Each fact expires on its OWN lease: reachability is untouched.
    expect(text(after, "office-connectivity-prs_lease")).toContain("Reachable");

    const live = store.visiblePeople()[0]!;
    expect(live.room).toBeUndefined();
    expect(expireOfficePerson(live, clock).connectivity).toBe("online");
  });

  it("appends further pages only for the company that is still selected", async () => {
    const seen: Array<{ companyUid: string; cursor?: string }> = [];
    const store = buildStore(async (companyUid, options) => {
      seen.push({ companyUid, ...(options?.cursor ? { cursor: options.cursor } : {}) });
      if (options?.cursor === "page2") {
        return ok({
          companyUid: "cmp_a",
          observedAt: NOW,
          people: [
            { personUid: "prs_page2", connectivity: "online", willingness: "knock" },
          ],
        } as Json) as AdapterResult<Json>;
      }
      return ok({
        companyUid: "cmp_a",
        observedAt: NOW,
        cursor: "page2",
        people: [
          { personUid: SELF, connectivity: "online", willingness: "knock" },
          { personUid: "prs_page1", connectivity: "online", willingness: "open" },
        ],
      } as Json) as AdapterResult<Json>;
    });
    await store.load("cmp_a");

    const root = render({ store });
    const more = testid(root, "office-load-more") as HTMLButtonElement;
    expect(more).not.toBeNull();
    more.focus();
    expect(document.activeElement).toBe(more);
    more.click();
    await settle();

    expect(seen).toEqual([
      { companyUid: "cmp_a" },
      { companyUid: "cmp_a", cursor: "page2" },
    ]);
    const grown = render({ store });
    expect(testid(grown, "office-row-prs_page1")).not.toBeNull();
    expect(testid(grown, "office-row-prs_page2")).not.toBeNull();
    // Page requests are bounded by the service's own page size.
    expect(OFFICE_LIMITS.pageSize).toBeGreaterThan(0);
  });
});

describe("US-018 e2e-3: keyboard-only office hours, room opening, and understandable failure", () => {
  it("reaches every own-office control by keyboard and shows the chosen expiry", async () => {
    const preference = vi.fn(
      async (_input: never) =>
        ok({
          preference: {
            companyUid: "cmp_a",
            personUid: SELF,
            willingness: "dnd",
            expiresAt: NOW + 45_000,
          },
        } as Json) as AdapterResult<Json>,
    );
    const store = buildStore(async () => MIXED_ROSTER, { preference });
    await store.load("cmp_a");
    const root = render({ store });

    // Every own control is a native, focusable control in document order — no
    // div-buttons, no tabindex traps, nothing reachable by mouse alone.
    const controls = Array.from(
      testid(root, "office-self")!.querySelectorAll<HTMLElement>("button, select"),
    );
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const control of controls) {
      expect(["BUTTON", "SELECT"]).toContain(control.tagName);
      expect(control.getAttribute("tabindex")).toBeNull();
      expect(control.getAttribute("aria-hidden")).toBeNull();
      control.focus();
      expect(document.activeElement).toBe(control);
    }

    // The duration select is a real select with only service-legal durations.
    const duration = testid(root, "office-duration") as HTMLSelectElement;
    expect(Array.from(duration.options).map((o) => Number(o.value))).toEqual(
      OFFICE_DURATIONS.map((d) => d.ttlMs),
    );
    for (const option of OFFICE_DURATIONS) {
      expect(option.ttlMs).toBeGreaterThanOrEqual(OFFICE_LIMITS.minLeaseMs);
      expect(option.ttlMs).toBeLessThanOrEqual(OFFICE_LIMITS.leaseMs);
    }

    // Choose Do not disturb from the keyboard (a native button activates on
    // Enter/Space by dispatching exactly this click).
    const dnd = testid(root, "office-willingness-dnd") as HTMLButtonElement;
    dnd.focus();
    expect(document.activeElement).toBe(dnd);
    dnd.click();
    await settle();

    expect(preference).toHaveBeenCalledTimes(1);
    expect(preference.mock.calls[0]?.[0] as unknown).toMatchObject({
      companyUid: "cmp_a",
      willingness: "dnd",
    });
    // The choice, and how long it lasts, are both visible.
    expect(text(root, "office-self-state")).toContain("Do not disturb");
    expect(text(root, "office-self-state")).toContain("45s left");
    expect(dnd.getAttribute("aria-pressed")).toBe("true");
    expect(
      (testid(root, "office-willingness-open") as HTMLButtonElement).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
  });

  it("starts a room from the keyboard through the host seam", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    let started = 0;
    const root = render({
      store,
      onstartroom: () => {
        started += 1;
      },
    });

    const start = testid(root, "office-start-room") as HTMLButtonElement;
    expect(start.tagName).toBe("BUTTON");
    expect(start.disabled).toBe(false);
    start.focus();
    expect(document.activeElement).toBe(start);
    start.click();
    flushSync();

    // The shared view never creates the room or opens a window itself; the
    // host owns both native seams.
    expect(started).toBe(1);
  });

  it("explains a refused own-state write and keeps the controls usable", async () => {
    const preference = vi.fn(
      async () =>
        failure("RATE_LIMITED", "slow down") as AdapterResult<Json>,
    );
    const store = buildStore(async () => MIXED_ROSTER, { preference });
    await store.load("cmp_a");
    const root = render({ store });

    (testid(root, "office-open-door") as HTMLButtonElement).click();
    await settle();

    expect(store.state.error?.code).toBe("RATE_LIMITED");
    expect(store.state.error?.message).toContain("Try again in a moment");
    // A refused write must not strand the surface in a saving state.
    expect(store.state.saving).toBe(false);
    expect(store.state.status).toBe("ready");
    expect(
      (testid(root, "office-open-door") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("offers a keyboard-reachable retry that explains the failure", async () => {
    const store = buildStore(async () => failure("network", "socket closed"));
    await store.load("cmp_a");
    let retried = 0;
    const root = render({
      store,
      onretry: () => {
        retried += 1;
      },
    });

    const error = testid(root, "office-error")!;
    expect(error.textContent).toContain("The office could not be loaded");
    const retry = error.querySelector("button") as HTMLButtonElement;
    expect(retry.textContent?.trim()).toBe("Try again");
    retry.focus();
    expect(document.activeElement).toBe(retry);
    retry.click();
    flushSync();
    expect(retried).toBe(1);
  });

  it("says what is wrong for a disabled company and for an unsupported host", async () => {
    const disabled = buildStore(async () => failure("FEATURE_DISABLED", "off"));
    await disabled.load("cmp_a");
    let root = render({ store: disabled });
    expect(text(root, "office-disabled")).toContain(
      "Native calls are not enabled for this company",
    );
    expect(text(root, "office-disabled")).toContain("company owner");
    expect(testid(root, "office-list")).toBeNull();
    expect(testid(root, "office-self")).toBeNull();

    const unsupported = buildStore(async () =>
      failure("CALLS_UNSUPPORTED_HOST", "browser"),
    );
    await unsupported.load("cmp_a");
    root = render({ store: unsupported });
    expect(text(root, "office-unsupported")).toContain(
      "Native calls are not available here",
    );
    expect(testid(root, "office-list")).toBeNull();

    // A device that has not passed the US-011 evidence preflight is the same
    // class of refusal — unsupported here, with a recovery instruction.
    const preflight = buildStore(async () =>
      failure("CALLS_PREFLIGHT_REQUIRED", "no evidence"),
    );
    await preflight.load("cmp_a");
    root = render({ store: preflight });
    expect(text(root, "office-unsupported")).toContain("Reopen the app to retry");
  });

  it("renders loading and empty states that say what to do instead of going blank", async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = buildStore(async () => {
      await pending;
      return ok({ companyUid: "cmp_a", observedAt: NOW, people: [] } as Json) as
        AdapterResult<Json>;
    });

    const load = store.load("cmp_a");
    let root = render({ store });
    expect(text(root, "office-loading")).toContain("Loading the office");
    expect(testid(root, "office-empty")).toBeNull();

    release!();
    await load;
    await settle();

    root = render({ store });
    expect(testid(root, "office-loading")).toBeNull();
    expect(text(root, "office-empty")).toContain("Open your door");
  });

  it("states that knocking is coming without leaving a dead control behind", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    const root = render({ store });

    for (const uid of ["prs_open", "prs_busy", "prs_away"]) {
      // A permanently disabled button is skipped by keyboard focus and
      // announces no reason, so it reads as a broken primary action. The
      // replacement is a plain, non-interactive sentence.
      expect(testid(root, `office-knock-${uid}`)).toBeNull();
      const note = testid(root, `office-knock-soon-${uid}`)!;
      expect(note).not.toBeNull();
      expect(note.tagName).toBe("SPAN");
      expect(note.textContent).toContain("Knocks coming next");
    }
    // No disabled control survives anywhere in the roster list.
    const list = testid(root, "office-list")!;
    expect(list.querySelectorAll("button[disabled]").length).toBe(0);
  });

  it("announces status changes politely and labels the view for assistive tech", async () => {
    const store = buildStore(async () => MIXED_ROSTER);
    await store.load("cmp_a");
    const root = render({ store });

    const live = root.querySelector('[role="status"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent?.replace(/\s+/g, " ")).toContain(
      "Office loaded: 3 other people.",
    );
    const section = root.querySelector("section")!;
    expect(section.getAttribute("aria-labelledby")).toBe("office-title");
    expect(root.querySelector("#office-title")?.textContent).toBe("Office");
    // The willingness segmented control is a labelled group, not loose buttons.
    const group = root.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toContain("willingness");
  });
});
