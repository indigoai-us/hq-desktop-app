<script lang="ts">
  /**
   * Prominent, dismissible shell banner for hq-pro `updateRecommended`.
   * "Update now" downloads and installs immediately (no sync-idle deferral).
   */
  interface Props {
    version: string;
    message?: string | null;
    installing?: boolean;
    onupdate?: () => void | Promise<void>;
    ondismiss?: () => void;
  }

  let {
    version,
    message = null,
    installing = false,
    onupdate,
    ondismiss,
  }: Props = $props();
</script>

<div
  class="recommend-banner"
  role="status"
  data-testid="recommended-update-banner"
>
  <div class="recommend-copy">
    <strong>Update available</strong>
    <span>
      {message ?? `HQ v${version} is recommended. Update now to stay current.`}
    </span>
  </div>
  <div class="recommend-actions">
    <button
      type="button"
      class="recommend-update"
      data-testid="recommended-update-now"
      disabled={installing}
      aria-busy={installing}
      onclick={() => void onupdate?.()}
    >
      {installing ? "Updating…" : "Update now"}
    </button>
    <button
      type="button"
      class="recommend-dismiss"
      data-testid="recommended-update-dismiss"
      onclick={() => ondismiss?.()}
    >
      Dismiss
    </button>
  </div>
</div>

<style>
  .recommend-banner {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.08));
    background: color-mix(in srgb, var(--v4-text-1, #111) 6%, transparent);
    color: var(--v4-text-1, var(--t1));
    font: 400 13px/1.4 var(--font-ui, system-ui);
  }

  .recommend-copy {
    display: flex;
    flex: 1 1 220px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .recommend-copy strong {
    font-weight: 600;
  }

  .recommend-copy span {
    color: var(--v4-text-2, var(--t2, rgba(0, 0, 0, 0.62)));
  }

  .recommend-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .recommend-update,
  .recommend-dismiss {
    margin: 0;
    border-radius: 6px;
    font: 500 12px/1 var(--font-ui, system-ui);
    cursor: pointer;
  }

  .recommend-update {
    padding: 7px 12px;
    border: 0;
    background: var(--v4-text-1, #111);
    color: var(--v4-ground, #fff);
  }

  .recommend-update:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .recommend-dismiss {
    padding: 7px 10px;
    border: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.12));
    background: transparent;
    color: var(--v4-text-2, inherit);
  }
</style>
