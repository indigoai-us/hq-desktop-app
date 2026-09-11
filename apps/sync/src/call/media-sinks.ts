/**
 * The call window's media sinks: one `MediaStream` per gallery TILE.
 *
 * The gallery (`@hq/ui` `CallView`) is platform-pure — it never touches a
 * `MediaStream` and never learns a track id. It hands the host a `<video>` per
 * tile through `attach`, and this module is the other half: the shell keeps a
 * stream per tile id and points the attached element at it.
 *
 * Keyed by TILE id, which is exactly the engine's key-free `personUid deviceId`
 * peer label (`self` for our own tile), so an `onTrack(track, peerId)` from the
 * bootstrap lands on the right tile with no extra mapping.
 *
 * Content-free: ids and kinds only. Nothing here is logged or sent anywhere.
 */

import { callView } from './view.svelte';

/** Our own tile's id, as `deriveCallView` mints it. */
export const SELF_TILE = 'self';

/**
 * Publish a changed stream map.
 *
 * The `MediaStream` objects are mutated in place (that is the only API they
 * have), so the RECORD is replaced to make the change observable — otherwise a
 * track that arrives after a tile mounted would never reach its element.
 */
function publish(streams: Record<string, MediaStream>): void {
  callView.streams = streams;
}

function streamFor(tileId: string): MediaStream {
  const existing = callView.streams[tileId];
  if (existing) return existing;
  const stream = new MediaStream();
  publish({ ...callView.streams, [tileId]: stream });
  return stream;
}

/** Drop tracks the browser already ended, so reconnects do not pile up. */
function pruneEnded(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    if (track.readyState === 'ended') stream.removeTrack(track);
  }
}

/**
 * Route one remote track to a tile. Called from the bootstrap's
 * `onTrack(track, peerId)`, including for tracks that arrive long after the
 * tile mounted (a peer turning their camera on mid-call).
 */
export function addTileTrack(tileId: string, track: MediaStreamTrack): void {
  const stream = streamFor(tileId);
  pruneEnded(stream);
  if (!stream.getTracks().some((existing) => existing.id === track.id)) {
    stream.addTrack(track);
  }
  publish({ ...callView.streams, [tileId]: stream });
}

/**
 * Set a tile's tracks outright. Used for our OWN tile, whose tracks come from
 * the media controller rather than from a peer connection: turning the camera
 * off removes it here the moment the controller stops it.
 */
export function setTileTracks(
  tileId: string,
  tracks: readonly MediaStreamTrack[],
): void {
  const existing = callView.streams[tileId];
  if (!existing && tracks.length === 0) return;
  const wanted = new Map(tracks.map((track) => [track.id, track]));
  const stream = streamFor(tileId);
  let changed = false;
  for (const track of stream.getTracks()) {
    if (!wanted.has(track.id)) {
      stream.removeTrack(track);
      changed = true;
    } else wanted.delete(track.id);
  }
  for (const track of wanted.values()) {
    stream.addTrack(track);
    changed = true;
  }
  if (changed) publish({ ...callView.streams, [tileId]: stream });
}

/** Drop ONE track from a tile — it ended, but the peer is still here. */
export function removeTileTrack(tileId: string, track: MediaStreamTrack): void {
  const stream = callView.streams[tileId];
  if (!stream) return;
  for (const existing of stream.getTracks()) {
    if (existing.id === track.id) stream.removeTrack(existing);
  }
  publish({ ...callView.streams, [tileId]: stream });
}

/** Drop a tile's stream entirely — the peer is gone, not merely quiet. */
export function clearTile(tileId: string): void {
  const stream = callView.streams[tileId];
  if (!stream) return;
  for (const track of stream.getTracks()) stream.removeTrack(track);
  const next = { ...callView.streams };
  delete next[tileId];
  publish(next);
}

/** Drop every remote tile's stream. Our own preview is not a remote stream. */
export function clearRemoteTiles(): void {
  const next: Record<string, MediaStream> = {};
  for (const [tileId, stream] of Object.entries(callView.streams)) {
    if (tileId === SELF_TILE) {
      next[tileId] = stream;
      continue;
    }
    for (const track of stream.getTracks()) stream.removeTrack(track);
  }
  publish(next);
}

/**
 * Point a media element at a tile's stream, and start it.
 *
 * Playback is nudged explicitly because an element that gains a `srcObject`
 * after it was already in the document does not always autoplay.
 */
export function applyStream(element: HTMLMediaElement, tileId: string): void {
  const stream = callView.streams[tileId] ?? null;
  if (element.srcObject === stream) return;
  element.srcObject = stream;
  if (stream) void element.play?.()?.catch?.(() => {});
}
