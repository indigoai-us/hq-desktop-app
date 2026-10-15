/**
 * Where the first-run assistant's conversation starts on this computer.
 *
 * An account keeps one assistant. A fresh install that names it adopts the
 * account's existing assistant (hq-cli renames it), and that assistant's
 * direct message already holds the earlier install's messages. The person
 * should land in a new conversation. When the first-run takeover creates or
 * adopts the assistant, the app records the time here, keyed by the agent
 * uid, and the DM view, its unread count and its sidebar time leave out
 * every message from before it. Nothing is deleted on the server.
 *
 * Agent uids are unique across accounts, so the record is kept per device.
 */

import type { DmContactInput } from "../sidebar-model.js";
import { parseActivityMs } from "../sidebar-model.js";

export const CONVERSATION_START_KEY = "hq.first-run.conversation-start.v1";

/**
 * How far before the recorded time a message still counts as new. The time
 * is this computer's clock and messages carry the server's, so a small
 * difference between them must not hide the assistant's first message.
 */
export const CONVERSATION_START_GRACE_MS = 30_000;

/** Agent uid to the time its conversation starts (ms). */
export type ConversationStarts = Readonly<Record<string, number>>;

type StartStorage = Pick<Storage, "getItem" | "setItem">;

const NONE: ConversationStarts = Object.freeze({});

function usableTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function readConversationStarts(storage: StartStorage | null | undefined): ConversationStarts {
  if (!storage) return NONE;
  try {
    const raw: unknown = JSON.parse(storage.getItem(CONVERSATION_START_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NONE;
    const out: Record<string, number> = {};
    for (const [uid, at] of Object.entries(raw)) {
      if (uid.startsWith("agt_") && usableTime(at)) out[uid] = at;
    }
    return out;
  } catch (err) {
    console.warn("[hq-desktop] conversation start record unreadable:", err);
    return NONE;
  }
}

/** Records (or moves) the start of `agentUid`'s conversation to `at`. */
export function recordConversationStart(
  storage: StartStorage | null | undefined,
  agentUid: string,
  at: number,
): ConversationStarts {
  const uid = agentUid.trim();
  const current = readConversationStarts(storage);
  if (!uid.startsWith("agt_") || !usableTime(at)) return current;
  const next = { ...current, [uid]: at };
  try {
    storage?.setItem(CONVERSATION_START_KEY, JSON.stringify(next));
  } catch (err) {
    // Storage full or blocked: the cutoff still holds for this session.
    console.warn("[hq-desktop] conversation start not saved:", err);
  }
  return next;
}

/** The earliest message time (ms) still shown for `uid`, or null for no cutoff. */
export function conversationCutoff(starts: ConversationStarts, uid: string | null | undefined): number | null {
  const at = uid ? starts[uid] : undefined;
  return usableTime(at) ? at - CONVERSATION_START_GRACE_MS : null;
}

/** The messages from the conversation's start on. No record: unchanged. */
export function fromConversationStart<T extends { createdAt?: string | null }>(
  messages: T[],
  starts: ConversationStarts,
  uid: string | null | undefined,
): T[] {
  const cutoff = conversationCutoff(starts, uid);
  if (cutoff == null) return messages;
  // A message with no time is not server history (a send still on its way),
  // so it stays.
  const kept = messages.filter((msg) => {
    const at = parseActivityMs(msg.createdAt);
    return at === 0 || at >= cutoff;
  });
  return kept.length === messages.length ? messages : kept;
}

/**
 * DM contacts with each recorded assistant's earlier activity left out:
 * times from before its start are dropped, and with nothing after the start
 * there is nothing unread.
 */
export function contactsFromConversationStart(
  contacts: DmContactInput[],
  starts: ConversationStarts,
): DmContactInput[] {
  if (Object.keys(starts).length === 0) return contacts;
  let changed = false;
  const out = contacts.map((contact) => {
    const cutoff = conversationCutoff(starts, contact.personUid);
    if (cutoff == null) return contact;
    const keep = (at: string | null | undefined) => (parseActivityMs(at) >= cutoff ? at : null);
    const next: DmContactInput = {
      ...contact,
      lastMessageAt: keep(contact.lastMessageAt),
      lastActivityAt: keep(contact.lastActivityAt),
      lastDmAt: keep(contact.lastDmAt),
      lastHumanMessageAt: keep(contact.lastHumanMessageAt),
    };
    const anyNew = Boolean(next.lastMessageAt || next.lastActivityAt || next.lastDmAt);
    if (!anyNew) {
      next.activityDot = false;
      if (contact.unreadCount != null) next.unreadCount = 0;
    }
    changed = true;
    return next;
  });
  return changed ? out : contacts;
}
