<script lang="ts">
  /**
   * Minimal call shell (US-016): a drag-region titlebar, a content-free status
   * line, a Leave button and the remote/local video slots. Full in-call
   * controls are US-020; office and knocks are US-018/019.
   */
  import { callView } from './view.svelte';

  let leaving = $state(false);

  const view = $derived(callView.state);
  const remoteTracks = $derived(callView.remoteTracks);

  const statusLabel = $derived(
    view.status === 'connecting'
      ? 'Connecting…'
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

  <footer class="bar">
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
