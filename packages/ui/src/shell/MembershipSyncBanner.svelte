<script lang="ts">
  /**
   * Prominent, dismissible shell banner for a membership the user has
   * accepted but that hasn't been pulled onto this machine yet
   * (`joinableMemberships()` in ../chat/workspaces.js). Desktop-window
   * counterpart of the menubar popover's "You've been added" notice —
   * same capability, own visual idiom (mirrors RecommendedUpdateBanner).
   */
  import type { Workspace } from "../chat/workspaces.js";

  interface Props {
    /** Already filtered to joinable + not-dismissed-this-session. Non-empty when rendered. */
    memberships: Workspace[];
    syncing?: boolean;
    /**
     * User-facing failure text. The popover's Sync surfaces reauth and runner
     * errors; this banner must too, or a failed pull looks like a no-op.
     */
    error?: string | null;
    onsync?: () => void | Promise<void>;
    /**
     * Receives EVERY slug the banner is currently speaking for, not just the
     * named one. The copy aggregates ("Added to Acme + 2 more"), so a dismiss
     * that dropped only the first would silently re-render for the second and
     * read as the button being ignored.
     */
    ondismiss?: (slugs: string[]) => void;
  }

  let {
    memberships,
    syncing = false,
    error = null,
    onsync,
    ondismiss,
  }: Props = $props();

  const first = $derived(memberships[0]);
  const title = $derived(first ? `Added to ${first.displayName}` : "");
  const extra = $derived(memberships.length > 1 ? memberships.length - 1 : 0);
  const allSlugs = $derived(memberships.map((w) => w.slug));
</script>

{#if first}
  <div
    class="membership-banner"
    role="region"
    aria-label="Company memberships to sync"
    data-testid="membership-sync-banner"
  >
    <div class="membership-copy">
      <strong>{title}{extra > 0 ? ` + ${extra} more` : ""}</strong>
      <span>
        Sync to pull {memberships.length > 1 ? "them" : "it"} onto this machine.
      </span>
      <!--
        Own live region: the banner itself is a static region, so an error
        arriving after mount is only announced if it lands in something the
        screen reader is watching.
      -->
      <span class="membership-error" role="alert" aria-live="assertive">
        {#if error}
          <span data-testid="membership-sync-error">{error}</span>
        {/if}
      </span>
    </div>
    <div class="membership-actions">
      <button
        type="button"
        class="membership-sync"
        data-testid="membership-sync-now"
        disabled={syncing}
        aria-busy={syncing}
        onclick={() => void onsync?.()}
      >
        {syncing ? "Syncing…" : error ? "Try again" : "Sync now"}
      </button>
      <button
        type="button"
        class="membership-dismiss"
        data-testid="membership-sync-dismiss"
        onclick={() => ondismiss?.(allSlugs)}
      >
        Dismiss
      </button>
    </div>
  </div>
{/if}

<style>
  .membership-banner {
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

  .membership-copy {
    display: flex;
    flex: 1 1 220px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .membership-copy strong {
    font-weight: 600;
  }

  .membership-copy span {
    color: var(--v4-text-2, var(--t2, rgba(0, 0, 0, 0.62)));
  }

  /* Empty until something fails — collapses so the banner keeps its height. */
  .membership-error:empty {
    display: none;
  }

  .membership-error {
    color: var(--v4-danger, #b3261e);
  }

  .membership-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .membership-sync,
  .membership-dismiss {
    margin: 0;
    border-radius: 6px;
    font: 500 12px/1 var(--font-ui, system-ui);
    cursor: pointer;
  }

  .membership-sync {
    padding: 7px 12px;
    border: 0;
    background: var(--v4-text-1, #111);
    color: var(--v4-ground, #fff);
  }

  .membership-sync:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .membership-dismiss {
    padding: 7px 10px;
    border: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.12));
    background: transparent;
    color: var(--v4-text-2, inherit);
  }
</style>
