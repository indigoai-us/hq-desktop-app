/**
 * Office-hours store (US-018).
 *
 * Reachability, willingness and occupancy are THREE independent facts. The
 * backend reports them separately, with separate leases, and this store keeps
 * them separate all the way to the badges: being online never implies being
 * available, and being in a room never implies being reachable.
 *
 * Everything here is company-scoped and generation-guarded. Every request
 * carries the explicit `companyUid` it was started for, and a response is only
 * folded in when BOTH its generation and its company still match — so a late
 * answer for the company the user just navigated away from is discarded rather
 * than rendered. A company switch clears state first, so no previous-company
 * roster (or private-room attendance) can survive the transition.
 *
 * The store never infers what the backend omitted. A private room the caller
 * may not see simply arrives without `room`/`occupancy`; there is no cache to
 * fall back on, by design.
 */

import type { AdapterResult, CallsApi, Json } from "@hq/platform";

/** Mirrors hq-pro `OfficeConnectivity["connectivity"]`. */
export type OfficeConnectivity = "online" | "away" | "offline";
/** Mirrors hq-pro `NativeOfficePreference["willingness"]`. */
export type OfficeWillingness = "open" | "knock" | "dnd";
/** Mirrors the hq-pro office projection's occupancy. */
export type OfficeOccupancy = "occupied" | "unoccupied";

export const OFFICE_CONNECTIVITY: readonly OfficeConnectivity[] = [
  "online",
  "away",
  "offline",
];
export const OFFICE_WILLINGNESS: readonly OfficeWillingness[] = [
  "open",
  "knock",
  "dnd",
];

/**
 * Mirror of hq-pro `OFFICE_LIMITS` (src/meetings/native/office.service.ts).
 * A ttl outside [minLeaseMs, leaseMs] is refused by the service with
 * INVALID_INPUT, so the UI never offers one.
 */
export const OFFICE_LIMITS = Object.freeze({
  leaseMs: 90_000,
  minLeaseMs: 1_000,
  pageSize: 25,
});

/** Selectable office-hours durations, all within the service lease bounds. */
export const OFFICE_DURATIONS: ReadonlyArray<{
  ttlMs: number;
  label: string;
}> = [
  { ttlMs: 15_000, label: "15 seconds" },
  { ttlMs: 60_000, label: "1 minute" },
  { ttlMs: OFFICE_LIMITS.leaseMs, label: "90 seconds" },
];

export interface OfficeRoom {
  roomId: string;
  callId: string;
  epoch: number;
  participants: string[];
}

export interface OfficePerson {
  personUid: string;
  connectivity: OfficeConnectivity;
  connectivityExpiresAt: number | null;
  willingness: OfficeWillingness;
  willingnessExpiresAt: number | null;
  occupancy: OfficeOccupancy;
  occupancyExpiresAt: number | null;
  /** Absent when the caller is not permitted to see the room, or there is none. */
  room?: OfficeRoom;
}

export type OfficeStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "unsupported"
  | "disabled";

export interface OfficeError {
  code: string;
  message: string;
}

export interface OfficeState {
  status: OfficeStatus;
  companyUid: string | null;
  people: OfficePerson[];
  /** The caller's own row, when the page that carries it has been loaded. */
  self: OfficePerson | null;
  observedAt: number | null;
  error: OfficeError | null;
  /** Continuation token for the next page, null when the roster is complete. */
  nextCursor: string | null;
  /** True while an own-state write (willingness / connectivity) is in flight. */
  saving: boolean;
}

export interface OfficeStoreOptions {
  /** The authorized calls API. Must already be past `calls.preflight`. */
  calls: Pick<
    CallsApi,
    "discoverOffice" | "setOfficePreference" | "setOfficeConnectivity"
  >;
  /** This device's person uid, so `self` can be picked out of the roster. */
  selfPersonUid: string;
  /** Injected clock — expiry is never read from an ambient `Date.now`. */
  now?: () => number;
  /** Page size; clamped to the service maximum. */
  pageLimit?: number;
}

/** Refusals that mean "this host cannot do native calling at all". */
const UNSUPPORTED_CODES = new Set([
  "CALLS_UNSUPPORTED_HOST",
  "CALLS_PREFLIGHT_REQUIRED",
]);
/** Refusal that means the company has native calls switched off. */
const DISABLED_CODE = "FEATURE_DISABLED";

