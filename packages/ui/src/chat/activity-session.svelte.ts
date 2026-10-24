/**
 * Per-conversation Activity state for this app session (US-006): whether the
 * column is open, which segment it shows, and the narrow-window lens. Kept in
 * memory only, keyed by conversation id, so it survives switching away and
 * back but not a restart. Never written to localStorage.
 */
import { SvelteMap } from "svelte/reactivity";
import type { ActivityLens, ActivitySegment } from "./activity-column.js";

export interface ActivityState {
  open: boolean;
  segment: ActivitySegment;
  /** Narrow-window lens; `null` follows the global message-types preference. */
  lens: ActivityLens | null;
}

const DEFAULT_STATE: Readonly<ActivityState> = Object.freeze({
  open: false,
  segment: "agents",
  lens: null,
});

const states = new SvelteMap<string, ActivityState>();

export const activitySession = {
  /** State for one conversation. Reactive inside components and `$derived`. */
  get(conversationId: string): ActivityState {
    return states.get(conversationId) ?? DEFAULT_STATE;
  },
  /** Merge a change into one conversation's state. */
  update(conversationId: string, patch: Partial<ActivityState>): void {
    states.set(conversationId, { ...this.get(conversationId), ...patch });
  },
  /** Forget everything (tests; a sign-out is a new session). */
  reset(): void {
    states.clear();
  },
};
