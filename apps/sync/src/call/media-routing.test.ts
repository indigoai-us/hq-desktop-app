// @vitest-environment happy-dom

/**
 * The gallery is the media sink (US-020 review fix).
 *
 * The regression this pins: the call window used to hold two hidden elements
 * (`video.remote`, `video.local`) that every remote track was attached to, and
 * the gallery tiles' `<video>` elements got a `data-tile-id` and nothing else.
 * Every tile rendered a black rectangle while the media played into a 1px box
 * nobody could see.
 *
 * Asserted at the DOM level, through a real `CallShell` mount, because the bug
 * lived exactly in the wiring between the shell and `CallView`'s `attach`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';

import CallShell from './CallShell.svelte';
import { addTileTrack, clearRemoteTiles, clearTile } from './media-sinks';
import { initialCallViewState } from './bootstrap';
import { callView } from './view.svelte';

beforeAll(() => {
  // happy-dom ships a `MediaStream` class (its `srcObject` setter type-checks
  // against it) but no track list. Patch the PROTOTYPE rather than swapping the
  // global, so `instanceof` — and therefore `srcObject` — keeps working.
  const proto = MediaStream.prototype as unknown as Record<string, unknown>;
  proto.getTracks = function (this: { _tracks?: MediaStreamTrack[] }) {
    return (this._tracks ??= []);
  };
  proto.addTrack = function (
    this: { _tracks?: MediaStreamTrack[] },
    track: MediaStreamTrack,
  ) {
    (this._tracks ??= []).push(track);
  };
  proto.removeTrack = function (
    this: { _tracks?: MediaStreamTrack[] },
    track: MediaStreamTrack,
  ) {
    this._tracks = (this._tracks ?? []).filter((entry) => entry !== track);
  };
});

function track(id: string, kind: 'audio' | 'video'): MediaStreamTrack {
  return {
    id,
    kind,
    readyState: 'live',
    stop: () => {},
    addEventListener: () => {},
  } as unknown as MediaStreamTrack;
}

const ALICE = 'prs_alice dev_a';
const BOB = 'prs_bob dev_b';

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

function tileVideo(tileId: string): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(
    `[data-testid="call-tile"][data-tile-id="${tileId}"] [data-testid="call-tile-video"]`,
  );
}

function streamIds(element: HTMLVideoElement | null): string[] {
  const stream = element?.srcObject as MediaStream | null;
  return stream ? stream.getTracks().map((entry) => entry.id).sort() : [];
}

beforeEach(() => {
  callView.state = {
    ...initialCallViewState(),
    status: 'joined',
    identityResolved: true,
    roster: {
      self: { personUid: 'prs_self', deviceId: 'dev_self' },
      admitted: [
        { personUid: 'prs_self', deviceId: 'dev_self' },
        { personUid: 'prs_alice', deviceId: 'dev_a' },
        { personUid: 'prs_bob', deviceId: 'dev_b' },
      ],
      peers: [],
      rosterRevision: 1,
      trafficStopped: false,
    },
  };
  callView.handle = null;
  callView.remoteTracks = [];
  callView.streams = {};

  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(CallShell, { target: host });
  flushSync();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  callView.streams = {};
});

describe('remote media reaches the tile it belongs to', () => {
  it('lands a late track on the tile that is already on screen', () => {
    // The tile exists before any media does — that is the whole reason the
    // sink has to be reactive rather than wired once at attach time.
    const alice = tileVideo(ALICE);
    expect(alice).not.toBeNull();
    expect(alice?.srcObject ?? null).toBeNull();

    addTileTrack(ALICE, track('alice-cam', 'video'));
    flushSync();

    expect(streamIds(tileVideo(ALICE))).toEqual(['alice-cam']);

    // A second track for the same peer joins the same stream, so audio and
    // video play together rather than replacing each other.
    addTileTrack(ALICE, track('alice-mic', 'audio'));
    flushSync();
    expect(streamIds(tileVideo(ALICE))).toEqual(['alice-cam', 'alice-mic']);
  });

  it("keeps a second peer's media on that peer's own tile", () => {
    addTileTrack(ALICE, track('alice-cam', 'video'));
    addTileTrack(BOB, track('bob-cam', 'video'));
    flushSync();

    expect(streamIds(tileVideo(ALICE))).toEqual(['alice-cam']);
    expect(streamIds(tileVideo(BOB))).toEqual(['bob-cam']);
    // Crossing the streams would render one peer in both tiles.
    expect(tileVideo(ALICE)?.srcObject).not.toBe(tileVideo(BOB)?.srcObject);
  });

  it('is not rendered anywhere outside the gallery', () => {
    addTileTrack(ALICE, track('alice-cam', 'video'));
    flushSync();
    // The legacy hidden sinks are gone. Media plays where it is seen.
    expect(document.querySelector('video.remote')).toBeNull();
    expect(document.querySelector('video.local')).toBeNull();
    expect(document.querySelector('.hidden-media')).toBeNull();
  });

  it('clears srcObject when a tile tears down', async () => {
    addTileTrack(ALICE, track('alice-cam', 'video'));
    flushSync();
    const element = tileVideo(ALICE) as HTMLVideoElement;
    expect(element.srcObject).not.toBeNull();

    // The roster drops alice: her tile unmounts and the action's teardown runs.
    callView.state = {
      ...callView.state,
      roster: {
        ...callView.state.roster!,
        admitted: callView.state.roster!.admitted.filter(
          (entry) => entry.personUid !== 'prs_alice',
        ),
        rosterRevision: 2,
      },
    };
    flushSync();

    expect(tileVideo(ALICE)).toBeNull();
    expect(element.srcObject).toBeNull();
  });

  it('drops a peer stream on content close and empties every remote tile', () => {
    addTileTrack(ALICE, track('alice-cam', 'video'));
    addTileTrack(BOB, track('bob-cam', 'video'));
    flushSync();

    clearTile(ALICE);
    flushSync();
    expect(tileVideo(ALICE)?.srcObject ?? null).toBeNull();
    expect(streamIds(tileVideo(BOB))).toEqual(['bob-cam']);

    clearRemoteTiles();
    flushSync();
    expect(tileVideo(BOB)?.srcObject ?? null).toBeNull();
  });
});

describe('the shell has exactly one control surface', () => {
  it('keeps mic, camera and leave in MediaControls and nowhere else', () => {
    const ids = (id: string) =>
      document.querySelectorAll(`[data-testid="${id}"]`).length;

    // The duplicated footer controls are gone.
    expect(ids('toggle-microphone')).toBe(0);
    expect(ids('toggle-camera')).toBe(0);
    expect(ids('leave-call')).toBe(0);

    // Exactly one of each remains, in the shared control bar.
    expect(ids('control-microphone')).toBe(1);
    expect(ids('control-camera')).toBe(1);
    expect(ids('control-leave')).toBe(1);

    // The footer keeps the transcription consent + status strip.
    expect(ids('toggle-transcription')).toBe(1);
    expect(ids('call-status')).toBe(1);
  });

  it('uses one aria-pressed convention: pressed means muted / camera off', () => {
    const mic = document.querySelector('[data-testid="control-microphone"]');
    const camera = document.querySelector('[data-testid="control-camera"]');
    // Nothing is captured yet, so both are off and both read as pressed.
    expect(mic?.getAttribute('aria-pressed')).toBe('true');
    expect(mic?.textContent?.trim()).toBe('Unmute');
    expect(camera?.getAttribute('aria-pressed')).toBe('true');
    expect(camera?.textContent?.trim()).toBe('Start video');
  });
});
