/**
 * Knock store (US-019) — authoritative knock state for every surface.
 *
 * Read `knocks.ts` first: it documents which way round a knock goes. In short,
 * the KNOCKER binds their own open room and the TARGET's acceptance issues the
 * admission capability back to the knocker.
 *
 * Three rules this store exists to keep:
 *
 *  1. `GET /knocks` and `GET /knocks/{id}` are the only authority. Wakes,
 *     notifications and polls are hints that cause a `refresh()`; they never
 *     set state themselves. Every action re-reads the row it acted on.
 *  2. Nothing renders twice. Rows are merged by `knockId`, so a duplicate wake,
 *     a poll and a focus refresh converge on ONE card.
 *  3. Company isolation is explicit. `bind(companyUid)` clears synchronously
 *     and bumps a generation; a late answer for the company we just left is
 *     dropped rather than folded into the new company's list.
 */

import type { AdapterResult, CallsApi, Json, KnockAction } from "@hq/platform";

import {
  KNOCK_LIMITS,
  expireKnock,
  isNoteTooLong,
  knockFailure,
  mergeKnock,
  parseKnock,
  parseKnockList,
  sortKnocks,
  type Knock,
  type KnockError,
  type KnockSendOutcome,
} from "./knocks.js";

/** The room the knocker knocks WITH. Supplied by the host, never invented. */
export interface KnockRoomBinding {
  roomId: string;
  callId: string;
  epoch: number;
}

export interface KnockState {
  companyUid: string | null;
  /** Knocks addressed to us, from `GET /knocks`. */
  received: Knock[];
  /** Knocks we sent, tracked by id through `GET /knocks/{id}`. */
  sent: Knock[];
  loading: boolean;
  /** True while a send/accept/decline/defer/cancel is in flight. */
  busy: boolean;
  error: KnockError | null;
  /** Last send outcome, so the composer can explain duplicate/suppressed. */
  lastSend: KnockSendOutcome | null;
  /** Set by the host from the office self row; suppresses OS banners only. */
  dnd: boolean;
}

/**
 * An older host may hand down a `calls` group without the knock methods. That
 * is a missing capability, not a crash: the surface refuses in words.
 */
const MISSING_KNOCKS: KnockError = {
  code: "CALLS_UNSUPPORTED_HOST",
  message: "Knocks are not available on this host.",
};

export interface KnockStoreOptions {
  calls: Pick<
    CallsApi,
    "createKnock" | "listKnocks" | "getKnock" | "respondToKnock"
  >;
  /** Injected clock. Expiry is never read from an ambient `Date.now`. */
  now?: () => number;
  /** Initial company binding; `bind()` changes it. */
  companyUid?: string | null;
  /**
   * Open (or create) the caller's OWN room to knock with. Returning null means
   * "there is nothing to knock about" and the send is refused locally, before
   * any request goes out.
   */
  resolveRoom?: (target: string) => Promise<KnockRoomBinding | null>;
  /** Idempotency keys. Injected so a test can make a send deterministic. */
  newKey?: () => string;
  /** Called once per knockId that becomes newly visible and actionable. */
  onKnockArrived?: (knock: Knock) => void;
}

export interface KnockStore {
  readonly state: KnockState;
  /** Synchronously rebind to a company and clear the previous one's knocks. */
  bind(companyUid: string | null): void;
  /** Re-read `GET /knocks` plus every tracked sent knock. */
  refresh(): Promise<void>;
  /** Re-read ONE knock (`GET /knocks/{id}`) and merge it. */
  reload(knockId: string): Promise<Knock | null>;
  send(target: string, note?: string): Promise<KnockSendOutcome>;
  accept(knockId: string): Promise<Knock | null>;
  decline(knockId: string): Promise<Knock | null>;
  defer(knockId: string): Promise<Knock | null>;
  cancel(knockId: string): Promise<Knock | null>;
  /** Set the DND flag from the office self row. */
  setDnd(dnd: boolean): void;
  /** Received knocks with local expiry applied, newest first, deduped. */
  visibleReceived(): Knock[];
  /** Our own sent knocks with local expiry applied, newest first. */
  visibleSent(): Knock[];
  /** Test/host seam: the current request generation. */
  generation(): number;
}

