<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import * as Sentry from '@sentry/svelte';

  /**
   * Per-company sync-mode toggle (Phase D, HQ Pro selective-download).
   *
   * `all`    → a sync downloads the company's full tree.
   * `shared` → a sync downloads only granted/shared prefixes (+ pins).
   *
   * Mode is a LOCAL FOOTPRINT control, never access. The authoritative store
   * is server-side per-membership; we read it lazily on mount and write it via
   * `set_sync_mode`. `custom` is CLI-only and rendered read-only here.
   */

  interface MembershipSyncConfig {
    membershipId: string;
    syncMode: 'all' | 'shared' | 'custom';
    isDefault: boolean;
    customPaths?: string[] | null;
    updatedBy?: string | null;
  }

  interface Props {
    slug: string;
    /** Disable interaction when the vault is unreachable. */
    cloudReachable: boolean;
  }

  type SyncMode = MembershipSyncConfig['syncMode'];
  type WritableSyncMode = Exclude<SyncMode, 'custom'>;

  let { slug, cloudReachable }: Props = $props();

  // `mode` is always the last value confirmed by the backend. Pending writes
  // live separately so a failed optimistic interaction cannot masquerade as a
  // saved preference.
  let mode = $state<SyncMode | null>(null);
  let loading = $state(true);
  let savingMode = $state<WritableSyncMode | null>(null);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let failedMode = $state<WritableSyncMode | null>(null);
  let loadGeneration = 0;
  let saveGeneration = 0;

  async function load(requestedSlug = slug) {
    const generation = ++loadGeneration;
    loading = true;
    loadError = null;
    try {
      const cfg = await invoke<MembershipSyncConfig>('get_sync_mode', {
        companySlug: requestedSlug,
      });
      if (generation !== loadGeneration || requestedSlug !== slug) return;
      mode = cfg.syncMode;
    } catch (err) {
      if (generation !== loadGeneration || requestedSlug !== slug) return;
      // Read failures remain local and retryable; a previously trusted value is
      // intentionally left intact when a refresh fails.
      console.warn(`get_sync_mode(${requestedSlug}) failed:`, err);
      loadError = 'Couldn’t load sync mode.';
    } finally {
      if (generation === loadGeneration && requestedSlug === slug) {
        loading = false;
      }
    }
  }

  // Lazily resolve on mount / company change. The generation guards prevent a
  // slower response from a prior row overwriting the current company.
  $effect(() => {
    const activeSlug = slug;
    mode = null;
    loading = true;
    savingMode = null;
    loadError = null;
    saveError = null;
    failedMode = null;
    saveGeneration += 1;
    void load(activeSlug);
    return () => {
      loadGeneration += 1;
      saveGeneration += 1;
    };
  });

  async function setMode(next: WritableSyncMode) {
    if (!cloudReachable || loading || savingMode !== null || mode === next) return;
    const trustedMode = mode;
    const requestedSlug = slug;
    const generation = ++saveGeneration;
    savingMode = next;
    saveError = null;
    failedMode = null;
    try {
      const cfg = await invoke<MembershipSyncConfig>('set_sync_mode', {
        companySlug: requestedSlug,
        mode: next,
      });
      if (generation !== saveGeneration || requestedSlug !== slug) return;
      mode = cfg.syncMode;
    } catch (err) {
      if (generation !== saveGeneration || requestedSlug !== slug) return;
      mode = trustedMode;
      const msg = String(err);
      console.error(`set_sync_mode(${requestedSlug}, ${next}) failed:`, msg);
      Sentry.captureException(err instanceof Error ? err : new Error(msg), {
        tags: {
          slug: requestedSlug,
          action: 'set-sync-mode',
          mode: next,
          source: 'frontend',
        },
      });
      failedMode = next;
      saveError = 'Couldn’t save sync mode.';
    } finally {
      if (generation === saveGeneration && requestedSlug === slug) {
        savingMode = null;
      }
    }
  }

  function retryLoad() {
    if (loading) return;
    void load();
  }

  function retrySave() {
    if (!failedMode) return;
    void setMode(failedMode);
  }
</script>

<span
  class="sync-mode-shell"
  data-testid="sync-mode-control"
  aria-busy={loading || savingMode !== null}
  title={
    cloudReachable
      ? 'Controls what this company downloads to THIS machine — not who can access it. Shared = only files shared with you; All = the whole company. Switching to Shared removes the rest from this machine on the next sync (they stay in the cloud and come back if you switch to All). Files you’ve changed but not yet synced are never removed.'
      : 'Cloud unreachable — sync mode can’t be changed right now'
  }
