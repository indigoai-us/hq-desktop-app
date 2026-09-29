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
 *   3. As a last-resort fallback, `fromPersonUid` starting with `bot_`,
 *      `agent_`, `agt_`, or `sys_` is non-human, but only when `audience`
 *      is unspecified. A bot's reply to a DM/thread a human started with
 *      that bot (audience "both") is KEPT.
 *
 * Work-mesh rows detected by the conversation view via
 * `parseWorkSessionEvent` are always non-human — the view hides those
 * separately when the flag is on.
 */

const HUMAN_AUDIENCES = new Set(["human", "both"]);
const NON_HUMAN_UID_PREFIXES = ["bot_", "agent_", "agt_", "sys_"];

export interface HumanClassifiable {
  audience?: string | null;
  isSystemEvent?: boolean | null;
  isMeshEvent?: boolean | null;
  fromPersonUid?: string | null;
}

/** True when this message renders for a human-only viewer. */
export function isHumanMessage(msg: HumanClassifiable): boolean {
  if (msg.isSystemEvent === true) return false;
  if (msg.isMeshEvent === true) return false;
  const audience = msg.audience ?? null;
  if (audience !== null && !HUMAN_AUDIENCES.has(audience)) return false;
  if (audience === null) {
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
   * Server-provided timestamp of the last HUMAN message on this row. Absent
   * on older servers → the caller falls back to `lastActivityAt`.
   */
  lastHumanMessageAt?: string | number | null;
}

function toStamp(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Return the recency key (epoch-ms, 0 when unknown) the sidebar should sort
 * by. In humanOnly mode, prefer `lastHumanMessageAt`; when the server has
 * not sent one, fall back to `lastActivityAt` / `lastMessageAt` so a channel
 * with no known human timestamp does not silently drop below every other
 * row on hosts that have not yet started shipping the field.
 */
export function humanRecencyKey<T extends HumanRecencyChannel>(
  row: T,
  humanOnly: boolean,
): number {
  if (humanOnly) {
    const human = toStamp(row.lastHumanMessageAt);
    if (human > 0) return human;
  }
  const activity = toStamp(row.lastActivityAt);
  if (activity > 0) return activity;
  return toStamp(row.lastMessageAt);
}

/**
 * Sort channels descending by the appropriate recency key. Stable: rows with
 * equal keys keep their relative order.
 */
export function orderChannelsForViewer<T extends HumanRecencyChannel>(
  channels: readonly T[],
  humanOnly: boolean,
): T[] {
  const paired = channels.map((row, index) => ({
    row,
    index,
    key: humanRecencyKey(row, humanOnly),
  }));
  paired.sort((a, b) => {
    if (b.key !== a.key) return b.key - a.key;
    return a.index - b.index;
  });
  return paired.map((p) => p.row);
}
