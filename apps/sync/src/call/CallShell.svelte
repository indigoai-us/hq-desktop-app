<script lang="ts">
  /**
   * The call window's shell (US-016/017/020).
   *
   * It owns the window chrome, the identity/permission notices and the media
   * elements; the gallery and the control bar are the SHARED design-system
   * components (`meet.CallView` / `meet.MediaControls`), so the call looks and
   * behaves like the rest of HQ and stays testable without a webview.
   *
   * The microphone and camera buttons are still the ONLY path to
   * `getUserMedia`: mounting, receiving a knock, restoring a remembered
   * preference or picking a device in a picker never reaches capture.
   */
  import { CallView, type CallTile } from '@hq/ui';

  import { callView } from './view.svelte';

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
    await callView.handle?.leave('leave-button');
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
   * Render a tile's media. The shell keeps the two legacy elements (`.remote`,
   * `audio`) that `main.ts` attaches streams to, so this hook only has to name
   * the element for the self tile's local preview.
   */
  function attach(element: HTMLVideoElement, tile: CallTile): () => void {
    element.dataset.tileId = tile.id;
    if (tile.self) element.classList.add('local-preview');
    return () => {
      delete element.dataset.tileId;
    };
  }
</script>

<div class="call">
  <header class="titlebar" data-tauri-drag-region>
    <span class="title" data-tauri-drag-region>HQ Call</span>
  </header>

  <div class="hidden-media">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="remote" data-testid="remote-video" autoplay playsinline></video>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="local" data-testid="local-video" autoplay playsinline muted></video>
    <audio data-testid="remote-audio" autoplay></audio>
  </div>

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

  <footer class="bar">
    <button
      type="button"
      class="control"
      data-testid="toggle-microphone"
      aria-pressed={mic.active}
      disabled={!controlsEnabled || busy !== null}
      onclick={() => toggleDevice('microphone', !mic.active)}
      >{mic.active ? 'Mute' : 'Unmute'}</button
    >
    <button
      type="button"
      class="control"
      data-testid="toggle-camera"
      aria-pressed={cam.active}
      disabled={!controlsEnabled || busy !== null}
      onclick={() => toggleDevice('camera', !cam.active)}
      >{cam.active ? 'Stop video' : 'Start video'}</button
    >
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
    <button
      type="button"
      class="leave"
      data-testid="leave-call"
      disabled={leaving || view.status === 'left' || view.status === 'error'}
      onclick={leave}>Leave</button
    >
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
  /*
    The stream sinks `main.ts` attaches to. They stay in the document (the
    attach path addresses them by selector) but out of the layout: the gallery
    is what the user sees.
  */
  .hidden-media {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
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
  .leave {
    border: 0;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    background: #c0362c;
    color: #fff;
    cursor: pointer;
  }
  .leave:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
