<script lang="ts">
  // Run-complete card for the channel timeline (US-004, ported from the hq-sync
  // desktop source). Markup + CSS are verbatim; the one platform touch — opening
  // preview/diff URLs in the system browser — is routed through an injected
  // `onopenurl` seam so packages/ui stays platform-pure (no native/host import).
  // The host wires it to the desktop plugin-shell opener or window.open (web).
  import type { RunCompleteCardModel } from "./channelMessageModels";

  interface Props {
    model: RunCompleteCardModel;
    /** Platform seam for opening an external URL. Defaults to window.open. */
    onopenurl?: (url: string) => void;
  }

  let { model, onopenurl }: Props = $props();

  function openUrl(url: string | null): void {
    const href = url?.trim();
    if (!href) return;
    if (onopenurl) {
      onopenurl(href);
      return;
    }
    if (typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer");
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
          onclick={() => openUrl(model.previewUrl)}
        >
          Open preview
        </button>
      {/if}
      {#if model.diffUrl}
        <button
          type="button"
          class="run-card-btn"
          onclick={() => openUrl(model.diffUrl)}
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
    width: 100%;
    max-width: none;
    margin: 6px 0 0;
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
    transition:
      border-color 0.12s ease,
      background-color 0.12s ease;
  }

  .run-card-btn:hover {
    border-color: var(--line2, var(--pop-border));
  }

  .run-card-btn:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: 1px;
  }
</style>
