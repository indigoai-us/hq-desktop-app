<script lang="ts">
  import { HEADS_UP_COPY, type HeadsUpAction } from '../../lib/heads-up';
  import { HQ_MARK_H, HQ_MARK_Q } from './welcome/engines';
  import './welcome/welcome.css';

  let {
    onaction,
    ready = true,
  }: {
    onaction: (action: HeadsUpAction) => void | Promise<void>;
    /**
     * False while the window is still being sized down from full screen.
     * The card stays transparent until then, so the screen does not flash.
     */
    ready?: boolean;
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

<!-- The first-launch heads-up. It is the first frame of the welcome flow at
     card size: the same .hq-welcome tokens, veil color, grain, type, buttons and
     enter motion (welcome/welcome.css). -->
<div
  class="hq-welcome heads-up"
  class:ready
  data-testid="heads-up"
  data-ready={ready ? 'true' : 'false'}
  data-tauri-drag-region
>
  <div class="surface" aria-hidden="true"></div>
  <div class="grain" class:on={ready} aria-hidden="true"></div>

  <div class="content" class:on={ready} data-tauri-drag-region>
    <svg class="mark" viewBox="0 0 280 161" aria-hidden="true" data-tauri-drag-region>
      <path d={HQ_MARK_H} /><path fill-rule="evenodd" d={HQ_MARK_Q} />
    </svg>
    <h1 class="h title" data-tauri-drag-region>{HEADS_UP_COPY.title}</h1>
    <ul class="body points">
      {#each HEADS_UP_COPY.points as point (point)}
        <li>{point}</li>
      {/each}
    </ul>
    <div class="actions">
      <button
        type="button"
        class="btn btn-primary"
        data-testid="heads-up-start"
        disabled={busy}
        onclick={() => void choose('start')}>{HEADS_UP_COPY.startNow}</button
      >
      <div class="secondary">
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="heads-up-later"
          disabled={busy}
          onclick={() => void choose('later')}>{HEADS_UP_COPY.later}</button
        >
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="heads-up-manual"
          disabled={busy}
          onclick={() => void choose('manual')}>{HEADS_UP_COPY.manual}</button
        >
      </div>
      <p class="hint">{HEADS_UP_COPY.laterHint}</p>
    </div>
  </div>
</div>

<style>
  /* Layout only. Color, type, easing and buttons come from the .hq-welcome
     tokens and classes in welcome.css. The card uses no backdrop filter, as
     a rounded one shows square corners in WKWebView. */
  .heads-up {
    border-radius: 16px;
    font-weight: 400;
  }

  .surface {
    position: absolute;
    inset: 0;
    z-index: 0;
    border-radius: inherit;
    /* The takeover's veil over a dark base: the desktop behind the window
       is not blurred here, so the card stays close to opaque. */
    background:
      linear-gradient(var(--w-veil-bg), var(--w-veil-bg)),
      rgba(22, 22, 26, 0.9);
    opacity: 0;
    transition: opacity 0.7s var(--w-ease-in-out);
  }

  .ready .surface {
    opacity: 1;
  }

  .content {
    position: relative;
    z-index: 2;
    box-sizing: border-box;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 26px 32px 20px;
  }

  .mark {
    width: 40px;
    height: auto;
    fill: var(--w-text);
    opacity: 0;
    transition: opacity 0.9s var(--w-ease-out);
  }

  .content.on .mark {
    opacity: 1;
  }

  .content .title {
    margin-top: 18px;
    font-size: 30px;
  }

  .content .points {
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .actions {
    margin-top: auto;
    padding-top: 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    opacity: 0;
    transform: translateY(12px);
    transition:
      opacity 0.9s var(--w-ease-out),
      transform 0.9s var(--w-ease-out);
  }

  .content.on .actions {
    opacity: 1;
    transform: none;
    transition-delay: 0.7s;
  }

  .secondary {
    display: flex;
    gap: 8px;
  }

  .secondary .btn {
    flex: 1;
  }

  .hint {
    margin: 4px 0 0;
    color: var(--w-faint);
    font-size: 12px;
    line-height: 18px;
    text-align: center;
  }
</style>
