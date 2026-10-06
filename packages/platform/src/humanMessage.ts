/**
 * Shared classifier + sidebar-order helpers for the
 * `desktop.human-only-conversations` flag (see `flags.ts`).
 *
 * Classification rule (documented, ordered):
 *   1. If the message carries an explicit `isSystemEvent` or `isMeshEvent`
 *      flag, it wins over `audience` (mesh/system rows are non-human by
 *      definition).
 *   2. Otherwise `audience` decides: `null` / `undefined` / `"human"` /
 *      `"both"` are human; `"bot"` / `"mesh"` / anything else is not.
 *   3. As a last-resort fallback, legacy `bot_`, `agent_`, or `sys_` senders
 *      are non-human, but only when `audience`
 *      is unspecified. A bot's reply to a DM/thread a human started with
 *      that bot (audience "both") is KEPT.
 *
 * Callers can pass `{ inferFromUid: false }` to skip rule 3. The desktop
 * timeline does this: an agent message with no audience tag is usually a
 * reply to a person (bot DMs, the Setup channel), so only explicit signals
 * hide it there.
 *
 * Work-mesh rows detected by the conversation view via
 * `parseWorkSessionEvent` are always non-human — the view hides those
 * separately when the flag is on.
 */

const HUMAN_AUDIENCES = new Set(["human", "both"]);
const NON_HUMAN_UID_PREFIXES = ["bot_", "agent_", "sys_"];

export interface HumanClassifiable {
  audience?: string | null;
  isSystemEvent?: boolean | null;
  isMeshEvent?: boolean | null;
  fromPersonUid?: string | null;
}

/** True when this message renders for a human-only viewer. */
export interface HumanClassifyOptions {
  /** Apply rule 3 (uid-prefix fallback). Default true. */
  inferFromUid?: boolean;
}

export function isHumanMessage(
  msg: HumanClassifiable,
  options: HumanClassifyOptions = {},
): boolean {
  if (msg.isSystemEvent === true) return false;
  if (msg.isMeshEvent === true) return false;
  const audience = msg.audience ?? null;
  if (audience !== null && !HUMAN_AUDIENCES.has(audience)) return false;
  if (audience === null && options.inferFromUid !== false) {
    const uid = (msg.fromPersonUid ?? "").toLowerCase();
    if (uid && NON_HUMAN_UID_PREFIXES.some((p) => uid.startsWith(p))) {
      return false;
    }
  }
  return true;
}

/** Filter a message list to just the human-visible rows. */
export function filterHumanMessages<T extends HumanClassifiable>(
  items: readonly T[],
): T[] {
  return items.filter((m) => isHumanMessage(m));
}

// ─── Sidebar ordering ──────────────────────────────────────────────────────

export interface HumanRecencyChannel {
  /** ISO or epoch-ms; `null` / `undefined` treated as "no activity". */
  lastActivityAt?: string | number | null;
  lastMessageAt?: string | number | null;
  /**
   * Server-provided timestamp of the last HUMAN message on this row. Present
   * only when the server knows it.
   */
  lastHumanMessageAt?: string | number | null;
  /**
   * `false` only when the server knows the conversation holds no human
   * message. The server never sends `true`. Absent means unknown (an older
   * server, or a conversation the server has not examined yet) and must not
   * be read as "none".
   */
  hasHumanMessage?: boolean | null;
  /**
   * Creation time. The recency key of a row known to hold no human message,
   * on the same timeline as human times. A known-none row without one is
   * placed by its activity instead.
   */
  createdAt?: string | number | null;
}

/**
 * What is known about the last human message of a conversation.
 *
 *  - `known`: the server sent `lastHumanMessageAt`.
 *  - `none`: the server sent `hasHumanMessage: false`.
 *  - `unknown`: the server sent neither field.
 */
export type HumanRecencyState = "known" | "none" | "unknown";

