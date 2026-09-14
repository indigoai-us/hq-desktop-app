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
import { addTileTrack, clearRemoteTiles, clearTile, applyStream, setTileTracks } from './media-sinks';
import { initialCallViewState } from './bootstrap';
import { callView } from './view.svelte';
import { initialTranscript } from './live-transcript';
import { initialTranscriptSave } from './transcript-save';

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
  callView.transcript = initialTranscript();
  callView.startTranscriptionSession = null;
  callView.pauseTranscriptionSession = null;
  callView.resumeTranscriptionSession = null;
  callView.endTranscriptionSession = null;
  callView.transcriptSave = initialTranscriptSave();
  callView.showSavedTranscript = null;
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

    // One transcript-panel toggle remains; it does not request recognition consent.
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

it('resumes a paused preview when camera tracks restart in the same stream', () => {
  const video = document.createElement('video');
  const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
  setTileTracks('self', [track('camera-first', 'video')]);
  applyStream(video, 'self');
  play.mockClear();
  setTileTracks('self', []);
  setTileTracks('self', [track('camera-restarted', 'video')]);
  applyStream(video, 'self');
  expect(streamIds(video)).toEqual(['camera-restarted']);
  expect(play).toHaveBeenCalled();
});

it('opens session setup before a first transcript without changing microphone or consent', () => {
  const button=document.querySelector<HTMLButtonElement>('[data-testid="toggle-transcription"]')!;
  expect(button.getAttribute('aria-label')).toBe('Live transcript');
  button.click();flushSync();
  expect(document.querySelector('[data-testid="live-transcript-panel"]')).toBeNull();
  expect(document.querySelector<HTMLDialogElement>('.session-dialog')?.open).toBe(true);
  expect(document.body.textContent).toContain('Where should this session live?');
  expect(document.body.textContent).not.toContain('Allow transcription');
  expect(callView.state.media.microphone.active).toBe(false);
});


it('shows vault receipts for room transcripts and keeps personal notes private', () => {
  const show = vi.fn(async () => {});
  callView.showSavedTranscript = show;
  callView.transcript={...callView.transcript,session:sessionFixture()};
  callView.transcriptSave = {status:'saved',detail:'Saved to company vault',sourcePath:'sources/meetings/native-test.md'};
  document.querySelector<HTMLButtonElement>('[data-testid="toggle-transcription"]')!.click();
  flushSync();
  expect(document.querySelector('.transcript-footer')?.textContent).toContain('Saved to company vault');
  document.querySelector<HTMLButtonElement>('.show-transcript')!.click();
  expect(show).toHaveBeenCalledTimes(1);
  callView.transcript = {...callView.transcript,mode:'personal'};
  flushSync();
  expect(document.querySelector('.show-transcript')).toBeNull();
  expect(document.querySelector('.transcript-footer')?.textContent).toContain('never shared');
});


function sessionFixture(ownerPersonUid='prs_self', state:'active'|'paused'|'ended'='active') {
  return {id:'session',scope:'company' as const,ownerPersonUid,state,startedAt:1000,activeSince:state==='active'?1000:null,elapsedMs:0,pausedAt:state==='paused'?1000:null,endedAt:state==='ended'?1000:null,interval:1};
}
it.each(['personal','company'] as const)('starts the selected %s destination only on explicit submit',async scope=>{
  const start=vi.fn(async()=>{});callView.startTranscriptionSession=start;
  document.querySelector<HTMLButtonElement>('[data-testid="toggle-transcription"]')!.click();flushSync();
  document.querySelector<HTMLInputElement>(`input[name="vault-destination"][value="${scope}"]`)!.click();flushSync();
  expect(start).not.toHaveBeenCalled();expect(callView.state.media.microphone.active).toBe(false);
  document.querySelector<HTMLFormElement>('.session-dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await Promise.resolve();await Promise.resolve();await Promise.resolve();flushSync();expect(start).toHaveBeenCalledWith(scope);expect(callView.state.media.microphone.active).toBe(false);
  expect(document.querySelector('[data-testid="live-transcript-panel"]')).not.toBeNull();
});
it('offers pause and end to the session owner, then resume while paused',async()=>{
  const pause=vi.fn(async()=>{}),resume=vi.fn(async()=>{}),end=vi.fn(async()=>{});
  callView.pauseTranscriptionSession=pause;callView.resumeTranscriptionSession=resume;callView.endTranscriptionSession=end;
  callView.transcript={...callView.transcript,session:sessionFixture()};flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid="toggle-transcription"]')!.click();flushSync();
  document.querySelector<HTMLButtonElement>('.session-actions button')!.click();await Promise.resolve();await Promise.resolve();await Promise.resolve();flushSync();expect(pause).toHaveBeenCalledOnce();
  callView.transcript={...callView.transcript,session:sessionFixture('prs_self','paused')};flushSync();
  expect(document.querySelector('.session-actions button')?.textContent).toContain('Resume');
  document.querySelector<HTMLButtonElement>('.session-actions button')!.click();await Promise.resolve();await Promise.resolve();await Promise.resolve();flushSync();expect(resume).toHaveBeenCalledOnce();
  document.querySelector<HTMLButtonElement>('.end-session')!.click();await Promise.resolve();await Promise.resolve();await Promise.resolve();flushSync();expect(end).toHaveBeenCalledOnce();
});
it('does not expose owner controls to another participant',()=>{
  callView.transcript={...callView.transcript,session:sessionFixture('prs_alice')};flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid="toggle-transcription"]')!.click();flushSync();
  expect(document.querySelector('.session-actions')).toBeNull();expect(document.querySelector('.session-strip')?.textContent).toContain('only they can pause or end');
});

it('has no Copy Text control or copy recovery instruction',()=>{
 callView.transcript={...initialTranscript(),mode:'personal',session:{id:'personal-test',scope:'personal',ownerPersonUid:'prs_alice',state:'ended',startedAt:1,activeSince:null,elapsedMs:1,pausedAt:null,endedAt:2,interval:1}};
 flushSync();document.querySelector<HTMLButtonElement>('[data-testid="toggle-transcription"]')!.click();flushSync();
 expect(document.querySelector('.copy-transcript')).toBeNull();
 expect(document.body.textContent).not.toMatch(/copy text|copy the text/i);
});
