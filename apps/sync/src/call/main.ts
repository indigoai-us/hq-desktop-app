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
import { callView } from './view.svelte';
import type { TrackLike } from '@hq/meet-core';

const target = document.getElementById('call');
if (!target) {
  throw new Error('Missing call mount target');
}

let handle: CallWindowHandle | null = null;
/** Track ids rendered for each peer, so a removal drops exactly that peer. */
const peerTracks = new Map<string, Set<string>>();

mount(CallShell, { target });

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
  onState: (state) => {
    callView.state = state;
  },
  onTrack: (track, peerId) => {
    callView.remoteTracks = [...callView.remoteTracks, track];
    const owned = peerTracks.get(peerId) ?? new Set<string>();
    owned.add(track.id);
    peerTracks.set(peerId, owned);
    attachRemote(track);
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
 * Attach a remote track for rendering. Ended tracks are pruned from both the
 * element's stream and the view model, so renegotiation and reconnect replace
 * tracks rather than piling stale ones up across session generations.
 */
function attachRemote(track: TrackLike): void {
  const media = track as unknown as MediaStreamTrack;
  const selector = media.kind === 'audio' ? 'audio' : 'video.remote';
  const element = document.querySelector<HTMLMediaElement>(selector);
  if (!element) return;
  const existing = element.srcObject as MediaStream | null;
  const stream = existing ?? new MediaStream();
  for (const stale of stream.getTracks()) {
    if (stale.readyState === 'ended') stream.removeTrack(stale);
  }
  stream.addTrack(media);
  element.srcObject = stream;
  media.addEventListener('ended', () => {
    stream.removeTrack(media);
    callView.remoteTracks = callView.remoteTracks.filter((entry) => entry !== track);
  });
}

/** Drop every rendered remote track. Used when the whole call closes. */
function detachAllRemote(): void {
  for (const selector of ['audio', 'video.remote'] as const) {
    const element = document.querySelector<HTMLMediaElement>(selector);
    const stream = element?.srcObject as MediaStream | null;
    if (!element || !stream) continue;
    for (const track of stream.getTracks()) stream.removeTrack(track);
    element.srcObject = null;
  }
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
  for (const selector of ['audio', 'video.remote'] as const) {
    const element = document.querySelector<HTMLMediaElement>(selector);
    const stream = element?.srcObject as MediaStream | null;
    if (!stream) continue;
    for (const track of stream.getTracks()) {
      if (owned.has(track.id)) stream.removeTrack(track);
    }
  }
  callView.remoteTracks = callView.remoteTracks.filter(
    (entry) => !owned.has(entry.id),
  );
}

export default started;
