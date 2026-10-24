/**
 * Activity column (hq-message-visibility US-006).
 *
 * A conversation's agent and system messages in their own column beside the
 * people thread. Pure helpers only: the hidden count for the header pill, the
 * rows one segment of the column shows, and the narrow-window lens that
 * replaces the column below {@link ACTIVITY_COLUMN_MIN_PX}. The per-session
 * state (open / closed, segment, lens) lives in `activity-session.svelte.ts`.
 */
import type { MessageType } from "@hq/platform";
import { isMessageTypeVisible, type MessageTypesPref } from "./message-types.js";

/** Below this window width the header offers the lens menu, not a column. */
export const ACTIVITY_COLUMN_MIN_PX = 1000;
/** `matchMedia` query that is true when the column does not fit. */
export const ACTIVITY_NARROW_QUERY = `(max-width: ${ACTIVITY_COLUMN_MIN_PX - 1}px)`;

/** The column's two-segment switch. */
export type ActivitySegment = "agents" | "system";
export const ACTIVITY_SEGMENTS: ReadonlyArray<{ id: ActivitySegment; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "system", label: "System" },
];

/** The narrow-window header lens ("People ▾"). */
export type ActivityLens = "people" | "agents" | "system" | "all";
export const ACTIVITY_LENSES: ReadonlyArray<{ id: ActivityLens; label: string }> = [
  { id: "people", label: "People" },
  { id: "agents", label: "Agents" },
  { id: "system", label: "System" },
  { id: "all", label: "All" },
];

/** Type filter a lens choice applies to the main column. */
export function lensPrefs(lens: ActivityLens): MessageTypesPref {
  switch (lens) {
    case "agents":
      return { agents: true, system: false };
    case "system":
      return { agents: false, system: true };
    case "all":
      return { agents: true, system: true };
    default:
      return { agents: false, system: false };
  }
}

/** The lens that matches a filter (used for the menu label). */
export function lensFor(pref: MessageTypesPref | null): ActivityLens {
  if (!pref) return "all";
  if (pref.agents && pref.system) return "all";
  if (pref.agents) return "agents";
  if (pref.system) return "system";
  return "people";
}

export function lensLabel(lens: ActivityLens): string {
  return ACTIVITY_LENSES.find((l) => l.id === lens)?.label ?? "People";
}

/** Agent and system messages the main column does not show. */
export function activityHiddenCount<T>(
  messages: readonly T[],
  pref: MessageTypesPref | null,
  typeOf: (m: T) => MessageType,
): number {
  if (!pref) return 0;
  let n = 0;
  for (const m of messages) {
    const type = typeOf(m);
    if (type !== "people" && !isMessageTypeVisible(type, pref)) n += 1;
  }
  return n;
}

/** Rows one segment shows, in the order given (timeline order). */
export function activityRows<T>(
  messages: readonly T[],
  segment: ActivitySegment,
  typeOf: (m: T) => MessageType,
): T[] {
  const want: MessageType = segment === "system" ? "system" : "agent";
  return messages.filter((m) => typeOf(m) === want);
}
