/**
 * Agent/bot rail visibility — "a bot is not a conversation until it messages you".
 *
 * Creating an agent mints a company-wide membership announcement (a DM from the
 * agent: "🤖 Izzy (an agent) just joined Indigo.") and, for agent channels, a
 * provisioning channel. Both land on EVERY member's rail, so a day of fleet
 * work buries a teammate's real conversations under dozens of never-used rows,
 * each carrying a "1" badge from the join notice alone.
 *
 * This module is the model-layer rule for that: an agent row belongs on the
 * rail only when it has real conversation evidence (a message in either
 * direction) or the user pinned it. It is a predicate over the conversation
 * record, never a CSS hide — hidden rows are absent from the model, so unread
 * rollups, keyboard stepping, and auto-open all agree with what is painted.
 *
 * Agents stay fully discoverable: the new-message typeahead, the palette, and
 * the @-mention picker read the contact directory (which passes
 * `includeContactsWithoutConversation`), not the rail.
 *
 * Pure — no Svelte, no DOM, no storage side effects.
 */

import { isAgentUid } from "./agent-thinking";
import type { ConversationRow } from "./sidebar-model";

/**
 * Agent uids the user has a REAL conversation with — an inbound message that
 * is not the server's join announcement, or a thread the user opened/sent in.
 *
 * Persisted because the evidence sources are windowed: the notify inbox is a
 * 50-event page and the DM thread cache fills lazily. Once an agent has proved
 * it is a conversation, it stays one across restarts instead of flickering off
 * the rail on the next cold boot.
 */
export const AGENT_ENGAGED_STORAGE_KEY = "hq.chat.agent-engaged";

/** Storage surface used by the load/save helpers (localStorage-shaped). */
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface AgentVisibilityOptions {
  /** Agent uids with proven real-message evidence. */
  engagedAgentUids?: ReadonlySet<string> | readonly string[];
  /**
   * Uids the user has recently opened or messaged (`hq.chat.recent-dms`).
   * Starting a conversation is itself evidence — outbound counts.
   */
  recentDmUids?: ReadonlySet<string> | readonly string[];
  /**
   * The user's OWN agents — local bots running on this machine, and cloud
   * bots they own. These are not company-wide broadcast clutter: the user
   * created them and needs to reach them, so they stay on the rail.
   */
  ownAgentUids?: ReadonlySet<string> | readonly string[];
  /**
   * Show every agent row regardless of evidence (typeahead / palette / people
   * search). Default false — the rail shows conversations only.
   */
  includeAgentsWithoutConversation?: boolean;
}

function toUidSet(
  value: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (!value) return new Set<string>();
  return value instanceof Set ? value : new Set(value);
}

/** True when this row is a 1:1 DM with an agent (`agt_*`). */
export function isAgentDmConversationRow(row: ConversationRow): boolean {
  return row.kind === "dm" && !!row.personUid && isAgentUid(row.personUid);
}

/**
 * True when this row is an agent CHANNEL — a channel whose roster carries an
 * `agt_*` member. Mirrors `isAgentConversationRow` in `agent-channel.ts`; kept
 * here so the visibility rule has no import cycle back through that module.
 */
export function isAgentChannelConversationRow(row: ConversationRow): boolean {
  return (
    row.kind === "channel" && !!row.members?.some((m) => isAgentUid(m.personUid))
  );
}

/** True for any row whose counterpart is an agent (DM or agent channel). */
export function isAgentConversationCandidate(row: ConversationRow): boolean {
  return isAgentDmConversationRow(row) || isAgentChannelConversationRow(row);
}

