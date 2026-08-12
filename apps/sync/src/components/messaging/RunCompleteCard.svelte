<script lang="ts">
  // Run-complete card for the channel timeline (US-004).
  // Opens preview/diff URLs in the system browser via @tauri-apps/plugin-shell.
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import type { RunCompleteCardModel } from './channelMessageModels';

  interface Props {
    model: RunCompleteCardModel;
  }

  let { model }: Props = $props();

  async function openUrl(url: string | null): Promise<void> {
    const href = url?.trim();
    if (!href) return;
    try {
      await openExternal(href);
    } catch (err) {
      console.error('run-complete-card: open external failed', err);
    }
  }
</script>

<article class="run-card" data-testid="run-complete-card">
  <div class="run-card-body">
    <h3 class="run-card-title">{model.title}</h3>
    {#if model.summary}
      <p class="run-card-summary">{model.summary}</p>
    {/if}
  </div>
  {#if model.previewUrl || model.diffUrl}
    <div class="run-card-actions">
      {#if model.previewUrl}
        <button
          type="button"
          class="run-card-btn"
          onclick={() => void openUrl(model.previewUrl)}
        >
          Open preview
        </button>
      {/if}
      {#if model.diffUrl}
        <button
          type="button"
          class="run-card-btn"
          onclick={() => void openUrl(model.diffUrl)}
        >
          View diff
        </button>
      {/if}
    </div>
  {/if}
</article>

<style>
  .run-card {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    width: min(420px, 100%);
    margin: 0.5rem auto;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border, var(--pop-border));
    border-radius: 8px;
    background: var(--surface-panel, var(--pop-hover));
    color: var(--fg, var(--pop-text));
  }

  .run-card-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .run-card-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--fg, var(--pop-text));
  }

  .run-card-summary {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.45;
    color: var(--muted, var(--pop-muted));
  }

  .run-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .run-card-btn {
    display: inline-flex;
    align-items: center;
    height: 1.75rem;
    padding: 0 0.625rem;
    border: 1px solid var(--border, var(--pop-border));
    border-radius: 6px;
    background: transparent;
    color: var(--fg, var(--pop-text));
    font: inherit;
    font-size: var(--text-sm, var(--text-base));
    font-weight: 550;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .run-card-btn:hover {
    background: var(--row-hover, var(--pop-hover));
  }

  .run-card-btn:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: 1px;
  }
</style>
