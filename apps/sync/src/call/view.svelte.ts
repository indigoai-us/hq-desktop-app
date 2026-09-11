/**
 * The call window's tiny reactive view model. Lives in a `.svelte.ts` module so
 * both the entry (`main.ts`) and the shell (`CallShell.svelte`) share one rune
 * state object without threading props through a hand-rolled mount adapter.
 *
 * Content-free by construction: a status, a refusal code, a peer count, the
 * remote tracks and one `MediaStream` per gallery tile. No SDP, no candidates,
 * no keys, no person content.
 */

import type { TrackLike } from '@hq/meet-core';
import { initialCallViewState } from './bootstrap';
import type { CallViewState, CallWindowHandle } from './bootstrap';

export const callView = $state<{
  state: CallViewState;
  handle: CallWindowHandle | null;
  remoteTracks: TrackLike[];
  /**
   * The media sink per gallery TILE, keyed by the tile id (`self`, or the
   * key-free `personUid deviceId` peer label). Replaced rather than mutated on
   * every change — see `media-sinks.ts` — so a track that arrives after a tile
   * mounted still reaches that tile's `<video>`.
   */
  streams: Record<string, MediaStream>;
}>({
  state: initialCallViewState(),
  handle: null,
  remoteTracks: [],
  streams: {},
});
