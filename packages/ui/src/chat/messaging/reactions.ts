/**
 * Pure helpers + types for the emoji-reactions UI (ported verbatim from the
 * hq-sync desktop source `src/lib/reactions.ts`, US-025).
 *
 * ReactionBar / EmojiPicker render reaction pills under every message bubble in
 * the shared <ChannelConversation/>. The aggregate shape, optimistic toggle,
 * and reconcile helpers live here so they stay unit-testable without a DOM.
 * platform-pure: no invoke / no fetch here — the host owns the toggle call.
 */

/** One reactor's identity, when the server supplies it. */
export interface Reactor {
  personUid: string;
  displayName: string;
}

/** One emoji's aggregate on a single message. */
export interface ReactionAggregate {
  emoji: string;
  count: number;
  /** True when the signed-in caller is one of the reactors (drives the
   * highlighted pill + toggle direction). */
  reactedByMe: boolean;
  /** Who reacted with this emoji, when the server provides it (Slack-style
   * hover). Absent/empty on older servers — the pill falls back to the count. */
  reactors?: Reactor[];
}

/** Map of messageId → its reaction aggregates. */
export type ReactionMap = Record<string, ReactionAggregate[]>;

/** Curated emoji set for the picker. Kept intentionally small (~24) and inline
 * so we never pull a multi-MB emoji-data dependency. Ordered by rough frequency
 * of use. */
export const CURATED_EMOJI: readonly string[] = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "🙏",
  "🔥",
  "👀",
  "✅",
  "🚀",
  "💯",
  "😄",
  "😍",
  "🤔",
  "😢",
  "😮",
  "👏",
  "🙌",
  "💪",
  "👌",
  "🤝",
  "💡",
  "⭐",
  "❓",
  "👎",
] as const;

/** Find an emoji's aggregate within a message's list (undefined if absent). */
export function findAggregate(
  list: ReactionAggregate[] | undefined,
  emoji: string,
): ReactionAggregate | undefined {
  return (list ?? []).find((r) => r.emoji === emoji);
}

/** True when the caller has already reacted with `emoji` on this message. */
export function hasReacted(
  list: ReactionAggregate[] | undefined,
  emoji: string,
): boolean {
  return !!findAggregate(list, emoji)?.reactedByMe;
}

/**
 * Apply the caller's optimistic toggle of `emoji` on a message's aggregates,
 * returning a NEW list (never mutates the input).
 */
export function toggleReaction(
  list: ReactionAggregate[] | undefined,
  emoji: string,
): ReactionAggregate[] {
  const current = list ?? [];
  const existing = findAggregate(current, emoji);

  if (!existing) {
    return [...current, { emoji, count: 1, reactedByMe: true }];
  }

  if (existing.reactedByMe) {
    const nextCount = existing.count - 1;
    if (nextCount <= 0) {
      return current.filter((r) => r.emoji !== emoji);
    }
    return current.map((r) =>
      r.emoji === emoji ? { ...r, count: nextCount, reactedByMe: false } : r,
    );
  }

  return current.map((r) =>
    r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r,
  );
}

/** Sort aggregates for stable display: highest count first, then emoji order. */
export function sortAggregates(list: ReactionAggregate[]): ReactionAggregate[] {
  return [...list].sort(
    (a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji),
  );
}

/** Build the `messageScope` string for a DM conversation. */
export function dmMessageScope(peerPersonUid: string): string {
  return `dm:${peerPersonUid.trim()}`;
}

/** Build the `messageScope` string for a channel. */
export function channelMessageScope(channelId: string): string {
  return `chan:${channelId.trim()}`;
}

/** Persist scope for the open conversation (`dm:<uid>` or `chan:<id>`). */
export function messageScopeForRow(
  row:
    | {
        kind?: string;
        personUid?: string | null;
        channelId?: string | null;
      }
    | null
    | undefined,
): string {
  if (!row) return "";
  const personUid = row.personUid?.trim() ?? "";
  if (row.kind === "dm" && personUid) return dmMessageScope(personUid);
  const channelId = row.channelId?.trim() ?? "";
  return channelId ? channelMessageScope(channelId) : "";
}

/** True when the next persist should POST (add) rather than DELETE. */
export function toggleIsAdd(
  list: ReactionAggregate[] | undefined,
  emoji: string,
): boolean {
  return !hasReacted(list, emoji);
}

/** Unwrap GET /v1/notify/reactions — envelope or bare array. */
export function reactionsFromPayload(raw: unknown): ReactionAggregate[] {
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { reactions?: unknown }).reactions)
      ? (raw as { reactions: unknown[] }).reactions
      : [];
  const out: ReactionAggregate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const emoji = typeof rec.emoji === "string" ? rec.emoji.trim() : "";
    if (!emoji) continue;
    const reactors: Reactor[] = Array.isArray(rec.reactors)
      ? rec.reactors
          .map((r): Reactor | null => {
            if (!r || typeof r !== "object") return null;
            const rr = r as Record<string, unknown>;
            const personUid =
              typeof rr.personUid === "string" ? rr.personUid.trim() : "";
            if (!personUid) return null;
            const displayName =
              typeof rr.displayName === "string" && rr.displayName.trim()
                ? rr.displayName.trim()
                : personUid;
            return { personUid, displayName };
          })
          .filter((r): r is Reactor => r !== null)
      : [];
    out.push({
      emoji,
      count: typeof rec.count === "number" ? rec.count : 0,
      reactedByMe: Boolean(rec.reactedByMe ?? rec.reacted_by_me),
      ...(reactors.length > 0 ? { reactors } : {}),
    });
  }
  return out;
}

/** Build a reaction map from cached message rows (instant paint). */
export function reactionMapFromMessages(
  messages: ReadonlyArray<{
    eventId?: string;
    reactions?: ReactionAggregate[] | null;
  }>,
): ReactionMap {
  const out: ReactionMap = {};
  for (const message of messages) {
    const id = message.eventId?.trim() ?? "";
    if (!id || !message.reactions?.length) continue;
    out[id] = message.reactions;
  }
  return out;
}

/** Set/replace one message's aggregates in a reaction map, returning a NEW map.
 *  Empty lists stay as an explicit key so a later `{ ...cached, ...live }`
 *  merge can unreact — deleting the key lets cached aggregates win. */
export function setMessageReactions(
  map: ReactionMap,
  messageId: string,
  reactions: ReactionAggregate[],
): ReactionMap {
  return { ...map, [messageId]: reactions };
}

/** Overlay live toggles onto a cached map. Empty live lists win (unreact). */
export function mergeReactionMaps(
  cached: ReactionMap,
  live: ReactionMap,
): ReactionMap {
  return { ...cached, ...live };
}