const FRIENDLY: Readonly<Record<string, string>> = {
  COMPANY_ACCESS_DENIED: "You do not have access to this company's office.",
  FEATURE_DISABLED: "Native calls are not enabled for this company.",
  CALLS_UNSUPPORTED_HOST: "Native calls are not available on this host.",
  CALLS_PREFLIGHT_REQUIRED:
    "Calling is not verified on this device yet. Reopen the app to retry.",
  INVALID_INPUT: "That office-hours setting was refused.",
  RATE_LIMITED: "Too many office updates. Try again in a moment.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function parseRoom(value: unknown): OfficeRoom | null {
  if (!isRecord(value)) return null;
  const roomId = str(value.roomId);
  const callId = str(value.callId);
  const epoch = finite(value.epoch);
  if (!roomId || !callId || epoch === null) return null;
  const participants = Array.isArray(value.participants)
    ? value.participants.map(String).filter((entry) => entry.length > 0)
    : [];
  return { roomId, callId, epoch, participants };
}

/** Parse one wire person. Unknown enum values fall back to the safe default. */
export function parseOfficePerson(value: unknown): OfficePerson | null {
  if (!isRecord(value)) return null;
  const personUid = str(value.personUid);
  if (!personUid) return null;
  const room = parseRoom(value.room);
  return {
    personUid,
    connectivity: oneOf(value.connectivity, OFFICE_CONNECTIVITY, "offline"),
    connectivityExpiresAt: finite(value.connectivityExpiresAt),
    // "knock" is the service's own default: absent willingness is never "open".
    willingness: oneOf(value.willingness, OFFICE_WILLINGNESS, "knock"),
    willingnessExpiresAt: finite(value.willingnessExpiresAt),
    occupancy: value.occupancy === "occupied" ? "occupied" : "unoccupied",
    occupancyExpiresAt: finite(value.occupancyExpiresAt),
    ...(room ? { room } : {}),
  };
}

/**
 * Apply the server's `*ExpiresAt` leases against the local clock.
 *
 * The server already expires on read, but a roster rendered for longer than a
 * lease must not keep claiming someone is open or in a room. Each fact expires
 * on its OWN lease — an expired willingness does not touch connectivity.
 */
export function expireOfficePerson(
  person: OfficePerson,
  now: number,
): OfficePerson {
  let next = person;
  const replace = (patch: Partial<OfficePerson>): void => {
    next = { ...next, ...patch };
  };
  if (next.connectivityExpiresAt !== null && next.connectivityExpiresAt <= now) {
    replace({ connectivity: "offline", connectivityExpiresAt: null });
  }
  if (next.willingnessExpiresAt !== null && next.willingnessExpiresAt <= now) {
    replace({ willingness: "knock", willingnessExpiresAt: null });
  }
  if (next.occupancyExpiresAt !== null && next.occupancyExpiresAt <= now) {
    replace({ occupancy: "unoccupied", occupancyExpiresAt: null });
    if (next.room) {
      const { room: _room, ...rest } = next;
      next = rest as OfficePerson;
    }
  }
  return next;
}

/** True when a member's room is present AND still current enough to open. */
export function isRoomJoinable(person: OfficePerson, now: number): boolean {
  const live = expireOfficePerson(person, now);
  return live.occupancy === "occupied" && live.room !== undefined;
}

function failureOf(result: AdapterResult<unknown>): OfficeError {
  const failure = result.ok ? null : result;
  const code = failure?.code ?? "UNKNOWN";
  const message =
    FRIENDLY[code] ??
    failure?.message ??
    "The office could not be loaded. Try again.";
  return { code, message };
}

