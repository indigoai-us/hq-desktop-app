import { initialTranscriptSave, type TranscriptSaveState } from "./transcript-save";
/**
 * The call window's tiny reactive view model. Lives in a `.svelte.ts` module so
 * both the entry (`main.ts`) and the shell (`CallShell.svelte`) share one rune
 * state object without threading props through a hand-rolled mount adapter.
 *
 * View state: company-scoped display names, a status, a refusal code, a peer count, the
 * remote tracks and one `MediaStream` per gallery tile. No SDP, no candidates,
 * no keys, no conversation content.
 */

import { initialTranscript, type LiveTranscriptState } from './live-transcript';
import type { TrackLike } from '@hq/meet-core';
import { initialCallViewState } from './bootstrap';
import type { CallViewState, CallWindowHandle } from './bootstrap';

export const callView = $state<{
  state: CallViewState;
  personalSave: TranscriptSaveState;
  retryPersonalSave: (()=>Promise<void>)|null;
  showPersonalTranscript: (()=>Promise<void>)|null;
  transcriptSave: TranscriptSaveState;
  showSavedTranscript: (()=>Promise<void>)|null;
  transcript: LiveTranscriptState;
  startTranscriptionSession: ((scope:'personal'|'company')=>Promise<void>)|null;
  pauseTranscriptionSession: (()=>Promise<void>)|null;
  resumeTranscriptionSession: (()=>Promise<void>)|null;
  endTranscriptionSession: (()=>Promise<void>)|null;
  names: Record<string,string>;
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
  personalSave: {...initialTranscriptSave(),detail:'Personal notes save automatically on this device'},
  retryPersonalSave: null,
  showPersonalTranscript: null,
  transcriptSave: initialTranscriptSave(),
  showSavedTranscript: null,
  transcript: initialTranscript(),
  startTranscriptionSession: null,
  pauseTranscriptionSession: null,
  resumeTranscriptionSession: null,
  endTranscriptionSession: null,
  names: {},
  handle: null,
  remoteTracks: [],
  streams: {},
});
