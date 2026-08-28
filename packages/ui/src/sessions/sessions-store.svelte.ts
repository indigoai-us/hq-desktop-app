import type { AdapterResult } from "@hq/platform";
import {
  type AgentSession,
  type HistoryEvent,
  type MissionControlSnapshot,
  type OutpostStatus,
} from "./sessions.js";

// ---------------------------------------------------------------------------
// Mission Control sessions store (desktop-alt port).
//
// Module-level singleton runes state — same shape as the chat agency-store.
// Desktop-alt kept this fresh via the backend `sessions:updated` Tauri poll
// event; in the pure UI package the platform seam is a `SessionsStoreApi`
// injected with `configureSessionsApi(...)` (built on
// `adapter.sessions.listAgentSessions`, an AdapterResult surface) and a light
// JS interval replaces the backend event stream. On web the capability
// `canSpawnSessions` is absent, `listAgentSessions` resolves
// `{ok:false, reason:"unavailable"}`, and the store parks in `unavailable`
// so panels render the standard degraded state (never a dead spinner).
// ---------------------------------------------------------------------------

/** Narrow platform seam replacing the desktop `list_agent_sessions` command.
 *  Accepts the adapter's loosely-typed payload; the snapshot shape is applied
 *  here (matching the original wire contract). */
export interface SessionsStoreApi {
  listAgentSessions(): Promise<AdapterResult<unknown>>;
}

let api: SessionsStoreApi | null = null;

/** Inject the platform backend before startSessionsStore(). */
export function configureSessionsApi(next: SessionsStoreApi | null): void {
  api = next;
}

let sessions = $state<AgentSession[]>([]);
let history = $state<HistoryEvent[]>([]);
// The box-level outpost status card (US-011), or null when no outpost is known.
// Replaced on every poll; the Live panel heads its outpost group with it.
let outpost = $state<OutpostStatus | null>(null);
// The number of outpost sessions showing in the *previous* snapshot. When the
// box goes stale the backend drops them (sessions empty), so this lets the box
// card surface "N sessions dropped after the stale timeout" — we remember how
// many we just lost.
let lastOutpostCount = $state(0);
// `true` until the very first snapshot lands — drives the loading skeleton.
let loading = $state(true);
// Set when the initial fetch fails; the panel can surface it instead of a
// misleading empty state. Poll failures are best-effort (logged only).
let error = $state("");
// Platform does not offer local agent sessions (web) — standard degraded state.
let unavailable = $state(false);

// Lifecycle guards — the store outlives any single page mount.
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Poll cadence replacing the Rust `sessions:updated` event interval. */
const REFRESH_MS = 5000;

// Fingerprint of the last applied snapshot. Reassigning `sessions`/`history`
// mints a new array identity that invalidates every derived and re-renders
// every mounted panel; doing that on each 5s poll even when nothing changed was
// a periodic main-thread stall that beat against clicks. We skip the reactive
// writes when the incoming snapshot is byte-identical to the last one.
let lastSnapshotKey = "";

/** Apply a fresh snapshot to the reactive state. */
function applySnapshot(snapshot: MissionControlSnapshot): void {
  const next = snapshot.sessions ?? [];
  const nextHistory = snapshot.history ?? [];
  const nextOutpost = snapshot.outpost ?? null;

  const nextKey = JSON.stringify({ s: next, h: nextHistory, o: nextOutpost });
  if (!loading && nextKey === lastSnapshotKey) return;
  lastSnapshotKey = nextKey;

  // Track how many outpost sessions were showing BEFORE this snapshot, so when
  // the stale timeout drops them to zero the box card can report the count that
  // just vanished. Computed off the prior `sessions` (current state).
  const priorOutpostCount = sessions.filter(
    (s) => s.origin === "outpost",
  ).length;
  const nextOutpostCount = next.filter((s) => s.origin === "outpost").length;
  // Remember the last NON-zero count so a freshly-stale snapshot (now zero)
  // still knows how many were dropped.
  lastOutpostCount =
    nextOutpostCount > 0 ? nextOutpostCount : priorOutpostCount;

  sessions = next;
  history = nextHistory;
  outpost = nextOutpost;
  loading = false;
}

/**
 * Run one immediate scan so panels have data before the first poll tick.
 * Errors are surfaced (not swallowed to a blank state) but never thrown.
 */
async function refresh(): Promise<void> {
  if (!api) {
    unavailable = true;
    loading = false;
    return;
  }
  const result = await api.listAgentSessions();
  if (result.ok) {
    unavailable = false;
    applySnapshot(result.value as MissionControlSnapshot);
    error = "";
    return;
  }
  if (result.reason === "unavailable") {
    unavailable = true;
    loading = false;
    return;
  }
  console.error("list_agent_sessions failed:", result.message);
  error = "Could not load sessions.";
  loading = false;
}

/**
 * Start the singleton once for the app's lifetime: one immediate fetch for
 * instant paint, then a JS interval poll (replaces the desktop backend event).
 * Idempotent via `started`. Called from LiveSessionsPanel /
 * SessionHistoryPanel / project surfaces onMount.
 */
export function startSessionsStore(): void {
  if (started) return;
  started = true;
  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
}

/**
 * Tear down the poll. Not used in the running app (the store lives for the
 * whole session) but exported so tests can reset between runs.
 */
export function stopSessionsStore(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  sessions = [];
  history = [];
  outpost = null;
  lastOutpostCount = 0;
  lastSnapshotKey = "";
  loading = true;
  error = "";
  unavailable = false;
}

/** Reactive read surface — getters keep consumers subscribed to the $state. */
export const sessionsStore = {
  get sessions() {
    return sessions;
  },
  get history() {
    return history;
  },
  /** The box-level outpost status card (US-011), or null when no outpost known. */
  get outpost() {
    return outpost;
  },
  /** How many outpost sessions were showing before they were last dropped — feeds
   *  the box card's stale-timeout "N sessions dropped" note. */
  get lastOutpostCount() {
    return lastOutpostCount;
  },
  get loading() {
    return loading;
  },
  get error() {
    return error;
  },
  /** True when this platform cannot list local agent sessions (web). */
  get unavailable() {
    return unavailable;
  },
  refresh,
};
