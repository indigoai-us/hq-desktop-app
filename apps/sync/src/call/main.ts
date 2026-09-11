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
import { startCallWindow, type CallWindowHandle } from './bootstrap';
import { callView } from './view.svelte';
import type { TrackLike } from '@hq/meet-core';

const target = document.getElementById('call');
if (!target) {
  throw new Error('Missing call mount target');
}

let handle: CallWindowHandle | null = null;

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
  onState: (state) => {
    callView.state = state;
  },
  onTrack: (track) => {
    callView.remoteTracks = [...callView.remoteTracks, track];
    attachRemote(track);
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
 */
void getCurrentWindow().onCloseRequested(async (event) => {
  if (!handle) return;
  event.preventDefault();
  await handle.leave('window-close');
  await handle.close();
  await getCurrentWindow().destroy();
});

function attachRemote(track: TrackLike): void {
  const media = track as unknown as MediaStreamTrack;
  const selector = media.kind === 'audio' ? 'audio' : 'video.remote';
  const element = document.querySelector<HTMLMediaElement>(selector);
  if (!element) return;
  const existing = element.srcObject as MediaStream | null;
  const stream = existing ?? new MediaStream();
  stream.addTrack(media);
  element.srcObject = stream;
}

export default started;
