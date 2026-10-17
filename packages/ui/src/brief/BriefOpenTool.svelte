<script lang="ts">
  /**
   * Opens the coding tool the person chose on the first-run decision.
   * Shown on the welcome edition and, later, on the Daily Brief.
   */
  interface Props {
    label: string;
    /** One line under the button. Null leaves the button on its own. */
    detail?: string | null;
    busy?: boolean;
    error?: string | null;
    onopen: () => void;
  }
  let { label, detail = null, busy = false, error = null, onopen }: Props = $props();
</script>

<div class="open-tool" data-testid="brief-open-tool">
  <button
    type="button"
    class="cta"
    data-testid="brief-open-tool-button"
    disabled={busy}
    aria-busy={busy ? "true" : undefined}
    aria-describedby={detail ? "brief-open-tool-detail" : undefined}
    onclick={onopen}
  >{busy ? "Opening…" : label}</button>
  {#if detail}
    <p id="brief-open-tool-detail" class="detail" data-testid="brief-open-tool-detail">{detail}</p>
  {/if}
  {#if error}
    <p class="error" role="alert" data-testid="brief-open-tool-error">{error}</p>
  {/if}
</div>

<style>
  .open-tool {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .detail {
    margin: 0;
    max-width: 420px;
    font-size: 12px;
    font-weight: 400;
    line-height: 16px;
    color: rgba(255, 255, 255, 0.62);
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