>
  {#if mode === 'custom'}
    <!-- Custom paths are CLI-managed (`hq sync mode custom --paths …`); the
         popover has no surface to edit a path list, so we render it read-only. -->
    <span
      class="sync-mode sync-mode-custom"
      title="Custom paths — managed via `hq sync mode custom`"
    >
      custom
    </span>
  {:else if mode !== null}
    <span class="sync-mode-toggle" role="group" aria-label={`Sync mode for ${slug}`}>
      <button
        type="button"
        class="sync-mode-opt"
        class:active={mode === 'shared'}
        data-testid="sync-mode-shared"
        disabled={!cloudReachable || loading || savingMode !== null}
        aria-pressed={mode === 'shared'}
        aria-busy={savingMode === 'shared'}
        onclick={() => setMode('shared')}
      >
        {#if savingMode === 'shared'}
          <span class="sync-mode-spinner" aria-hidden="true"></span>
          Saving…
        {:else}
          Shared
        {/if}
      </button>
      <button
        type="button"
        class="sync-mode-opt"
        class:active={mode === 'all'}
        data-testid="sync-mode-all"
        disabled={!cloudReachable || loading || savingMode !== null}
        aria-pressed={mode === 'all'}
        aria-busy={savingMode === 'all'}
        onclick={() => setMode('all')}
      >
        {#if savingMode === 'all'}
          <span class="sync-mode-spinner" aria-hidden="true"></span>
          Saving…
        {:else}
          All
        {/if}
      </button>
    </span>
  {:else if loading}
    <span class="sync-mode sync-mode-loading" data-testid="sync-mode-loading" role="status">
      <span class="sync-mode-spinner" aria-hidden="true"></span>
      Loading…
    </span>
  {/if}

  {#if saveError}
    <span class="sync-mode-feedback" data-testid="sync-mode-error" role="alert">
      <span>{saveError}</span>
      <button
        type="button"
        class="sync-mode-retry"
        data-testid="sync-mode-retry"
        disabled={!cloudReachable || savingMode !== null}
        aria-busy={savingMode !== null}
        onclick={retrySave}
      >
        Retry
      </button>
    </span>
  {:else if loadError}
    <span class="sync-mode-feedback" data-testid="sync-mode-error" role="alert">
      <span>{loadError}</span>
      <button
        type="button"
        class="sync-mode-retry"
        data-testid="sync-mode-retry"
        disabled={loading}
        aria-busy={loading}
        onclick={retryLoad}
      >
        {loading ? 'Retrying…' : 'Retry'}
      </button>
    </span>
  {/if}
</span>

<style>
  .sync-mode-shell {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    flex-shrink: 0;
  }

  .sync-mode-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border-radius: 0;
    background: transparent;
    border: 0;
    flex-shrink: 0;
  }

  .sync-mode-opt {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--popover-text-muted, var(--pop-muted));
    font: inherit;
    font-size: 0.625rem;
    font-weight: 600;
    line-height: 1;
    padding: 0.1875rem 0.25rem;
    border-radius: 0;
    cursor: pointer;
    transition: border-color 0.1s ease, color 0.1s ease;
  }

  .sync-mode-opt:hover:not(:disabled):not(.active) {
    background: transparent;
    color: var(--popover-text, var(--pop-text));
  }

  .sync-mode-opt.active {
    border-bottom-color: var(--popover-text-muted, var(--pop-muted));
    background: transparent;
    color: var(--popover-text, var(--pop-text));
  }

  .sync-mode-opt:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: 2px;
  }

  .sync-mode-opt:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .sync-mode {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--popover-text-muted, var(--pop-muted));
    padding: 0.1875rem 0;
    border-radius: 0;
    background: transparent;
  }

  .sync-mode-custom {
    border: 0;
  }

  .sync-mode-loading,
  .sync-mode-feedback {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .sync-mode-feedback {
    color: var(--popover-text-muted, var(--pop-muted));
    font-size: 0.625rem;
    font-weight: 500;
  }

  .sync-mode-retry {
    appearance: none;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: var(--popover-text, var(--pop-text));
    font: inherit;
    cursor: pointer;
  }

  .sync-mode-retry:hover:not(:disabled) {
    border-bottom-color: transparent;
  }

  .sync-mode-retry:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: 2px;
  }

  .sync-mode-retry:disabled {
    cursor: progress;
    opacity: 0.6;
  }

  .sync-mode-spinner {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border: 1px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: sync-mode-spin 0.7s linear infinite;
  }

  @keyframes sync-mode-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sync-mode-opt {
      transition: none;
    }

    .sync-mode-spinner {
      animation: none;
    }
  }
</style>
