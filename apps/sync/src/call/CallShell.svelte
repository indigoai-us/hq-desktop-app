<script lang="ts">
  /**
   * The call window's shell (US-016/017/020).
   *
   * It owns the window chrome, the identity/permission notices and the media
   * ROUTING; the gallery and the control bar are the SHARED design-system
   * components (`meet.CallView` / `meet.MediaControls`), so the call looks and
   * behaves like the rest of HQ and stays testable without a webview.
   *
   * There is exactly ONE control surface: `MediaControls`, inside the gallery.
   * The footer below it is the transcription consent + status strip and holds
   * no microphone, camera or leave control — two places to mute is two places
   * to disagree about whether you are muted.
   *
   * The microphone and camera buttons are still the ONLY path to
   * `getUserMedia`: mounting, receiving a knock, restoring a remembered
   * preference or picking a device in a picker never reaches capture.
   */
  import { untrack } from 'svelte';

  import { CallView, type CallTile } from '@hq/ui';

  import { SELF_TILE, applyStream, setTileTracks } from './media-sinks';
  import { callView } from './view.svelte';

  /**
   * Closes the call window once the leave has been asked for.
   *
   * Leaving a call and closing its window are one user action, not two: the
   * window has no content after the session ends, and `MediaControls` goes
   * inert the moment `leaving` latches, so a window left open here offers no
   * control that still works — including Leave itself.
   */
  let { onclose }: { onclose?: () => void } = $props();

  let leaving = $state(false);
  let busy = $state<'microphone' | 'camera' | 'transcription' | null>(null);

  const view = $derived(callView.state);
  const remoteTracks = $derived(callView.remoteTracks);
  const mic = $derived(view.media.microphone);
  const cam = $derived(view.media.camera);
  /**
   * Controls stay inert until this window proved whose account it is.
   *
   * `connecting` is reached BEFORE the identity gate answers, so status alone
   * would hand the microphone to a window that has not yet resolved a
   * canonical `prs_…`. `identityResolved` is the proof; authority being paused
   * (the host cannot refresh credentials) also holds them shut, because a
   * capture started there could not be authorized.
   */
  const controlsEnabled = $derived(
    view.identityResolved &&
      !view.authorityPaused &&
      (view.status === 'joined' || view.status === 'connecting'),
  );
  const denial = $derived(
    mic.recovery && (mic.status === 'denied' || mic.status === 'error')
      ? { kind: 'Microphone', recovery: mic.recovery, device: 'microphone' as const }
      : cam.recovery && (cam.status === 'denied' || cam.status === 'error')
        ? { kind: 'Camera', recovery: cam.recovery, device: 'camera' as const }
        : null,
  );
  const transcriptionLabel = $derived(
    view.transcription === 'ready'
      ? 'Transcription on'
      : view.transcription === 'paused'
        ? view.consentUnavailable
          ? 'Transcription paused · waiting for consent'
          : 'Transcription paused'
        : 'Transcription off',
  );

  const statusLabel = $derived(
    view.status === 'connecting'
      ? 'Connecting…'
      : view.status === 'identity'
        ? 'Confirm your account to join this call.'
        : view.status === 'waiting'
          ? 'Waiting for the call…'
          : view.status === 'joined'
            ? `In call · ${view.peerCount} connected`
            : view.status === 'left'
              ? 'Left the call'
              : `Call error${view.code ? ` · ${view.code}` : ''}`,
  );

  /**
   * The gallery needs SOME snapshot before the first roster lands, or the
   * window renders nothing while connecting. This one has exactly one member —
   * us — and no peers, which is the truth at that moment.
   */
  const roster = $derived(
    view.roster ?? {
      self: { personUid: 'self', deviceId: 'self' },
      admitted: [],
      peers: [],
      rosterRevision: 0,
      trafficStopped: false,
    },
  );
  const selfMedia = $derived({
    micMuted: !mic.active,
    cameraOff: !cam.active,
    speaking: view.speaking.includes('self'),
    connection:
      view.status === 'joined'
        ? ('connected' as const)
        : view.status === 'left' || view.status === 'error'
          ? ('disconnected' as const)
          : ('connecting' as const),
  });

  async function leave() {
    if (leaving) return;
    leaving = true;
    try {
      await callView.handle?.leave('leave-button');
    } catch {
      // The window closes either way. A leave that throws must not strand it.
    }
    onclose?.();
  }

  /** The explicit join control. Nothing else in this window may capture. */
  async function toggleDevice(kind: 'microphone' | 'camera', on: boolean) {
    if (busy) return;
    busy = kind;
    try {
      await callView.handle?.setDevice(kind, on);
    } finally {
      busy = null;
    }
  }

  async function retryDevice(kind: 'microphone' | 'camera') {
    if (busy) return;
    busy = kind;
    try {
      await callView.handle?.setDevice(kind, true);
    } finally {
      busy = null;
    }
  }

  async function toggleTranscription() {
    if (busy) return;
    busy = 'transcription';
    try {
      await callView.handle?.setTranscription(view.transcription === 'off');
    } finally {
      busy = null;
    }
  }

  async function retryIdentity() {
    await callView.handle?.retryIdentity();
  }

  /**
   * The REAL media sink. `CallView` hands us one `<video>` per tile and this is
   * where it is pointed at that tile's stream — there is no hidden element
   * anywhere else holding the media.
   *
   * Elements are kept in a registry (not just wired once) because tracks arrive
   * LATE: a peer whose camera comes on mid-call, or whose first track lands
   * after their roster entry did, must light up the tile that is already on
   * screen. The `$effect` below re-applies on every change to the stream map.
   */
  const sinks = new Map<HTMLMediaElement, string>();

  function attach(element: HTMLVideoElement, tile: CallTile): () => void {
    element.dataset.tileId = tile.id;
    if (tile.self) element.classList.add('local-preview');
    sinks.set(element, tile.id);
    applyStream(element, tile.id);
    return () => {
      sinks.delete(element);
      // Teardown releases the media: an element that keeps a srcObject after
      // its tile is gone is a peer still being rendered off-screen.
      element.srcObject = null;
      delete element.dataset.tileId;
    };
  }

  $effect(() => {
    // Read the map so this re-runs whenever a track lands or is dropped.
    void callView.streams;
    for (const [element, tileId] of sinks) applyStream(element, tileId);
  });

  /**
   * Our own tile shows the media CONTROLLER's local tracks, never a peer
   * connection's. It re-runs when a device goes live or off, so stopping the
   * camera empties the preview instead of freezing the last frame.
   */
  $effect(() => {
    void mic.active;
    void cam.active;
    const tracks = (callView.handle?.media?.tracks() ?? []) as MediaStreamTrack[];
    // `untrack`: publishing a stream WRITES the same map this effect would
    // otherwise read through, and an effect that reads and writes one piece of
    // state never settles.
    untrack(() => setTileTracks(SELF_TILE, tracks));
  });
