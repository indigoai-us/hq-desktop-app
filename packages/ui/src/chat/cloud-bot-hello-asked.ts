/**
 * What this device remembers about new cloud bots per signed-in account:
 * when the app asked each bot for its first message, and which bots that
 * account made here.
 *
 * WHEN A BOT WAS ASKED. The connection cards sit under the bot's first
 * message. The app finds that message as the bot's first row after its own
 * hidden hello request. A page the server filtered for people (`view=human`)
 * does not carry that request, and the takeover that knew when it was sent
 * is gone once the person is in the conversation. With the time kept here,
 * the first message can still be found: it is the bot's first row written
 * after the request went out (agent-channel.ts, `agentHelloEventIdByAskTime`).
 * One number per bot, the first ask only: a repeat of the request is the
 * same request to the server.
 *
 * WHO MADE A BOT HERE. A bot made in the New Bot flow on this device is
 * treated as a cloud bot at once, before the server has answered anything
 * about it. That is a fact about the person who made it, not about the Mac:
 * a second account signing in on the same Mac must not inherit it.
 *
 * Everything is kept per account (the person's uid). Storage written before
 * accounts were kept apart held one flat list of bots; nobody can say whose
 * those were, so that shape is read as empty and replaced on the next write.
 */

export const BOT_HELLO_ASKED_STORAGE_KEY = "hq.chat.botHelloAskedAt.v1";

/** How many bots are kept per account for the ask times, newest first. */
export const MAX_HELLO_ASKED = 50;
/** How many bots are kept per account as made here, newest first. */
export const MAX_BOTS_MADE = 200;
/** How many accounts are kept, most recently written first. */
export const MAX_ACCOUNTS = 10;

/** Agent uid to the time the hello request was sent (ms). */
export type HelloAskedTimes = Record<string, number>;

/** What one account did with new cloud bots on this device. */
export interface AccountBots {
  asked: HelloAskedTimes;
  /** Bots this account made in the New Bot flow here, newest first. */
  made: string[];
}

/** Account (person uid) to what it did here. */
export type BotsByAccount = Record<string, AccountBots>;

type AskedStorage = Pick<Storage, "getItem" | "setItem">;

const NO_TIMES: HelloAskedTimes = Object.freeze({}) as HelloAskedTimes;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function botUid(value: unknown): string {
  const uid = typeof value === "string" ? value.trim() : "";
  return uid.startsWith("agt_") ? uid : "";
}

