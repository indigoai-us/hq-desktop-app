<script lang="ts">
  /**
   * Sidebar card that appears when an app update is deferred (the app is
   * focused or a hold is active). Stays quiet and native; mirrors the
   * Claude Desktop update affordance.
   *
   * The parent (DesktopApp) owns all Tauri/event wiring. This component is
   * platform-pure: it receives version, reasons, and callbacks as props.
   */

  /** User-facing hold reason strings. */
  const REASON_TEXT: Record<string, string> = {
    MeetingRecording: "Waiting for your recording to finish",
    TranscriptFinishing: "Waiting for a transcript to finish",
    UploadInFlight: "Waiting for an upload to finish",
    CoreUpdateInProgress: "Waiting for the HQ folder update to finish",
  };

  function primaryReason(reasons: string[]): string | null {
    for (const r of reasons) {
      const text = REASON_TEXT[r];
      if (text) return text;
    }
    return reasons.length > 0 ? reasons[0] : null;
  }

  interface Props {
    version: string;
    reasons: string[];
    installing?: boolean;
    installError?: string | null;
    oninstall?: () => void | Promise<void>;
    ondismiss?: () => void;
  }

  let {
    version,
    reasons,
    installing = false,
    installError = null,
    oninstall,
    ondismiss,
  }: Props = $props();

  const held = $derived(reasons.length > 0);
  const holdText = $derived(held ? primaryReason(reasons) : null);
  const secondaryLine = $derived(
    holdText ?? `HQ ${version} is ready to install`,
  );
  const buttonLabel = $derived(installing ? "Restarting…" : "Restart to update");
  const buttonDisabled = $derived(held || installing);
  const tooltipText = $derived(holdText ?? null);
</script>

<div
  class="update-card"
  role="status"
  aria-live="polite"
  aria-label="App update available"
  data-testid="update-available-card"
>
  <div class="update-copy">
    <strong class="update-title">Update available</strong>
    <span class="update-secondary" data-testid="update-secondary">
      {secondaryLine}
    </span>
    {#if installError}
      <span class="update-error" role="alert" data-testid="update-error">
        {installError}
      </span>
    {/if}
  </div>
  <div class="update-actions">
    <button
      type="button"
      class="update-install"
      data-testid="update-install"
      disabled={buttonDisabled}
      aria-disabled={buttonDisabled}
      aria-description={tooltipText ?? undefined}
      title={tooltipText ?? undefined}
      onclick={() => void oninstall?.()}
    >
      {buttonLabel}
    </button>
    <button
      type="button"
      class="update-later"
      data-testid="update-later"
      onclick={() => ondismiss?.()}
    >
      Later
    </button>
  </div>
</div>

<style>
  .update-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 14px 12px;
    border-top: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.08));
    background: color-mix(in srgb, var(--v4-text-1, #111) 4%, transparent);
    color: var(--v4-text-1, #111);
    font: 400 13px/1.4 var(--font-ui, system-ui);
    flex-shrink: 0;
    /* Enter/exit: slide up from below */
    animation: update-card-in 150ms ease-out both;
  }

  @keyframes update-card-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .update-card {
      animation: none;
    }
  }

  .update-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .update-title {
    font-weight: 600;
    font-size: 13px;
  }

  .update-secondary {
    color: var(--v4-text-2, rgba(0, 0, 0, 0.62));
    font-size: 13px;
  }

  .update-error {
    color: var(--v4-danger, #b3261e);
    font-size: 13px;
    margin-top: 2px;
  }

  .update-error:empty {
    display: none;
  }

  .update-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .update-install {
    padding: 6px 12px;
    border: 0;
    border-radius: 6px;
    background: var(--v4-text-1, #111);
    color: var(--v4-ground, #fff);
    font: 500 12px/1 var(--font-ui, system-ui);
    cursor: pointer;
    flex-shrink: 0;
  }

  .update-install:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .update-install:not(:disabled):focus-visible {
    outline: 2px solid var(--v4-focus-ring, #0078d4);
    outline-offset: 2px;
  }

  .update-later {
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2, rgba(0, 0, 0, 0.55));
    font: 400 12px/1 var(--font-ui, system-ui);
    cursor: pointer;
    flex-shrink: 0;
  }

  .update-later:focus-visible {
    outline: 2px solid var(--v4-focus-ring, #0078d4);
    outline-offset: 2px;
  }
</style>
