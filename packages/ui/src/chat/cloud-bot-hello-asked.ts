/**
 * When the app asked each new cloud bot for its first message, kept on this
 * device.
 *
 * The connection cards sit under the bot's first message. The app finds that
 * message as the bot's first row after its own hidden hello request. A page
 * the server filtered for people (`view=human`) does not carry that request,
 * and the takeover that knew when it was sent is gone once the person is in
 * the conversation. With the time kept here, the first message can still be
 * found: it is the bot's first row written after the request went out
 * (agent-channel.ts, `agentHelloEventIdByAskTime`).
 *
 * One number per bot, the first ask only: a repeat of the request is the
 * same request to the server.
 */

export const BOT_HELLO_ASKED_STORAGE_KEY = "hq.chat.botHelloAskedAt.v1";

/** How many bots are kept, newest first. */
export const MAX_HELLO_ASKED = 50;

/** Agent uid to the time the hello request was sent (ms). */
export type HelloAskedTimes = Record<string, number>;

type AskedStorage = Pick<Storage, "getItem" | "setItem">;

function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Read the times. Missing, malformed or unreadable storage is empty. Never throws. */
export function loadHelloAsked(storage: AskedStorage | null | undefined): HelloAskedTimes {
  try {
    const raw = storage?.getItem(BOT_HELLO_ASKED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: HelloAskedTimes = {};
    for (const [uid, at] of Object.entries(parsed)) {
      if (Object.keys(out).length >= MAX_HELLO_ASKED) break;
      if (uid.startsWith("agt_") && usable(at)) out[uid] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the times. Best effort: a full or blocked storage is ignored. */
export function saveHelloAsked(storage: AskedStorage | null | undefined, times: HelloAskedTimes): void {
  try {
    storage?.setItem(BOT_HELLO_ASKED_STORAGE_KEY, JSON.stringify(times));
  } catch {
    // best-effort
  }
}

/**
 * Record that a bot was asked at `atMs`. The first ask stays: the same object
 * comes back when the bot already has a time, or when the uid or the time is
 * not usable. Newest first, at most {@link MAX_HELLO_ASKED} bots.
 */
export function withHelloAsked(times: HelloAskedTimes, agentUid: string, atMs: number): HelloAskedTimes {
  const uid = agentUid.trim();
  if (!uid.startsWith("agt_") || !usable(atMs) || usable(times[uid])) return times;
  const out: HelloAskedTimes = { [uid]: atMs };
  for (const [other, at] of Object.entries(times)) {
    if (Object.keys(out).length >= MAX_HELLO_ASKED) break;
    if (other !== uid) out[other] = at;
  }
  return out;
}

/** Forget one bot. The same object when it was not there. */
export function withoutHelloAsked(times: HelloAskedTimes, agentUid: string): HelloAskedTimes {
  const uid = agentUid.trim();
  if (!(uid in times)) return times;
  const { [uid]: _gone, ...rest } = times;
  return rest;
}