function accountKey(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function cleanAccount(raw: unknown): AccountBots | null {
  if (!isRecord(raw)) return null;
  const asked: HelloAskedTimes = {};
  if (isRecord(raw.asked)) {
    for (const [uid, at] of Object.entries(raw.asked)) {
      if (Object.keys(asked).length >= MAX_HELLO_ASKED) break;
      if (botUid(uid) && usableTime(at)) asked[botUid(uid)] = at;
    }
  }
  const made: string[] = [];
  if (Array.isArray(raw.made)) {
    for (const entry of raw.made) {
      if (made.length >= MAX_BOTS_MADE) break;
      const uid = botUid(entry);
      if (uid && !made.includes(uid)) made.push(uid);
    }
  }
  return { asked, made };
}

/**
 * Read what is kept. Missing, malformed or unreadable storage is empty, and
 * so is the old shape (bots at the top level, with no account). Never throws.
 */
export function loadBotsByAccount(storage: AskedStorage | null | undefined): BotsByAccount {
  try {
    const raw = storage?.getItem(BOT_HELLO_ASKED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.accounts)) return {};
    const out: BotsByAccount = {};
    for (const [account, entry] of Object.entries(parsed.accounts)) {
      if (Object.keys(out).length >= MAX_ACCOUNTS) break;
      const key = accountKey(account);
      // An account is a person. A bot's uid here is the old shape, nested by mistake.
      if (!key || key.startsWith("agt_")) continue;
      const clean = cleanAccount(entry);
      if (clean) out[key] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write what is kept. Best effort: a full or blocked storage is ignored. */
export function saveBotsByAccount(storage: AskedStorage | null | undefined, all: BotsByAccount): void {
  try {
    storage?.setItem(BOT_HELLO_ASKED_STORAGE_KEY, JSON.stringify({ v: 2, accounts: all }));
  } catch {
    // best-effort
  }
}

/** Put one account's entry in, first, and keep at most {@link MAX_ACCOUNTS}. */
function withAccount(all: BotsByAccount, account: string, entry: AccountBots): BotsByAccount {
  const out: BotsByAccount = { [account]: entry };
  for (const [other, kept] of Object.entries(all)) {
    if (Object.keys(out).length >= MAX_ACCOUNTS) break;
    if (other !== account) out[other] = kept;
  }
  return out;
}

/**
 * The ask times of one account. An unknown account has none: with nobody
 * signed in, nothing kept here applies. The same empty object every time.
 */
export function helloAskedFor(all: BotsByAccount, accountUid: string | null | undefined): HelloAskedTimes {
  const account = accountKey(accountUid);
  return (account && all[account]?.asked) || NO_TIMES;
}

/**
 * Record that this account asked a bot at `atMs`. The first ask stays: the
 * same object comes back when the bot already has a time, or when the
 * account, the uid or the time is not usable.
 */
export function withHelloAsked(
  all: BotsByAccount,
  accountUid: string | null | undefined,
  agentUid: string,
  atMs: number,
): BotsByAccount {
  const account = accountKey(accountUid);
  const uid = botUid(agentUid);
  if (!account || !uid || !usableTime(atMs)) return all;
  const current = all[account] ?? { asked: {}, made: [] };
  if (usableTime(current.asked[uid])) return all;
  const asked: HelloAskedTimes = { [uid]: atMs };
  for (const [other, at] of Object.entries(current.asked)) {
    if (Object.keys(asked).length >= MAX_HELLO_ASKED) break;
    if (other !== uid) asked[other] = at;
  }
  return withAccount(all, account, { ...current, asked });
}

/** Forget one account's ask time for a bot. The same object when it had none. */
export function withoutHelloAsked(all: BotsByAccount, accountUid: string | null | undefined, agentUid: string): BotsByAccount {
  const account = accountKey(accountUid);
  const uid = agentUid.trim();
  const current = account ? all[account] : undefined;
  if (!current || !(uid in current.asked)) return all;
  const { [uid]: _gone, ...asked } = current.asked;
  return { ...all, [account]: { ...current, asked } };
}

/**
 * Record that this account made a bot here. The same object when it is
 * already recorded, or the account or the uid is not usable. A bot has one
 * maker: it is taken off any other account's list.
 */
export function withBotMadeBy(all: BotsByAccount, accountUid: string | null | undefined, agentUid: string): BotsByAccount {
  const account = accountKey(accountUid);
  const uid = botUid(agentUid);
  if (!account || !uid) return all;
  const current = all[account] ?? { asked: {}, made: [] };
  if (current.made.includes(uid)) return all;
  let next: BotsByAccount = all;
  for (const [other, entry] of Object.entries(all)) {
    if (other === account || !entry.made.includes(uid)) continue;
    next = { ...next, [other]: { ...entry, made: entry.made.filter((id) => id !== uid) } };
  }
  return withAccount(next, account, { ...current, made: [uid, ...current.made].slice(0, MAX_BOTS_MADE) });
}

/**
 * Whether a bot is known to have been made here by an account other than
 * the one signed in. Then the signed-in account does not get "made here"
 * for it. False when nobody is recorded as its maker (a bot from before
 * accounts were kept apart), when this account made it, and when the
 * signed-in account is not known.
 */
export function botMadeByAnotherAccount(all: BotsByAccount, accountUid: string | null | undefined, agentUid: string): boolean {
  const account = accountKey(accountUid);
  const uid = agentUid.trim();
  if (!account || !uid) return false;
  for (const [other, entry] of Object.entries(all)) {
    if (other !== account && entry.made.includes(uid)) return true;
  }
  return false;
}

/** A bot is gone: forget it for every account. The same object when nobody had it. */
export function withoutBot(all: BotsByAccount, agentUid: string): BotsByAccount {
  const uid = agentUid.trim();
  let next: BotsByAccount = all;
  for (const [account, entry] of Object.entries(all)) {
    if (!(uid in entry.asked) && !entry.made.includes(uid)) continue;
    const { [uid]: _gone, ...asked } = entry.asked;
    next = { ...next, [account]: { asked, made: entry.made.filter((id) => id !== uid) } };
  }
  return next;
}
