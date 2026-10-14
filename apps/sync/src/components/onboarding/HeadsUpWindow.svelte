<script lang="ts">
  import { HEADS_UP_COPY, type HeadsUpAction } from '../../lib/heads-up';

  let {
    onaction,
  }: {
    onaction: (action: HeadsUpAction) => void | Promise<void>;
  } = $props();

  let busy = $state(false);

  async function choose(action: HeadsUpAction) {
    if (busy) return;
    busy = true;
    try {
      await onaction(action);
    } finally {
      busy = false;
    }
  }
</script>

<!-- The first-launch heads-up. Same palette and type as the welcome flow
     (welcome.css), at card size, before the window takes the screen. -->
<div class="heads-up" data-testid="heads-up" data-tauri-drag-region>
  <h1 class="title" data-tauri-drag-region>{HEADS_UP_COPY.title}</h1>
  <ul class="points">
    {#each HEADS_UP_COPY.points as point (point)}
      <li>{point}</li>
    {/each}
  </ul>
  <div class="actions">
    <button
      type="button"
      class="btn primary"
      data-testid="heads-up-start"
      disabled={busy}
      onclick={() => void choose('start')}>{HEADS_UP_COPY.startNow}</button
    >
    <div class="secondary">
      <button
        type="button"
        class="btn"
        data-testid="heads-up-later"
        disabled={busy}
        onclick={() => void choose('later')}>{HEADS_UP_COPY.later}</button
      >
      <button
        type="button"
        class="btn"
        data-testid="heads-up-manual"
        disabled={busy}
        onclick={() => void choose('manual')}>{HEADS_UP_COPY.manual}</button
      >
    </div>
    <p class="hint">{HEADS_UP_COPY.laterHint}</p>
  </div>
</div>

<style>
  @font-face {
    font-family: 'Fraunces';
    src: url('../../assets/fonts/fraunces-variable-latin.woff2') format('woff2');
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
  }

  .heads-up {
    position: fixed;
    inset: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 32px 32px 24px;
    border-radius: 16px;
    background: rgba(0, 0, 0, 0.86);
    color: #fff;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 14px;
    line-height: 21px;
    font-weight: 400;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }

  .title {
    margin: 0;
    font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
    font-size: 28px;
    line-height: 34px;
    font-weight: 400;
    letter-spacing: -0.01em;
  }

  .points {
    margin: 0;
    padding: 0 0 0 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    color: rgba(255, 255, 255, 0.62);
  }

  .actions {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .secondary {
    display: flex;
    gap: 10px;
  }

  .secondary .btn {
    flex: 1;
  }

  .btn {
    height: 38px;
    padding: 0 16px;
    border: 0;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: background 160ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.22);
  }

  .btn.primary {
    background: #fff;
    color: #000;
  }

  .btn.primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.88);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .btn:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.6);
    outline-offset: 2px;
  }

  .hint {
    margin: 0;
    color: rgba(255, 255, 255, 0.38);
    font-size: 12px;
    line-height: 18px;
    text-align: center;
  }
</style>
