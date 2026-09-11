<script lang="ts">
  /**
   * Minimal call shell (US-016), bound to the active account (US-017): a
   * drag-region titlebar, a content-free status line, the remote/local video
   * slots, and the explicit join controls.
   *
   * The microphone and camera buttons are the ONLY path to `getUserMedia` in
   * this window — receiving a knock, mounting, or restoring a remembered
   * preference never reaches them. A denial renders its OS recovery path next
   * to a Retry rather than silently staying off. Full in-call controls are
   * US-020; office and knocks are US-018/019.
   */
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
          ? 'Transcription paused \u00b7 waiting for consent'
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

  async function leave() {
    if (leaving) return;
    leaving = true;
    await callView.handle?.leave('leave-button');
  }

  /** The explicit join control. Nothing else in this window may capture. */
  async function toggleDevice(kind: 'microphone' | 'camera') {
    if (busy) return;
    busy = kind;
    try {
      const on = kind === 'microphone' ? mic.active : cam.active;
      await callView.handle?.setDevice(kind, !on);
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
</script>

<div class="call">
  <header class="titlebar" data-tauri-drag-region>
    <span class="title" data-tauri-drag-region>HQ Call</span>
  </header>

  <main class="stage">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="remote" data-testid="remote-video" autoplay playsinline></video>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="local" data-testid="local-video" autoplay playsinline muted></video>
    <audio data-testid="remote-audio" autoplay></audio>
  </main>

  {#if view.status === 'identity' && view.recoverable}
    <div class="notice" data-testid="call-identity-error" role="alert">
      <span>Confirm your account to join this call.</span>
      <button type="button" data-testid="call-identity-retry" onclick={retryIdentity}>Retry</button>
    </div>
  {/if}

  {#if view.authorityPaused}
    <div class="notice" data-testid="call-authority-paused" role="status">
      <span
        >Reconnecting to your account. The call continues; new actions are paused.</span
      >
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

  <footer class="bar">
    <button
      type="button"
      class="control"
      data-testid="toggle-microphone"
      aria-pressed={mic.active}
      disabled={!controlsEnabled || busy !== null}
      onclick={() => toggleDevice('microphone')}>{mic.active ? 'Mute' : 'Unmute'}</button
    >
    <button
      type="button"
      class="control"
      data-testid="toggle-camera"
      aria-pressed={cam.active}
      disabled={!controlsEnabled || busy !== null}
      onclick={() => toggleDevice('camera')}>{cam.active ? 'Stop video' : 'Start video'}</button
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
  .stage {
    position: relative;
    flex: 1 1 auto;
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .remote {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  .local {
    position: absolute;
    right: 16px;
    bottom: 16px;
    width: 180px;
    border-radius: 8px;
    background: #222;
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
