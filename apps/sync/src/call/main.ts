/**
 * Call-window entry (US-016). Mounted by `call.html`, built as its own Vite
 * rollup input so the call never shares a document — or a lifetime — with the
 * main Desktop view.
 *
 * The target is never read from the URL or the query string; it comes from the
 * native host through `calls_take_pending_target` / the window-scoped
 * `calls:target` event. See `bootstrap.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';

import CallShell from './CallShell.svelte';
import { safeUnlisten } from '../lib/listener-registry';
import { handleCloseRequested, startCallWindow, type CallWindowHandle } from './bootstrap';
import { windowPreferenceStorage } from './permissions';
import { browserMediaDevices, createAnalyserSpeakingPort } from './speaking';
import {
  addTileTrack,
  clearRemoteTiles,
  clearTile,
  removeTileTrack,
} from './media-sinks';
import { callView } from './view.svelte';
import type { TrackLike } from '@hq/meet-core';

const target = document.getElementById('call');
if (!target) {
  throw new Error('Missing call mount target');
}

let handle: CallWindowHandle | null = null;
/** Track ids rendered for each peer, so a removal drops exactly that peer. */
const peerTracks = new Map<string, Set<string>>();

/**
 * Leaving closes the window through the SAME door as the OS close button:
 * `close()` raises `onCloseRequested`, so teardown (leave, release, destroy)
 * has exactly one implementation and cannot drift between the two paths.
 */
mount(CallShell, {
  target,
  props: { onclose: () => void getCurrentWindow().close() },
});

const started = startCallWindow({
  invoke: (command, args) => invoke(command, args),
  listen: async (event, handler) => {
    // Every Tauri handle this window registers goes out through the shared
    // throw-safe boundary (HQ-DESKTOP-39), including one that resolves after
    // the window already tore down.
    const off = await listen(event, (payload) => handler({ payload: payload.payload }));
    return safeUnlisten(off);
  },
  // Remembered join *intent* only (muted / camera off). The call target never
  // comes from web storage — see `bootstrap.ts`.
  storage: windowPreferenceStorage(),
  // The audio-level heuristic and the device pickers. Both are reads: neither
  // opens a device, so neither can light the capture indicator (US-017).
  speaking: createAnalyserSpeakingPort(),
  mediaDevices: browserMediaDevices(),
  onState: (state) => {
    callView.state = state;
  },
  onTrack: (track, peerId) => {
    callView.remoteTracks = [...callView.remoteTracks, track];
    const owned = peerTracks.get(peerId) ?? new Set<string>();
    owned.add(track.id);
    peerTracks.set(peerId, owned);
    // `peerId` IS the gallery tile id (`personUid deviceId`), so the track goes
    // straight to that peer's tile. Audio rides the same stream as the video:
    // a remote tile's `<video>` is not muted, and a media element keeps playing
    // audio while its box is visually hidden, so a camera-off peer is still
    // heard.
    attachRemote(peerId, track);
  },
  // A peer removed from the authoritative roster, or a traffic stop, closes
  // content delivery. Drop the rendered media immediately rather than waiting
  // for the track to end on its own.
  onContentClose: ({ peerId }) => {
    if (peerId === null) {
      detachAllRemote();
      return;
    }
    detachRemoteForPeer(peerId);
  },
})
  .then((ready) => {
    handle = ready;
    callView.handle = ready;
    return ready;
  })
  .catch((error) => {
    callView.state = { ...callView.state, status: 'error', code: 'CALL_BOOTSTRAP_FAILED' };
    throw error;
  });

/**
 * Closing the call window means leaving the call: the session releases the
 * tracks and peer connections it owns (camera + microphone stop), the registry
 * entry is cleared, and only then does the close proceed.
 *
 * Crucially this never early-returns while the bootstrap is still in flight —
 * see `handleCloseRequested`. Closing before the handle exists used to close
 * the window with the Rust registry still armed, which refused every later open
 * with CALL_ACTIVE until the app restarted.
 */
void getCurrentWindow().onCloseRequested(async (event) => {
  await handleCloseRequested({
    handle: () => handle,
    started,
    // Published by the bootstrap as soon as the target resolves — that is,
    // well before the handle exists.
    sessionId: () => callView.state.sessionId,
    invoke: (command, args) => invoke(command, args),
    preventDefault: () => event.preventDefault(),
    destroy: () => getCurrentWindow().destroy(),
  });
});

/**
 * Attach a remote track to its peer's gallery tile.
 *
 * There is no hidden sink any more: the tile's own `<video>` is the element the
 * stream lands on, so what the engine delivers and what the user sees are the
 * same thing. Ended tracks are pruned from the stream and from the view model,
 * so renegotiation and reconnect replace tracks rather than piling stale ones
 * up across session generations.
 */
function attachRemote(peerId: string, track: TrackLike): void {
  const media = track as unknown as MediaStreamTrack;
  addTileTrack(peerId, media);
  media.addEventListener('ended', () => {
    // The stream drops it on the next publish (`addTileTrack` prunes ended
    // tracks); the view model must not keep counting it either.
    removeTileTrack(peerId, media);
    callView.remoteTracks = callView.remoteTracks.filter((entry) => entry !== track);
    peerTracks.get(peerId)?.delete(media.id);
  });
}

/** Drop every rendered remote track. Used when the whole call closes. */
function detachAllRemote(): void {
  clearRemoteTiles();
  callView.remoteTracks = [];
  peerTracks.clear();
}

/**
 * Drop the media rendered for one peer. The engine has already closed that
 * peer's transport; this closes what the window put on screen, on the same
 * authoritative event rather than on a timer.
 */
function detachRemoteForPeer(peerId: string): void {
  const owned = peerTracks.get(peerId);
  if (!owned) return;
  peerTracks.delete(peerId);
  clearTile(peerId);
  callView.remoteTracks = callView.remoteTracks.filter(
    (entry) => !owned.has(entry.id),
  );
}

export default started;
