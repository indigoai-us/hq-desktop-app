// @vitest-environment happy-dom

/**
 * US-018 office store: three independent states, lease expiry against an
 * injected clock, generation-guarded company isolation, and the refusal codes
 * that must render as explicit states rather than an empty page.
 */

import { describe, expect, it, vi } from "vitest";
import { failure, ok, unavailable, type AdapterResult, type Json } from "@hq/platform";

import {
  createOfficeStore,
  expireOfficePerson,
  isRoomJoinable,
  OFFICE_LIMITS,
  parseOfficePerson,
  type OfficePerson,
} from "./office-store.svelte.js";

function person(patch: Partial<OfficePerson> = {}): OfficePerson {
  return {
    personUid: "prs_a",
    connectivity: "offline",
    connectivityExpiresAt: null,
    willingness: "knock",
    willingnessExpiresAt: null,
    occupancy: "unoccupied",
    occupancyExpiresAt: null,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface Harness {
  discover: ReturnType<typeof vi.fn>;
  preference: ReturnType<typeof vi.fn>;
  connectivity: ReturnType<typeof vi.fn>;
  clock: { value: number };
}

function harness(): Harness {
  return {
    discover: vi.fn(),
    preference: vi.fn(),
    connectivity: vi.fn(),
    clock: { value: 1_000_000 },
  };
}

function store(h: Harness, selfPersonUid = "prs_self") {
  return createOfficeStore({
    calls: {
      discoverOffice: h.discover as never,
      setOfficePreference: h.preference as never,
      setOfficeConnectivity: h.connectivity as never,
    },
    selfPersonUid,
    now: () => h.clock.value,
  });
}

function page(people: unknown[], extra: Record<string, unknown> = {}) {
  return ok({
    version: "hq-meet/1",
    companyUid: "cmp_a",
    observedAt: 1_000_000,
    people,
    ...extra,
  } as Json) as AdapterResult<Json>;
}

describe("office store", () => {
  it("keeps reachability, willingness and occupancy independent", async () => {
    const h = harness();
    h.discover.mockResolvedValue(
      page([
        { personUid: "prs_a", connectivity: "online", willingness: "dnd", occupancy: "unoccupied" },
        {
          personUid: "prs_b",
          connectivity: "offline",
          willingness: "open",
          occupancy: "occupied",
          occupancyExpiresAt: 1_090_000,
          room: { roomId: "room1", callId: "call1", epoch: 3, participants: ["prs_b"] },
        },
      ]),
    );
    const s = store(h);
    await s.load("cmp_a");

    const [a, b] = s.visiblePeople();
    // Online does NOT imply available.
    expect(a.connectivity).toBe("online");
    expect(a.willingness).toBe("dnd");
    expect(a.occupancy).toBe("unoccupied");
    // Offline does NOT erase an open door or a live room.
    expect(b.connectivity).toBe("offline");
    expect(b.willingness).toBe("open");
    expect(b.occupancy).toBe("occupied");
    expect(isRoomJoinable(b, h.clock.value)).toBe(true);
  });

  it("expires each fact on its OWN lease", () => {
    const subject = person({
      connectivity: "online",
      connectivityExpiresAt: 100,
      willingness: "open",
      willingnessExpiresAt: 500,
      occupancy: "occupied",
      occupancyExpiresAt: 500,
      room: { roomId: "r", callId: "c", epoch: 1, participants: ["prs_a"] },
    });

    const midway = expireOfficePerson(subject, 200);
    expect(midway.connectivity).toBe("offline");
    expect(midway.willingness).toBe("open");
    expect(midway.occupancy).toBe("occupied");

    const later = expireOfficePerson(subject, 600);
    expect(later.willingness).toBe("knock");
    expect(later.occupancy).toBe("unoccupied");
    expect(later.room).toBeUndefined();
    expect(isRoomJoinable(subject, 600)).toBe(false);
  });

  it("discards a late response for the previous company", async () => {
    const h = harness();
    const slow = deferred<AdapterResult<Json>>();
    h.discover.mockImplementationOnce(() => slow.promise);
    h.discover.mockImplementationOnce(async () =>
      page([{ personUid: "prs_b" }], { companyUid: "cmp_b" }),
    );

    const s = store(h);
    const first = s.load("cmp_a");
    await s.load("cmp_b");
    expect(s.state.companyUid).toBe("cmp_b");
    expect(s.state.people.map((p) => p.personUid)).toEqual(["prs_b"]);

    slow.resolve(
      ok({
        companyUid: "cmp_a",
        observedAt: 1,
        people: [{ personUid: "prs_secret_a" }],
      } as Json) as AdapterResult<Json>,
    );
    await first;

    // The company-A answer landed after the switch and must not be rendered.
    expect(s.state.companyUid).toBe("cmp_b");
    expect(s.state.people.map((p) => p.personUid)).toEqual(["prs_b"]);
  });

  it("clears the previous roster the moment the company changes", async () => {
    const h = harness();
    h.discover.mockResolvedValueOnce(page([{ personUid: "prs_a" }]));
    const pending = deferred<AdapterResult<Json>>();
    h.discover.mockImplementationOnce(() => pending.promise);

    const s = store(h);
    await s.load("cmp_a");
    expect(s.state.people).toHaveLength(1);

    const second = s.load("cmp_b");
    expect(s.state.people).toEqual([]);
    expect(s.state.self).toBeNull();
    expect(s.state.status).toBe("loading");
    pending.resolve(page([], { companyUid: "cmp_b" }));
    await second;
  });

  it("drops a page whose companyUid does not match the request", async () => {
    const h = harness();
    h.discover.mockResolvedValue(
      ok({
        companyUid: "cmp_other",
        observedAt: 1,
        people: [{ personUid: "prs_leak" }],
      } as Json) as AdapterResult<Json>,
    );
    const s = store(h);
    await s.load("cmp_a");
    expect(s.state.people).toEqual([]);
  });

  it("renders FEATURE_DISABLED and unsupported hosts as explicit states", async () => {
    const disabled = harness();
    disabled.discover.mockResolvedValue(failure("FEATURE_DISABLED", "off"));
    const a = store(disabled);
    await a.load("cmp_a");
    expect(a.state.status).toBe("disabled");
    expect(a.state.error?.message).toContain("not enabled");

    const web = harness();
    web.discover.mockResolvedValue(
      unavailable("CALLS_UNSUPPORTED_HOST", "web") as AdapterResult<Json>,
    );
    const b = store(web);
    await b.load("cmp_a");
    expect(b.state.status).toBe("unsupported");

    const locked = harness();
    locked.discover.mockResolvedValue(
      unavailable("CALLS_PREFLIGHT_REQUIRED", "locked") as AdapterResult<Json>,
    );
    const c = store(locked);
    await c.load("cmp_a");
    expect(c.state.status).toBe("unsupported");

    const denied = harness();
    denied.discover.mockResolvedValue(failure("COMPANY_ACCESS_DENIED", "no"));
    const d = store(denied);
    await d.load("cmp_a");
    expect(d.state.status).toBe("error");
    expect(d.state.people).toEqual([]);
  });

  it("sends the explicit companyUid and a bounded ttl on every write", async () => {
    const h = harness();
    h.discover.mockResolvedValue(page([{ personUid: "prs_self" }]));
    h.preference.mockResolvedValue(
      ok({
        preference: {
          companyUid: "cmp_a",
          personUid: "prs_self",
          willingness: "open",
          expiresAt: 1_090_000,
        },
      } as Json) as AdapterResult<Json>,
    );
    const s = store(h);
    await s.load("cmp_a");

    await s.setWillingness("open", OFFICE_LIMITS.leaseMs * 10);
    expect(h.preference).toHaveBeenCalledWith({
      companyUid: "cmp_a",
      willingness: "open",
      ttlMs: OFFICE_LIMITS.leaseMs,
    });
    expect(s.state.self?.willingness).toBe("open");
    expect(s.state.self?.willingnessExpiresAt).toBe(1_090_000);

    // The lease runs out: willingness falls back to knock, nothing else moves.
    h.clock.value = 1_090_001;
    expect(s.visibleSelf()?.willingness).toBe("knock");
  });

  it("pages with the server cursor and appends without losing the roster", async () => {
    const h = harness();
    h.discover.mockResolvedValueOnce(
      page([{ personUid: "prs_a" }], { cursor: "next-1" }),
    );
    h.discover.mockResolvedValueOnce(page([{ personUid: "prs_b" }]));
    const s = store(h);
    await s.load("cmp_a");
    expect(s.state.nextCursor).toBe("next-1");

    await s.loadMore();
    expect(h.discover).toHaveBeenLastCalledWith("cmp_a", {
      limit: OFFICE_LIMITS.pageSize,
      cursor: "next-1",
    });
    expect(s.state.people.map((p) => p.personUid)).toEqual(["prs_a", "prs_b"]);
    expect(s.state.nextCursor).toBeNull();
  });

  it("clears the previous company SYNCHRONOUSLY on reset, before any await", async () => {
    const h = harness();
    h.discover.mockResolvedValue(
      page([{ personUid: "prs_only_a", connectivity: "online", willingness: "open" }]),
    );
    const s = store(h);
    await s.load("cmp_a");
    expect(s.state.people.map((p) => p.personUid)).toEqual(["prs_only_a"]);

    // A host whose company switch must await identity/preflight first calls
    // reset in the SAME tick as the switch. Nothing may survive that call —
    // not a row, not a cursor, not an error, and not the old company uid.
    const before = s.generation();
    s.reset("cmp_b");
    expect(s.state.companyUid).toBe("cmp_b");
    expect(s.state.people).toEqual([]);
    expect(s.state.self).toBeNull();
    expect(s.state.observedAt).toBeNull();
    expect(s.state.nextCursor).toBeNull();
    expect(s.state.error).toBeNull();
    expect(s.state.status).toBe("loading");
    // The generation bump is what makes a late cmp_a answer unusable.
    expect(s.generation()).toBe(before + 1);

    // Resetting to "no company" parks the store rather than loading nothing.
    s.reset(null);
    expect(s.state.companyUid).toBeNull();
    expect(s.state.status).toBe("idle");
  });

  it("does not fold the own row back into a roster the error state cleared", async () => {
    const h = harness();
    h.discover.mockResolvedValue(
      page([{ personUid: "prs_self", connectivity: "online", willingness: "open" }]),
    );
    const s = store(h);
    await s.load("cmp_a");
    expect(s.state.people).toHaveLength(1);

    // A refused refresh clears the roster on purpose: the view is now saying
    // "we do not know who is here".
    h.discover.mockResolvedValue(
      failure("INTERNAL", "boom") as AdapterResult<Json>,
    );
    await s.refresh();
    expect(s.state.status).toBe("error");
    expect(s.state.people).toEqual([]);

    // Writing our own willingness must NOT resurrect a one-person office that
    // looks like an authoritative roster.
    h.preference.mockResolvedValue(
      ok({
        preference: {
          companyUid: "cmp_a",
          willingness: "open",
          expiresAt: 2_000_000,
        },
      } as Json) as AdapterResult<Json>,
    );
    await s.setWillingness("open", 60_000);
    expect(s.state.people).toEqual([]);
    expect(s.state.status).toBe("error");
    // The own state is still recorded, so a later retry renders it.
    expect(s.state.self?.willingness).toBe("open");
  });

  it("never infers a room the backend omitted", () => {
    const parsed = parseOfficePerson({
      personUid: "prs_a",
      connectivity: "online",
      willingness: "knock",
      occupancy: "occupied",
    });
    expect(parsed?.room).toBeUndefined();
    expect(isRoomJoinable(parsed!, 0)).toBe(false);
    expect(parseOfficePerson({ willingness: "open" })).toBeNull();
    // Unknown enum values fall back to the least-permissive default.
    expect(parseOfficePerson({ personUid: "p", willingness: "walk-in" })?.willingness).toBe(
      "knock",
    );
  });
});