export interface OfficeStore {
  readonly state: OfficeState;
  /**
   * Synchronously bind the store to a company and clear everything the
   * previous company put on screen.
   *
   * A host whose company switch has to `await` something first (identity,
   * preflight) must call this FIRST, in the same tick as the switch. Without
   * it the previous company's roster stays rendered for as long as the host's
   * preparation takes — a stale assertion about who is reachable, under the
   * new company's heading. `load()` calls it for you.
   */
  reset(companyUid: string | null): void;
  /** Switch to a company: clears state, then loads its first page. */
  load(companyUid: string): Promise<void>;
  /** Re-read the CURRENT company from scratch (page 1). */
  refresh(): Promise<void>;
  /** Fetch and append the next page, when `state.nextCursor` is set. */
  loadMore(): Promise<void>;
  setWillingness(willingness: OfficeWillingness, ttlMs: number): Promise<void>;
  setConnectivity(
    connectivity: OfficeConnectivity,
    ttlMs?: number,
  ): Promise<void>;
  /** Roster with leases applied at `now()` — what the UI renders. */
  visiblePeople(): OfficePerson[];
  /** Own row with leases applied at `now()`. */
  visibleSelf(): OfficePerson | null;
  /** Test/host seam: the current request generation. */
  generation(): number;
}

