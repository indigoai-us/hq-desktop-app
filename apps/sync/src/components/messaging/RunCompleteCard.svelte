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
    gap: 6px;
    width: min(420px, 100%);
    margin: 0.5rem auto;
    padding: 12px 14px;
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 10px;
    background: var(--raised, var(--pop-hover));
    color: var(--t1, var(--pop-text));
  }

  .run-card-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .run-card-title {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--t1, var(--pop-text));
  }

  .run-card-summary {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--t2, var(--pop-muted));
  }

  .run-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }

  .run-card-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--btn-bg, transparent);
    color: var(--t1, var(--pop-text));
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.12s ease, background-color 0.12s ease;
  }

  .run-card-btn:hover {
    border-color: var(--line2, var(--pop-border));
  }

  .run-card-btn:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: 1px;
  }
</style>