</script>

<div class="call">
  <header class="titlebar" data-tauri-drag-region>
    <span class="title" data-tauri-drag-region>HQ Call</span>
  </header>

  {#if view.status === 'identity' && view.recoverable}
    <div class="notice" data-testid="call-identity-error" role="alert">
      <span>Confirm your account to join this call.</span>
      <button type="button" data-testid="call-identity-retry" onclick={retryIdentity}>Retry</button>
    </div>
  {/if}

  {#if view.authorityPaused}
    <div class="notice" data-testid="call-authority-paused" role="status">
      <span>Reconnecting to your account. The call continues; new actions are paused.</span>
    </div>
  {/if}

  {#if denial}
    <div class="notice" data-testid="call-permission-denied" role="alert">
      <span data-testid="call-permission-recovery">{denial.kind}: {denial.recovery}</span>
      <button
        type="button"
        data-testid="call-permission-retry"
        disabled={busy !== null}
        onclick={() => retryDevice(denial.device)}>Retry</button
      >
    </div>
  {/if}

  <main class="stage">
    <CallView
      snapshot={roster}
      self={selfMedia}
      role={view.role}
      hostPersonUid={view.hostPersonUid}
      cohosts={view.cohosts}
      speaking={view.speaking}
      devices={callView.handle?.mediaDevices ?? null}
      selectedMicrophoneId={view.devices.microphoneId}
      selectedCameraId={view.devices.cameraId}
      busy={busy !== null || leaving}
      controlsDisabled={!controlsEnabled}
      notice={view.notice}
      {attach}
      ontogglemicrophone={(next: boolean) => toggleDevice('microphone', next)}
      ontogglecamera={(next: boolean) => toggleDevice('camera', next)}
      onselectdevice={(kind: 'microphone' | 'camera', deviceId: string) => {
        void callView.handle?.selectDevice(kind, deviceId);
      }}
      onleave={leave}
      onendroom={() => {
        void callView.handle?.endRoom();
      }}
      onremovepeer={(tile: CallTile) => {
        void callView.handle?.removePeer(tile.personUid);
      }}
      onmuterequest={(tile: CallTile) => {
        callView.handle?.moderateMute(tile.id, false);
      }}
      onmuteforce={(tile: CallTile) => {
        callView.handle?.moderateMute(tile.id, true);
      }}
      ondismissnotice={() => callView.handle?.dismissNotice()}
    />
  </main>

  <!--
    The transcription consent + status strip. Microphone, camera and leave live
    in `MediaControls` above and NOWHERE else: a second set of toggles is a
    second source of truth about whether you are being recorded.

    `aria-pressed` follows the same convention as MediaControls — it reflects
    the state the label names, here "transcription is allowed".
  -->
  <footer class="bar">
    <button
      type="button"
      class="control"
      data-testid="toggle-transcription"
      aria-pressed={view.transcription !== 'off'}
      disabled={!controlsEnabled || busy !== null}
      onclick={toggleTranscription}>Allow transcription</button
    >
    <span class="transcription" data-testid="transcription-state">{transcriptionLabel}</span>
    <p class="status" data-testid="call-status" aria-live="polite">{statusLabel}</p>
    <span class="tracks" data-testid="remote-track-count">{remoteTracks.length}</span>
  </footer>
</div>

<style>
  .call {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #101010;
    color: rgba(255, 255, 255, 0.92);
  }
  .titlebar {
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    user-select: none;
  }
  .title {
    font-size: 12px;
    letter-spacing: 0.06em;
    opacity: 0.7;
  }
  .stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .stage :global(.call) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    flex: none;
  }
  .status {
    margin: 0;
    font-size: 13px;
    flex: 1 1 auto;
  }
  .tracks {
    font-size: 11px;
    opacity: 0.5;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    flex: none;
    font-size: 12px;
    background: rgba(192, 54, 44, 0.18);
  }
  .notice span {
    flex: 1 1 auto;
  }
  .notice button,
  .control {
    border: 0;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 12px;
    background: rgba(255, 255, 255, 0.14);
    color: inherit;
    cursor: pointer;
  }
  .control[aria-pressed='true'] {
    background: rgba(255, 255, 255, 0.34);
  }
  .control:disabled,
  .notice button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .transcription {
    font-size: 11px;
    opacity: 0.6;
  }
</style>
