<script lang="ts">
  /**
   * Opens the coding tool the person chose on the first-run decision.
   * Shown on the welcome edition and, later, on the Daily Brief.
   */
  interface Props {
    label: string;
    busy?: boolean;
    error?: string | null;
    onopen: () => void;
  }
  let { label, busy = false, error = null, onopen }: Props = $props();
</script>

<div class="open-tool" data-testid="brief-open-tool">
  <button
    type="button"
    class="cta"
    data-testid="brief-open-tool-button"
    disabled={busy}
    aria-busy={busy ? "true" : undefined}
    onclick={onopen}
  >{busy ? "Opening…" : label}</button>
  {#if error}
    <p class="error" role="alert" data-testid="brief-open-tool-error">{error}</p>
  {/if}
</div>

<style>
  .open-tool {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .cta {
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    border: 0;
    border-radius: 999px;
    padding: 8px 18px;
    cursor: pointer;
    color: var(--b-bg, #1b1b1e);
    background: var(--b-sun, #ffb580);
  }
  .cta:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .cta:focus-visible {
    outline: 2px solid rgba(255, 181, 128, 0.75);
    outline-offset: 2px;
  }
  .error {
    margin: 0;
    font-size: 13px;
    line-height: 18px;
    color: rgba(255, 220, 210, 0.86);
  }
</style>