function toStamp(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/** Classify a row into one of the three human-recency states. */
export function humanRecencyState(row: HumanRecencyChannel): HumanRecencyState {
  if (toStamp(row.lastHumanMessageAt) > 0) return "known";
  if (row.hasHumanMessage === false) return "none";
  return "unknown";
}

/**
 * Return the recency key (epoch-ms, 0 when there is none) the sidebar should
 * sort by and section by.
 *
 * In `humanOnly` mode there are three states (see `humanRecencyState`):
 *
 *  - `known`: the key is `lastHumanMessageAt`.
 *  - `none` with a creation time: the key is the creation time, on the same
 *    timeline as human times. A conversation created today sits where
 *    "today" puts it, and one created a month ago that only bots post in
 *    sits a month back. Bot and session activity never moves such a row.
 *  - `none` without a creation time: the key is `lastActivityAt` /
 *    `lastMessageAt`, exactly like an unknown row. Today that is every 1:1
 *    DM, because the DM thread listing carries no creation time. A new
 *    teammate's DM on the day they join, or an agent's first DM, must be
 *    visible under Today and not buried in a collapsed older section. This
 *    is an interim rule (owner decision, 2026-10-02) until the server
 *    supplies a creation time for DM rows. With no activity time either,
 *    the key is 0 and `compareHumanRecency` places the row below every
 *    other.
 *  - `unknown`: the key falls back to `lastActivityAt` / `lastMessageAt`.
 *    An older server sends no human fields at all, and a current server
 *    sends none for a conversation it has not examined, so treating absent
 *    as "none" would sink those rows to the bottom in title order.
 *
 * In non-humanOnly mode the key is `lastActivityAt` / `lastMessageAt`.
 */
export function humanRecencyKey<T extends HumanRecencyChannel>(
  row: T,
  humanOnly: boolean,
): number {
  if (humanOnly) {
    const state = humanRecencyState(row);
    if (state === "known") return toStamp(row.lastHumanMessageAt);
    if (state === "none") {
      const created = toStamp(row.createdAt);
      if (created > 0) return created;
      // No creation time: placed like an unknown row, below.
    }
  }
  const activity = toStamp(row.lastActivityAt);
  if (activity > 0) return activity;
  return toStamp(row.lastMessageAt);
}

/**
 * True for a row that has no place on the timeline in `humanOnly` mode: it
 * is known to hold no human message and carries neither a creation time nor
 * an activity time. Such rows form the bottom tier. A known-none row that
 * has an activity time is not in it (see `humanRecencyKey`).
 */
export function isUndatedNoHumanRow(
  row: HumanRecencyChannel,
  humanOnly: boolean,
): boolean {
  return (
    humanOnly &&
    humanRecencyState(row) === "none" &&
    toStamp(row.createdAt) <= 0 &&
    toStamp(row.lastActivityAt) <= 0 &&
    toStamp(row.lastMessageAt) <= 0
  );
}

/**
 * Comparator for sidebar order: negative when `a` sorts before `b`, 0 when
 * the two rows tie (the caller applies its own tie-break).
 *
 * Rows are ordered by `humanRecencyKey`, newest first. In `humanOnly` mode a
 * row known to hold no human message that has neither a creation time nor
 * an activity time sorts below every other row; such rows tie among
 * themselves, which leaves them in the caller's tie-break order (title).
 */
export function compareHumanRecency(
  a: HumanRecencyChannel,
  b: HumanRecencyChannel,
  humanOnly: boolean,
): number {
  const aBottom = isUndatedNoHumanRow(a, humanOnly);
  const bBottom = isUndatedNoHumanRow(b, humanOnly);
  if (aBottom !== bBottom) return aBottom ? 1 : -1;
  if (aBottom && bBottom) return 0;
  return humanRecencyKey(b, humanOnly) - humanRecencyKey(a, humanOnly);
}

/**
 * Sort channels with `compareHumanRecency`. Stable: rows that tie keep their
 * relative order.
 */
export function orderChannelsForViewer<T extends HumanRecencyChannel>(
  channels: readonly T[],
  humanOnly: boolean,
): T[] {
  const paired = channels.map((row, index) => ({ row, index }));
  paired.sort((a, b) => {
    const diff = compareHumanRecency(a.row, b.row, humanOnly);
    if (diff !== 0) return diff;
    return a.index - b.index;
  });
  return paired.map((p) => p.row);
}