function body(result: AdapterResult<Json>): Record<string, unknown> {
  const value = result.ok ? result.value : null;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

let counter = 0;
function defaultKey(): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `knock-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
}

export function createKnockStore(options: KnockStoreOptions): KnockStore {
  const now = options.now ?? (() => Date.now());
  const newKey = options.newKey ?? defaultKey;

  let state = $state<KnockState>({
    companyUid: options.companyUid ?? null,
    received: [],
    sent: [],
    loading: false,
    busy: false,
    error: null,
    lastSend: null,
    dnd: false,
  });

  let generation = 0;
  /** knockIds already announced, so a duplicate wake never announces twice. */
  let announced = new Set<string>();

  function has(method: keyof KnockStoreOptions["calls"]): boolean {
    return typeof options.calls[method] === "function";
  }

  function current(gen: number, companyUid: string): boolean {
    return gen === generation && state.companyUid === companyUid;
  }

  function announce(knocks: readonly Knock[]): void {
    if (!options.onKnockArrived) return;
    const at = now();
    for (const knock of knocks) {
      if (announced.has(knock.knockId)) continue;
      announced.add(knock.knockId);
      if (expireKnock(knock, at).state !== "pending") continue;
      options.onKnockArrived(knock);
    }
  }

  function foldReceived(knocks: Knock[]): void {
    let next = state.received;
    for (const knock of knocks) next = mergeKnock(next, knock);
    state = { ...state, received: next };
    announce(knocks);
  }

  function foldOne(knock: Knock, direction: "received" | "sent"): void {
    if (direction === "sent") {
      state = { ...state, sent: mergeKnock(state.sent, knock) };
      return;
    }
    state = { ...state, received: mergeKnock(state.received, knock) };
    announce([knock]);
  }

  function bind(companyUid: string | null): void {
    generation += 1;
    announced = new Set();
    state = {
      companyUid,
      received: [],
      sent: [],
      loading: false,
      busy: false,
      error: null,
      lastSend: null,
      dnd: false,
    };
  }

  async function reload(knockId: string): Promise<Knock | null> {
    const companyUid = state.companyUid;
    if (!companyUid || !knockId || !has("getKnock")) return null;
    const gen = generation;
    const result = await options.calls.getKnock(knockId, companyUid);
    if (!current(gen, companyUid)) return null;
    if (!result.ok) {
      // A knock the server no longer knows about must leave the surface rather
      // than linger as a door that cannot be opened.
      if (result.code === "NOT_FOUND") {
        state = {
          ...state,
          received: state.received.filter((entry) => entry.knockId !== knockId),
          sent: state.sent.filter((entry) => entry.knockId !== knockId),
        };
      }
      state = { ...state, error: knockFailure(result) };
      return null;
    }
    const knock = parseKnock(result.value);
    if (!knock) return null;
    const direction = state.sent.some((entry) => entry.knockId === knockId)
      ? "sent"
      : "received";
    foldOne(knock, direction);
    return knock;
  }

  async function refresh(): Promise<void> {
    const companyUid = state.companyUid;
    if (!companyUid) return;
    if (!has("listKnocks")) {
      if (state.error?.code !== MISSING_KNOCKS.code) {
        state = { ...state, error: MISSING_KNOCKS };
      }
      return;
    }
    const gen = generation;
    state = { ...state, loading: true };
    const result = await options.calls.listKnocks(
      companyUid,
      KNOCK_LIMITS.listLimit,
    );
    if (!current(gen, companyUid)) return;
    if (!result.ok) {
      state = { ...state, loading: false, error: knockFailure(result) };
      return;
    }
    const knocks = parseKnockList(result.value).filter(
      (knock) => knock.companyUid === companyUid,
    );
    // `GET /knocks` is the whole received truth: rows it no longer lists are
    // gone, and rows it lists replace whatever a wake left behind.
    let received: Knock[] = [];
    for (const knock of knocks) received = mergeKnock(received, knock);
    state = { ...state, received, loading: false, error: null };
    announce(knocks);
    // Our own sent knocks are not in the received listing — re-read each one,
    // because an acceptance is where our admission capability shows up.
    const tracked = state.sent.map((entry) => entry.knockId);
    for (const id of tracked) await reload(id);
  }

  async function respond(
    knockId: string,
    action: KnockAction,
  ): Promise<Knock | null> {
    const companyUid = state.companyUid;
    if (!companyUid || !knockId) return null;
    if (!has("respondToKnock")) {
      state = { ...state, error: MISSING_KNOCKS };
      return null;
    }
    const gen = generation;
    state = { ...state, busy: true, error: null };
    const result = await options.calls.respondToKnock(
      knockId,
      action,
      companyUid,
    );
    if (!current(gen, companyUid)) return null;
    state = { ...state, busy: false };
    if (!result.ok) {
      state = { ...state, error: knockFailure(result) };
      // The refusal is the server's; re-read so every window agrees on why.
      await reload(knockId);
      return null;
    }
    const knock = parseKnock(result.value);
    if (knock) {
      foldOne(knock, action === "cancel" ? "sent" : "received");
      return knock;
    }
    return reload(knockId);
  }

  async function send(target: string, note = ""): Promise<KnockSendOutcome> {
    const companyUid = state.companyUid;
    const fail = (error: KnockError): KnockSendOutcome => {
      const outcome: KnockSendOutcome = {
        ok: false,
        created: false,
        duplicate: false,
        waked: false,
        error,
      };
      state = { ...state, busy: false, error, lastSend: outcome };
      return outcome;
    };
    if (!companyUid) {
      return fail({ code: "INVALID_INPUT", message: "No company is selected." });
    }
    if (!target) {
      return fail({ code: "INVALID_INPUT", message: "No one to knock for." });
    }
    if (!has("createKnock")) return fail(MISSING_KNOCKS);
    if (isNoteTooLong(note)) {
      return fail({
        code: "INVALID_INPUT",
        message: `Keep the note under ${KNOCK_LIMITS.noteMaxBytes} bytes.`,
      });
    }
    const gen = generation;
    state = { ...state, busy: true, error: null, lastSend: null };
    const room = await options.resolveRoom?.(target);
    if (!current(gen, companyUid)) {
      return { ok: false, created: false, duplicate: false, waked: false };
    }
    if (!room) {
      return fail({
        code: "KNOCK_NO_ROOM",
        message:
          "Your room could not be opened, so there was nothing to knock about.",
      });
    }
    const result = await options.calls.createKnock({
      companyUid,
      roomId: room.roomId,
      callId: room.callId,
      epoch: room.epoch,
      target,
      note,
      idempotencyKey: newKey(),
    });
    if (!current(gen, companyUid)) {
      return { ok: false, created: false, duplicate: false, waked: false };
    }
    if (!result.ok) return fail(knockFailure(result));
    const payload = body(result);
    const knock = parseKnock(payload.knock);
    const suppressed =
      payload.suppressed === "dnd" || payload.suppressed === "pending"
        ? payload.suppressed
        : undefined;
    const outcome: KnockSendOutcome = {
      ok: true,
      created: payload.created === true,
      duplicate: payload.duplicate === true,
      waked: payload.waked === true,
      ...(suppressed ? { suppressed } : {}),
      ...(knock ? { knock } : {}),
    };
    state = {
      ...state,
      busy: false,
      lastSend: outcome,
      ...(knock ? { sent: mergeKnock(state.sent, knock) } : {}),
    };
    return outcome;
  }

  return {
    get state() {
      return state;
    },
    bind,
    refresh,
    reload,
    send,
    accept: (knockId) => respond(knockId, "accept"),
    decline: (knockId) => respond(knockId, "decline"),
    defer: (knockId) => respond(knockId, "defer"),
    cancel: (knockId) => respond(knockId, "cancel"),
    setDnd(dnd) {
      // Idempotent on purpose: this is driven from an effect that mirrors the
      // office self row, and an unconditional write would make the effect its
      // own dependency and loop.
      if (state.dnd === dnd) return;
      state = { ...state, dnd };
    },
    visibleReceived() {
      const at = now();
      return sortKnocks(state.received.map((knock) => expireKnock(knock, at)));
    },
    visibleSent() {
      const at = now();
      return sortKnocks(state.sent.map((knock) => expireKnock(knock, at)));
    },
    generation: () => generation,
  };
}