export function createOfficeStore(options: OfficeStoreOptions): OfficeStore {
  const now = options.now ?? (() => Date.now());
  const limit = Math.min(
    Math.max(1, options.pageLimit ?? OFFICE_LIMITS.pageSize),
    OFFICE_LIMITS.pageSize,
  );

  let state = $state<OfficeState>({
    status: "idle",
    companyUid: null,
    people: [],
    self: null,
    observedAt: null,
    error: null,
    nextCursor: null,
    saving: false,
  });

  /**
   * Request generation. Bumped on EVERY load/refresh/company switch, so a
   * response is only accepted when it is still the newest request for the same
   * company. This is what keeps a slow company-A response out of company B.
   */
  let generation = 0;

  function current(gen: number, companyUid: string): boolean {
    return gen === generation && state.companyUid === companyUid;
  }

  function selfOf(people: OfficePerson[]): OfficePerson | null {
    return (
      people.find((person) => person.personUid === options.selfPersonUid) ?? null
    );
  }

  function applyFailure(result: AdapterResult<unknown>): void {
    const error = failureOf(result);
    if (error.code === DISABLED_CODE) {
      state = { ...state, status: "disabled", error, people: [], self: null };
      return;
    }
    if (UNSUPPORTED_CODES.has(error.code)) {
      state = { ...state, status: "unsupported", error, people: [], self: null };
      return;
    }
    // A refused page leaves NO roster behind: a stale roster is worse than an
    // explicit error, because it keeps asserting who is reachable.
    state = { ...state, status: "error", error, people: [], self: null };
  }

  async function fetchPage(
    companyUid: string,
    gen: number,
    cursor: string | null,
  ): Promise<void> {
    const result = await options.calls.discoverOffice(companyUid, {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    if (!current(gen, companyUid)) return;
    if (!result.ok) {
      applyFailure(result);
      return;
    }
    const body = isRecord(result.value) ? result.value : {};
    // The service answers with the company it acted on; a mismatch is a stale
    // or mis-routed response and is dropped rather than merged.
    const answered = str(body.companyUid);
    if (answered !== null && answered !== companyUid) return;
    const rows = Array.isArray(body.people) ? body.people : [];
    const parsed = rows
      .map(parseOfficePerson)
      .filter((person): person is OfficePerson => person !== null);
    const merged = cursor ? [...state.people, ...parsed] : parsed;
    state = {
      ...state,
      status: "ready",
      people: merged,
      self: selfOf(merged) ?? (cursor ? state.self : null),
      observedAt: finite(body.observedAt) ?? now(),
      error: null,
      // The controller returns `cursor`; `nextCursor` is accepted too so a
      // future rename of the wire field does not silently drop paging.
      nextCursor: str(body.nextCursor) ?? str(body.cursor),
    };
  }

  /**
   * Synchronous half of a load: bump the generation (so any in-flight answer
   * for the previous request is discarded) and install the new company's
   * empty — or, on a refresh, retained — view. Returns the generation the
   * caller must quote when folding a response back in.
   */
  function begin(companyUid: string | null, keepRoster: boolean): number {
    const gen = ++generation;
    state = {
      status: companyUid ? "loading" : "idle",
      companyUid,
      people: keepRoster ? state.people : [],
      self: keepRoster ? state.self : null,
      observedAt: keepRoster ? state.observedAt : null,
      error: null,
      nextCursor: null,
      saving: false,
    };
    return gen;
  }

  async function start(companyUid: string, keepRoster: boolean): Promise<void> {
    const gen = begin(companyUid, keepRoster);
    await fetchPage(companyUid, gen, null);
  }

  function applyOwnState(value: Json, gen: number, companyUid: string): void {
    if (!current(gen, companyUid)) return;
    const body = isRecord(value) ? value : {};
    const preference = isRecord(body.preference) ? body.preference : null;
    const presence = isRecord(body.presence) ? body.presence : null;
    const base: OfficePerson = state.self ?? {
      personUid: options.selfPersonUid,
      connectivity: "offline",
      connectivityExpiresAt: null,
      willingness: "knock",
      willingnessExpiresAt: null,
      occupancy: "unoccupied",
      occupancyExpiresAt: null,
    };
    let next = base;
    if (preference && str(preference.companyUid) === companyUid) {
      next = {
        ...next,
        willingness: oneOf(preference.willingness, OFFICE_WILLINGNESS, "knock"),
        willingnessExpiresAt: finite(preference.expiresAt),
      };
    }
    if (presence && str(presence.companyUid) === companyUid) {
      next = {
        ...next,
        connectivity: oneOf(presence.connectivity, OFFICE_CONNECTIVITY, "offline"),
        connectivityExpiresAt: finite(presence.expiresAt),
      };
    }
    // A failed page cleared the roster on purpose: `status: "error"` means the
    // view is asserting "we do not know who is here". Folding our own row back
    // in would turn that into a one-person office that looks authoritative.
    // The own state is still recorded, so a later retry renders it.
    if (state.status === "error") {
      state = { ...state, self: next };
      return;
    }
    state = {
      ...state,
      self: next,
      people: state.people.some(
        (person) => person.personUid === options.selfPersonUid,
      )
        ? state.people.map((person) =>
            person.personUid === options.selfPersonUid ? next : person,
          )
        : [...state.people, next],
    };
  }

  async function write(
    run: (companyUid: string) => Promise<AdapterResult<Json>>,
  ): Promise<void> {
    const companyUid = state.companyUid;
    if (!companyUid) return;
    const gen = generation;
    state = { ...state, saving: true };
    const result = await run(companyUid);
    if (!current(gen, companyUid)) return;
    if (!result.ok) {
      const error = failureOf(result);
      state = {
        ...state,
        saving: false,
        error,
        ...(error.code === DISABLED_CODE ? { status: "disabled" as const } : {}),
      };
      return;
    }
    applyOwnState(result.value, gen, companyUid);
    state = { ...state, saving: false, error: null };
  }

  function clampTtl(ttlMs: number | undefined): number {
    const value = ttlMs ?? OFFICE_LIMITS.leaseMs;
    return Math.min(
      Math.max(OFFICE_LIMITS.minLeaseMs, Math.round(value)),
      OFFICE_LIMITS.leaseMs,
    );
  }

  return {
    get state() {
      return state;
    },
    reset(companyUid: string | null): void {
      begin(companyUid, false);
    },
    async load(companyUid: string): Promise<void> {
      await start(companyUid, false);
    },
    async refresh(): Promise<void> {
      const companyUid = state.companyUid;
      if (!companyUid) return;
      // The roster stays on screen while the refresh is in flight; it is
      // replaced (or cleared, on a refusal) when the answer lands.
      await start(companyUid, true);
    },
    async loadMore(): Promise<void> {
      const companyUid = state.companyUid;
      const cursor = state.nextCursor;
      if (!companyUid || !cursor || state.status !== "ready") return;
      await fetchPage(companyUid, generation, cursor);
    },
    async setWillingness(
      willingness: OfficeWillingness,
      ttlMs: number,
    ): Promise<void> {
      await write((companyUid) =>
        options.calls.setOfficePreference({
          companyUid,
          willingness,
          ttlMs: clampTtl(ttlMs),
        }),
      );
    },
    async setConnectivity(
      connectivity: OfficeConnectivity,
      ttlMs?: number,
    ): Promise<void> {
      await write((companyUid) =>
        options.calls.setOfficeConnectivity({
          companyUid,
          connectivity,
          ttlMs: clampTtl(ttlMs),
        }),
      );
    },
    visiblePeople(): OfficePerson[] {
      const at = now();
      return state.people.map((person) => expireOfficePerson(person, at));
    },
    visibleSelf(): OfficePerson | null {
      return state.self ? expireOfficePerson(state.self, now()) : null;
    },
    generation(): number {
      return generation;
    },
  };
}
