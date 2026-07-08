/**
 * Reactive controller for SHARE reactions, shared by every share surface
 * (ShareDetail window, the popover/desktop NotificationFeed share rows, and
 * the Messages share-timeline bubbles).
 *
 * Shares differ from DM/channel reactions in one structural way: each share is
 * its OWN one-message scope (`share:{eventId}`, messageId = eventId), so a
 * surface showing N shares watches N scopes. That means:
 *   - the map is keyed by share eventId (same key the hosts already render by);
 *   - registration goes through `set_watched_shares` (a SEPARATE managed slot
 *     from `set_active_conversation`, so watching shares never clobbers the
 *     open DM/channel conversation and vice versa);
 *   - `applyEvent` matches any `share:` scope whose messageId is a watched id,
 *     rather than one fixed scope.
 *
 * Everything else mirrors `ReactionController`: optimistic toggle with
 * rollback, authoritative reconcile from the `message:reaction` Tauri event,
 * pure helpers from `reactions.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  type ReactionAggregate,
  type ReactionEvent,
  type ReactionMap,
  buildReactionMap,
  isShareScope,
  setMessageReactions,
  shareScope,
  sortAggregates,
  toggleIsAdd,
  toggleReaction as toggleAggregates,
} from './reactions';

export class ShareReactionController {
  /** share eventId → sorted aggregates. */
  map = $state<ReactionMap>({});

  /** The share eventIds currently registered as watched. */
  private eventIds: string[] = [];
  /**
   * Whether `dispose()` clears the Rust watched-shares slot. The primary share
   * surface (the one whose lifetime owns the registration) clears on teardown;
   * a short-lived secondary host can pass `false`.
   */
  private clearOnDispose: boolean;

  constructor(clearOnDispose = true) {
    this.clearOnDispose = clearOnDispose;
  }

  /**
   * Declare the visible share eventIds. Registers them with the SINGLE Rust
   * poll path (`set_watched_shares`) so a realtime "reaction" wake re-fetches
   * + emits, then loads each share's current aggregates (best-effort).
   */
  async setShares(eventIds: string[]): Promise<void> {
    const ids = eventIds.map((s) => s.trim()).filter(Boolean);
    // No-op when the watched set is unchanged — hosts call this from reactive
    // effects that re-run on unrelated state changes.
    if (ids.length === this.eventIds.length && ids.every((id, i) => id === this.eventIds[i])) {
      return;
    }
    this.eventIds = ids;

    try {
      await invoke('set_watched_shares', { eventIds: ids });
    } catch (err) {
      console.error('share-reactions: set_watched_shares failed', err);
    }

    try {
      const rows = await Promise.all(
        ids.map(async (eventId) => {
          try {
            const reactions = await invoke<ReactionAggregate[]>('fetch_reactions', {
              messageScope: shareScope(eventId),
              messageId: eventId,
            });
            return { messageId: eventId, reactions: reactions ?? [] };
          } catch (err) {
            console.error('share-reactions: fetch_reactions failed', eventId, err);
            return { messageId: eventId, reactions: [] as ReactionAggregate[] };
          }
        }),
      );
      this.map = buildReactionMap(rows);
    } catch (err) {
      console.error('share-reactions: initial load failed', err);
    }
  }

  /**
   * Optimistically toggle the caller's `emoji` reaction on a share, then
   * persist via `toggle_reaction` with the share's own scope. Rolls back on
   * failure; the `message:reaction` event reconciles either way.
   */
  toggle = (eventId: string, emoji: string): void => {
    const before = this.map[eventId];
    const add = toggleIsAdd(before, emoji);
    this.map = setMessageReactions(this.map, eventId, toggleAggregates(before, emoji));

    void invoke('toggle_reaction', {
      messageScope: shareScope(eventId),
      messageId: eventId,
      emoji,
      add,
    }).catch((err) => {
      console.error('share-reactions: toggle_reaction failed', err);
      this.map = setMessageReactions(this.map, eventId, before ?? []);
    });
  };

  /**
   * Apply a `message:reaction` Tauri event payload. Only `share:` scopes whose
   * messageId is a watched share are applied — DM/channel events (and shares
   * some other surface watches) are ignored.
   */
  applyEvent = (event: ReactionEvent): void => {
    if (!isShareScope(event.messageScope)) return;
    if (!this.eventIds.includes(event.messageId)) return;
    this.map = setMessageReactions(
      this.map,
      event.messageId,
      sortAggregates(event.reactions ?? []),
    );
  };

  /** Clear the watched shares on the Rust side (host teardown / close). */
  dispose(): void {
    if (!this.clearOnDispose) return;
    void invoke('set_watched_shares', { eventIds: [] }).catch(() => {
      /* best-effort */
    });
  }
}
