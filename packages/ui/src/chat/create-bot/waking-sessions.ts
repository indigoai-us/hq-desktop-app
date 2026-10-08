/**
 * The bots that are still starting, kept per signed-in account.
 *
 * A bot made in the New Bot flow has no conversation until it can chat. Until
 * then its waiting screen is the only way to its brain sign-in, and its
 * sidebar row is the only way back to that screen. Both used to live in one
 * variable inside the sidebar. The sidebar is rebuilt when the company scope
 * changes, when it is collapsed and reopened, when a view without it is
 * shown, and when the app restarts, and each of those lost the bot: it
 * existed on the server with no row and no way to sign it in.
 *
 * So the list lives here, outside any one sidebar:
 *
 *   - one list per account for the life of the window, shared by every
 *     sidebar that is mounted for that account, so a rebuilt sidebar has what
 *     its predecessor had, including a bot whose create request answered
 *     after the predecessor was gone;
 *   - written to localStorage, keyed by bot, so it is there after a restart;
 *   - one entry per bot, so a second bot never replaces the first.
 *
 * What is written down is what is needed to find the bot and resume the
 * wait. The sign-in link and code are never written: they are short-lived
 * secrets, and the status read hands out the current ones when the screen is
 * opened again.
 */

import { wakingProgress, type WakingBotSession } from "./waking-model.js";
import type { BrainProvider } from "./bot-brain-approval.js";

export const WAKING_BOTS_STORAGE_KEY = "hq.chat.wakingBots.v1";
/** A bot that has been starting for longer than this is no longer waited for. */
export const WAKING_SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
/** Never keep more than this many. Nobody starts that many bots in a day. */
const MAX_SESSIONS = 20;

type SessionStorage = Pick<Storage, "getItem" | "setItem">;

