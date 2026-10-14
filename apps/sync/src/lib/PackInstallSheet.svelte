<script lang="ts">
  import {
    packDisplayLabel,
    type PackInstallSheetState,
  } from './pack-install';

  interface Props {
    state: PackInstallSheetState;
    /** Add: run `hq packages install {slug} --start-bot`. */
    onadd: () => void;
    /** Cancel / Close: dismiss the sheet without installing (or after). */
    oncancel: () => void;
    /** Done without a bot DM to open: take the person to Messages. */
    onopenmessages?: () => void;
  }

  let { state, onadd, oncancel, onopenmessages }: Props = $props();

  const label = $derived(packDisplayLabel(state));
  const title = $derived(
    state.phase === 'signed-out'
      ? `Sign in to add ${label}`
      : state.phase === 'installing'
        ? `Adding ${label}`
        : state.phase === 'done'
          ? `${label} added`
          : state.phase === 'failed'
            ? `Couldn’t add ${label}`
            : `Add ${label} to HQ?`,
  );
  const recentLines = $derived(state.lines.slice(-6));
</script>

<div
  class="pack-sheet-backdrop"
  data-testid="pack-install-sheet"
  data-phase={state.phase}
  role="presentation"
>
  <div
    class="pack-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pack-sheet-title"
  >
    <h1 id="pack-sheet-title" class="title">{title}</h1>

    {#if state.phase === 'signed-out'}
      <p class="body" data-testid="pack-sheet-signed-out">
        Sign in first. The pack stays queued and this sheet comes back once you’re in.
      </p>
      <div class="actions">
        <button type="button" class="secondary" onclick={oncancel}>Not now</button>
      </div>
    {:else if state.phase === 'confirm'}
      <p class="body">
        This installs the pack into your HQ and starts its bot. The bot will introduce itself in
        Messages.
      </p>
      <p class="slug" aria-label="Pack id">{state.slug}</p>
      <div class="actions">
        <button type="button" class="secondary" onclick={oncancel}>Cancel</button>
        <button type="button" class="primary" data-testid="pack-sheet-add" onclick={onadd}>Add</button>
      </div>
    {:else if state.phase === 'installing'}
      <p class="body" aria-live="polite" aria-busy="true">Installing and starting the bot…</p>
      <ol class="progress" data-testid="pack-sheet-progress" aria-label="Install progress">
        {#each recentLines as line, index (index)}
          <li>{line}</li>
        {/each}
      </ol>
    {:else if state.phase === 'done'}
      <p class="body" data-testid="pack-sheet-done">
        {#if state.botName}
          Your new bot <strong>{state.botName}</strong> is ready in Messages.
        {:else}
          The pack is installed. Its bot will appear in Messages once it starts.
        {/if}
      </p>
      <div class="actions">
        <button type="button" class="secondary" onclick={oncancel}>Close</button>
        {#if onopenmessages}
          <button type="button" class="primary" onclick={onopenmessages}>Open Messages</button>
        {/if}
      </div>
    {:else}
      <p class="body error" role="alert" data-testid="pack-sheet-error">
        {state.error ?? 'The pack could not be installed.'}
      </p>
      {#if recentLines.length > 0}
        <ol class="progress" aria-label="Last output">
          {#each recentLines as line, index (index)}
            <li>{line}</li>
          {/each}
        </ol>
      {/if}
      <div class="actions">
        <button type="button" class="secondary" onclick={oncancel}>Close</button>
        <button type="button" class="primary" data-testid="pack-sheet-retry" onclick={onadd}>Try again</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .pack-sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 49500;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: color-mix(in srgb, var(--pop-text, #000) 24%, transparent);
  }

  .pack-sheet {
    box-sizing: border-box;
    width: min(420px, 100%);
    padding: 20px 20px 16px;
    border: 1px solid var(--pop-border);
    border-radius: var(--radius-popover, 12px);
    background: var(--pop-bg);
    box-shadow: var(--pop-shadow);
    color: var(--pop-text);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 13px;
    line-height: 1.45;
  }

  .title {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .body { margin: 0; }
  .body.error { color: var(--danger, #c0392b); }

  .slug {
    margin: 8px 0 0;
    color: var(--pop-muted);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
  }

  .progress {
    margin: 10px 0 0;
    padding: 8px 10px;
    max-height: 30vh;
    overflow-y: auto;
    list-style: none;
    border-radius: 8px;
    background: color-mix(in srgb, var(--pop-text, #000) 6%, transparent);
    color: var(--pop-muted);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .actions button {
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid var(--pop-border);
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    cursor: pointer;
  }

  .actions .primary {
    border-color: transparent;
    background: var(--accent, #2563eb);
    color: var(--accent-contrast, #fff);
  }
</style>