/**
 * The visibility predicate.
 *
 * Human DMs, channels without an agent member, and group DMs are never
 * touched — they return `true` here and keep whatever rule already governs
 * them upstream (`contactHasConversation` for DM stubs, always-on for
 * channels).
 *
 * For an agent row the evidence ladder is:
 *  1. pinned — an explicit user choice always wins;
 *  2. the agent uid is in `engagedAgentUids` (a real message was seen);
 *  2b. the user recently opened or messaged it (outbound counts);
 *  2c. it is one of the user's OWN agents (a local bot, or a cloud bot they
 *      own) — those are not company-wide broadcast clutter;
 *  3. for an agent CHANNEL, a durable message stamp (`row.messageActivityAt`).
 *     The directory sends `lastActivityAt: null` for a channel with no durable
 *     messages, so a positive stamp there means messages exist. `createdAt` is
 *     deliberately excluded — every freshly provisioned channel has one.
 *
 * Unread count is deliberately NOT evidence: the join announcement is itself
 * an unread DM, which is exactly the "1" badge this rule exists to remove.
 */
export function shouldShowAgentConversationRow(
  row: ConversationRow,
  options: AgentVisibilityOptions = {},
): boolean {
  if (!isAgentConversationCandidate(row)) return true;
  if (options.includeAgentsWithoutConversation) return true;
  if (row.pinned) return true;

  const engaged = toUidSet(options.engagedAgentUids);
  const recent = toUidSet(options.recentDmUids);
  const own = toUidSet(options.ownAgentUids);
  if (isAgentDmConversationRow(row)) {
    const uid = row.personUid!;
    return engaged.has(uid) || recent.has(uid) || own.has(uid);
  }

  // Agent channel: a durable MESSAGE stamp (never `createdAt`, which every
  // freshly provisioned channel carries), or an engaged member.
  if ((row.messageActivityAt ?? 0) > 0) return true;
  return !!row.members?.some(
    (m) => isAgentUid(m.personUid) && engaged.has(m.personUid),
  );
}

/** Drop every agent row that has no conversation evidence. */
export function filterAgentStubRows(
  rows: readonly ConversationRow[],
  options: AgentVisibilityOptions = {},
): ConversationRow[] {
  if (options.includeAgentsWithoutConversation) return [...rows];
  return rows.filter((row) => shouldShowAgentConversationRow(row, options));
}

// ── Engaged-agent persistence ────────────────────────────────────────────────

export function loadEngagedAgents(
  storage: StorageLike | null | undefined,
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(AGENT_ENGAGED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (uid): uid is string => typeof uid === "string" && isAgentUid(uid),
      ),
    );
  } catch {
    return new Set();
  }
}

export function saveEngagedAgents(
  uids: ReadonlySet<string> | readonly string[],
  storage: StorageLike | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      AGENT_ENGAGED_STORAGE_KEY,
      JSON.stringify([...toUidSet(uids)]),
    );
  } catch {
    /* quota / private mode — visibility degrades to per-session evidence */
  }
}

/** Add one agent uid to the engaged set (no-op for humans / blank uids). */
export function rememberEngagedAgent(
  uids: ReadonlySet<string> | readonly string[],
  personUid: string | null | undefined,
): Set<string> {
  const next = new Set(toUidSet(uids));
  const uid = (personUid ?? "").trim();
  if (uid && isAgentUid(uid)) next.add(uid);
  return next;
}

// ── Thread evidence ──────────────────────────────────────────────────────────

/** Minimal message shape the evidence check needs (matches the DM wire). */
export interface AgentThreadMessage {
  fromPersonUid?: string | null;
  fromEmail?: string | null;
  fromDisplayName?: string | null;
  body?: string | null;
  details?: string | null;
  prompt?: string | null;
}

/**
 * True when a fetched DM thread proves a real conversation: any message the
 * user sent, or any agent message that is not the membership announcement.
 *
 * Used to resolve engagement for an agent whose live `dm:new-message` wake
 * carries no body — the wake fires for the join announcement too, so the wake
 * alone can never be treated as evidence.
 */
export function threadHasRealMessage(
  messages: readonly AgentThreadMessage[],
  agentUid: string,
  isJoinNotice: (message: AgentThreadMessage) => boolean,
): boolean {
  const uid = agentUid.trim();
  for (const message of messages) {
    const from = (message.fromPersonUid ?? "").trim();
    // Anything the user (or anyone but the agent) sent is a real exchange.
    if (from !== uid) return true;
    if (!isJoinNotice(message)) return true;
  }
  return false;
}
