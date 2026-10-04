/**
 * The key a New Bot create is sent under.
 *
 * The server keeps the first answer to a create under the key the client
 * sent (`applyCreateAgentCardAction` in hq-pro-core, lifecycle/actions/
 * create-agent.ts) and derives the new bot's id from it. The same key sent
 * again gets that first answer back, bot included, and makes no second bot.
 *
 * The create used to go out under a fresh key every time. When its answer
 * was lost (a timeout, a dropped connection) the bot could exist while the
 * app knew nothing of it: a retry answered "a bot with that name already
 * exists", and Cancel said "Nothing was created".
 *
 * So one key is minted for a draft when Create bot is pressed, and it is
 * kept for as long as the outcome of that create is not known:
 *
 *   - pressing Create bot again for the same draft sends the same key and
 *     picks up the first answer;
 *   - it is written to storage before the request leaves, so an app that
 *     quits in the middle still has it.
 *
 * Pressing Create bot is the only thing that sends a create. Cancel never
 * does: it reads the company's bots to learn what the first request made
 * (created-bot-lookup.ts).
 *
 * Once the server has answered, whatever it answered, the key is let go: a
 * stored refusal (the plan, a name that is taken) would otherwise be played
 * back for ever, even after its cause was fixed.
 *
 * A key is also let go when the person cancels the create it was sent with
 * (the next create of the same draft is a new one, not that one again), and
 * when the bot it was sent for is removed.
 */

import type { CloudBotDraft } from "../lifecycle-entry-points.js";
import { botHandle } from "./create-bot-model.js";

export const CREATE_KEYS_STORAGE_KEY = "hq.chat.newBotCreateKeys.v1";
/** A create whose outcome is still unknown after a day is treated as a new one. */
export const CREATE_KEY_MAX_AGE_MS = 24 * 60 * 60_000;
/** Drafts with an unknown outcome kept at once. */
const MAX_PENDING = 5;

type KeyStorage = Pick<Storage, "getItem" | "setItem">;

export interface PendingCreateKey {
  key: string;
  /** Which draft the key was minted for (see `createDraftSignature`). */
  signature: string;
  mintedAt: number;
}

/**
 * What makes two presses of Create bot the same create: the company and
 * everything the server is asked to make. A different name is a different
 * bot and gets a key of its own.
 */
export function createDraftSignature(
  companyUid: string,
  draft: Pick<CloudBotDraft, "name" | "handle" | "runtime" | "size" | "authMode">,
): string {
  return [
    companyUid.trim(),
    botHandle({ name: draft.name, handle: draft.handle }),
    draft.runtime ?? "",
    draft.size ?? "",
    draft.authMode ?? "subscription",
  ].join("|");
}

export function mintCreateKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function current(pending: PendingCreateKey, now: number): boolean {
  return now - pending.mintedAt <= CREATE_KEY_MAX_AGE_MS;
}

/** Every well-formed key in storage, whatever its age. Damaged storage reads as none. */
function readAll(storage: Pick<Storage, "getItem"> | null | undefined): PendingCreateKey[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(CREATE_KEYS_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PendingCreateKey[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const signature = typeof row.signature === "string" ? row.signature : "";
    const mintedAt = typeof row.mintedAt === "number" && Number.isFinite(row.mintedAt) ? row.mintedAt : 0;
    if (!key || !signature || !mintedAt) continue;
    if (!out.some((other) => other.signature === signature)) out.push({ key, signature, mintedAt });
  }
  return out;
}

/** The keys kept for creates whose outcome is not known. Damaged storage reads as none. */
export function loadPendingCreateKeys(
  storage: Pick<Storage, "getItem"> | null | undefined,
  now: number = Date.now(),
): PendingCreateKey[] {
  return readAll(storage)
    .filter((pending) => current(pending, now))
    .slice(0, MAX_PENDING);
}

function save(pending: readonly PendingCreateKey[], storage: KeyStorage | null | undefined): void {
  try {
    storage?.setItem(CREATE_KEYS_STORAGE_KEY, JSON.stringify(pending.slice(0, MAX_PENDING)));
  } catch {
    // Best effort: the key still holds for the life of the window.
  }
}

/**
 * The key to send this create under. A draft whose last create has no known
 * outcome gets its key back (`reused`); any other draft gets a new one. The
 * key is written down here, before the request leaves.
 */
export function takeCreateKey(
  storage: KeyStorage | null | undefined,
  signature: string,
  options: { now?: number; mint?: () => string } = {},
): { key: string; reused: boolean } {
  const now = options.now ?? Date.now();
  const pending = loadPendingCreateKeys(storage, now);
  const held = pending.find((entry) => entry.signature === signature);
  if (held) return { key: held.key, reused: true };
  const key = (options.mint ?? mintCreateKey)();
  save([{ key, signature, mintedAt: now }, ...pending], storage);
  return { key, reused: false };
}

/** The server answered this create: its key is let go. A key that is not held is left alone. */
export function releaseCreateKey(storage: KeyStorage | null | undefined, key: string): void {
  const pending = readAll(storage);
  const next = pending.filter((entry) => entry.key !== key);
  if (next.length !== pending.length) save(next, storage);
}

/**
 * The bot with this handle in this company was removed: every key kept for
 * a create of it is let go, whatever brain or size the draft had. A kept key
 * would otherwise be answered with the bot that is gone.
 */
export function releaseCreateKeysFor(
  storage: KeyStorage | null | undefined,
  companyUid: string,
  handle: string,
): string[] {
  const company = companyUid.trim();
  const slug = handle.trim().toLowerCase();
  if (!company || !slug) return [];
  const prefix = `${company}|${slug}|`;
  const pending = readAll(storage);
  const gone = pending.filter((entry) => entry.signature.startsWith(prefix));
  if (gone.length) save(pending.filter((entry) => !entry.signature.startsWith(prefix)), storage);
  return gone.map((entry) => entry.key);
}