const BRAINS: readonly BrainProvider[] = ["codex", "claude", "grok"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function time(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * What a session is known by: its bot, or for a bot an older server named
 * only by channel, that channel. Empty when it has neither.
 */
export function wakingSessionKey(session: Pick<WakingBotSession, "agentUid" | "channelId">): string {
  const agentUid = session.agentUid.trim();
  if (agentUid) return agentUid;
  const channelId = session.channelId.trim();
  return channelId ? `ch:${channelId}` : "";
}

/** The list with this session put in the place of the one for the same bot, or added first. */
export function upsertWakingSession(
  sessions: readonly WakingBotSession[],
  session: WakingBotSession,
): WakingBotSession[] {
  const key = wakingSessionKey(session);
  if (!key) return [...sessions];
  let found = false;
  const next = sessions.map((existing) => {
    if (wakingSessionKey(existing) !== key) return existing;
    found = true;
    return session;
  });
  return found ? next : [session, ...next];
}

/** The list without the session for this bot. */
export function withoutWakingSession(
  sessions: readonly WakingBotSession[],
  key: string,
): WakingBotSession[] {
  const wanted = key.trim();
  return wanted ? sessions.filter((session) => wakingSessionKey(session) !== wanted) : [...sessions];
}

/**
 * Whether a session is still one to wait for. Not so once the bot is live,
 * once it is gone or out of reach, or once it has been starting for a day.
 * A screen that stopped because the app itself was signed out is kept: the
 * bot may be fine.
 */
export function wakingSessionCurrent(session: WakingBotSession, now: number = Date.now()): boolean {
  if (!wakingSessionKey(session)) return false;
  if (session.phase === "ready") return false;
  if (session.phase === "stopped" && session.stopped !== "signed-out") return false;
  return now - session.startedAt <= WAKING_SESSION_MAX_AGE_MS;
}

/** Read the kept sessions. Damaged or missing storage reads as none. */
export function loadWakingSessions(
  storage: Pick<Storage, "getItem"> | null | undefined,
  now: number = Date.now(),
): WakingBotSession[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(WAKING_BOTS_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: WakingBotSession[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const item = record(entry);
    const agentUid = text(item?.agentUid);
    const startedAt = time(item?.startedAt);
    // Only bots known by id are kept across a restart.
    if (!item || !agentUid || startedAt === null || seen.has(agentUid)) continue;
    const estimateMs = time(item.estimateMs);
    const signedInAt = time(item.signedInAt);
    const helloAskedAt = time(item.helloAskedAt);
    const helloKey = text(item.helloKey);
    const phase = item.phase === "failed" ? "failed" : "waking";
    const session: WakingBotSession = {
      agentUid,
      channelId: text(item.channelId),
      companyUid: text(item.companyUid),
      name: text(item.name) || "Your bot",
      brain: BRAINS.find((brain) => brain === item.brain) ?? null,
      startedAt,
      estimateMs: estimateMs ?? 180_000,
      phase,
      progress: signedInAt !== null ? 60 : wakingProgress(startedAt, now, estimateMs ?? 180_000),
      consecutiveCheckFailures: 0,
      // Never kept: the status read hands out the current sign-in.
      approval: null,
      approvalSince: null,
      signedInAt,
      askedApproval: item.askedApproval === true,
      // The moment the bot could chat is only kept with the request for its
      // first message. Without that request the wait for the message has not
      // begun, and it begins when the screen is opened again.
      chatReadyAt: helloAskedAt !== null ? time(item.chatReadyAt) : null,
      helloAskedAt,
      // A hello request that was begun: the next screen sends that same request.
      helloAskingAt: time(item.helloAskingAt),
      helloKey: helloKey || null,
    };
    if (!wakingSessionCurrent(session, now)) continue;
    seen.add(agentUid);
    out.push(session);
    if (out.length >= MAX_SESSIONS) break;
  }
  return out;
}

/** The text written for these sessions. Only bots known by id, and nothing secret. */
export function serializeWakingSessions(
  sessions: readonly WakingBotSession[],
  now: number = Date.now(),
): string {
  const rows = sessions
    .filter((session) => session.agentUid.trim() && wakingSessionCurrent(session, now))
    .slice(0, MAX_SESSIONS)
    .map((session) => ({
      agentUid: session.agentUid,
      channelId: session.channelId,
      companyUid: session.companyUid,
      name: session.name,
      brain: session.brain,
      startedAt: session.startedAt,
      estimateMs: session.estimateMs,
      // A screen that stopped because the app was signed out resumes as a wait.
      phase: session.phase === "failed" ? "failed" : "waking",
      signedInAt: session.signedInAt ?? null,
      askedApproval: session.askedApproval === true,
      chatReadyAt: session.helloAskedAt != null ? session.chatReadyAt ?? null : null,
      helloAskedAt: session.helloAskedAt ?? null,
      // A hello request that was begun, and its key. Only written when there is one.
      ...(session.helloAskingAt != null ? { helloAskingAt: session.helloAskingAt } : {}),
      ...(session.helloKey ? { helloKey: session.helloKey } : {}),
    }));
  return JSON.stringify(rows);
}

export interface WakingSessionStore {
  /** The current list. The same array until something changes it. */
  get(): WakingBotSession[];
  /** Change the list. Writes it down and tells every sidebar. Returns the new list. */
  update(change: (sessions: WakingBotSession[]) => WakingBotSession[]): WakingBotSession[];
  /** Hear about every change, whoever made it. Returns the way to stop. */
  subscribe(listener: () => void): () => void;
  /**
   * The bots read back from storage that nobody has checked on yet, each
   * handed out once. A restart can outlast a bot: the sidebar asks the server
   * about these before it goes on showing them as starting.
   */
  takeRestored(): string[];
  /**
   * Hand a restored bot back, unchecked: this sidebar is not showing its
   * company. The sidebar that does will take it.
   */
  deferRestored(agentUid: string): void;
}

function createStore(storage: SessionStorage | null): WakingSessionStore {
  const read = (): string | null => {
    try {
      return storage ? storage.getItem(WAKING_BOTS_STORAGE_KEY) : null;
    } catch {
      return null;
    }
  };
  let written = read();
  let sessions = loadWakingSessions(storage);
  const restored = new Set(sessions.map((session) => session.agentUid));
  const listeners = new Set<() => void>();

  /**
   * Storage holds something this store did not write: another window of the
   * app changed the list, or the site's data was cleared. What is there now
   * is the list. A bot still on it keeps what only memory holds (the sign-in
   * on screen); a bot no longer on it is dropped.
   */
  function followStorage(): void {
    if (!storage) return;
    const raw = read();
    if (raw === written) return;
    written = raw;
    const held = new Map(sessions.map((session) => [session.agentUid, session]));
    sessions = loadWakingSessions(storage).map((session) => {
      const known = held.get(session.agentUid);
      // Read from storage and not known here: nobody has checked on it yet.
      if (!known) restored.add(session.agentUid);
      return known ?? session;
    });
  }

  function write(): void {
    if (!storage) return;
    const next = serializeWakingSessions(sessions);
    if (next === written) return;
    try {
      storage.setItem(WAKING_BOTS_STORAGE_KEY, next);
      written = read();
    } catch (error) {
      console.warn("[hq-ui] best-effort failure at packages/ui/src/chat/create-bot/waking-sessions.ts:251", error);
      // Best effort: the list still holds for the life of the window.
    }
  }

  return {
    get() {
      followStorage();
      return sessions;
    },
    update(change) {
      followStorage();
      const now = Date.now();
      sessions = change(sessions).filter((session) => wakingSessionCurrent(session, now));
      write();
      for (const listener of [...listeners]) listener();
      return sessions;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    takeRestored() {
      const live = new Set(sessions.map((session) => session.agentUid));
      const out = [...restored].filter((agentUid) => live.has(agentUid));
      restored.clear();
      return out;
    },
    deferRestored(agentUid) {
      if (agentUid.trim()) restored.add(agentUid.trim());
    },
  };
}

/** One store per account for the life of the window. */
const stores = new Map<string, WakingSessionStore>();

/**
 * The store for this account. Every sidebar mounted for the account gets the
 * same one. With no account there is nothing to key it by and nowhere to
 * write, so the caller gets a list of its own that lives as long as it does.
 */
export function wakingSessionStore(
  accountId: string | null | undefined,
  storage: SessionStorage | null | undefined,
): WakingSessionStore {
  const account = (accountId ?? "").trim();
  if (!account) return createStore(null);
  let store = stores.get(account);
  if (!store) {
    store = createStore(storage ?? null);
    stores.set(account, store);
  }
  return store;
}

/** Forget every store. For tests, which reuse one account across cases. */
export function resetWakingSessionStores(): void {
  stores.clear();
}
