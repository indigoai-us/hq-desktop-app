/**
 * The call window's tiny reactive view model. Lives in a `.svelte.ts` module so
 * both the entry (`main.ts`) and the shell (`CallShell.svelte`) share one rune
 * state object without threading props through a hand-rolled mount adapter.
 *
 * Content-free by construction: a status, a refusal code, a peer count and the
 * remote tracks. No SDP, no candidates, no keys, no person content.
 */

import type { TrackLike } from '@hq/meet-core';
import type { CallViewState, CallWindowHandle } from './bootstrap';

export const callView = $state<{
  state: CallViewState;
  handle: CallWindowHandle | null;
  remoteTracks: TrackLike[];
}>({
  state: { status: 'connecting', code: null, sessionId: null, peerCount: 0 },
  handle: null,
  remoteTracks: [],
});
