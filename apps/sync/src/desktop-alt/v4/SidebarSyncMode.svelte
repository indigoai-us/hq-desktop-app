<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import * as Sentry from '@sentry/svelte';

  /**
   * Per-company Shared/All segmented control for V4 sidebar row hover (US-009).
   *
   * Self-contained: lazily fetches `get_sync_mode` on mount (parent only mounts
   * after first hover/focus), writes via `set_sync_mode` with optimistic flip +
   * revert. Mode is a LOCAL FOOTPRINT control, never access. `custom` is
   * CLI-only and rendered read-only. V4 styling: neutral active fill, no status
   * colour on the control (dots carry status).
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
    /** Display name for user-facing copy; slug stays the invoke key. */
    label?: string;
    /** Vault unreachable: the control stays visible (so the current footprint
     *  reads) but is read-only until the cloud comes back. */
    disabled?: boolean;
  }

  let { slug, label, disabled = false }: Props = $props();

  // null = not yet loaded; otherwise the resolved mode.
  let mode = $state<'all' | 'shared' | 'custom' | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    error = null;
    try {
      const cfg = await invoke<MembershipSyncConfig>('get_sync_mode', {
        companySlug: slug,
      });
      mode = cfg.syncMode;
    } catch (err) {
      // Don't Sentry-spam read failures — a freshly-connected company with no
      // sync-config row, or a transient vault blip, both land here.
      console.warn(`get_sync_mode(${slug}) failed:`, err);
      error = 'mode unavailable';
    }
  }

  // Lazily resolve on mount. Parent only mounts after first hover/focus, so
  // mount = first reveal; do not fetch eagerly at module scope.
  $effect(() => {
    if (mode === null && error === null) {
      void load();
    }
  });

  async function setMode(next: 'all' | 'shared', event: MouseEvent) {
    event.stopPropagation();
    if (disabled || saving || mode === next) return;
    const prev = mode;
    saving = true;
    error = null;
    // Optimistic flip — revert on failure.
    mode = next;
    try {
      const cfg = await invoke<MembershipSyncConfig>('set_sync_mode', {
        companySlug: slug,
        mode: next,
      });
      mode = cfg.syncMode;
    } catch (err) {
      mode = prev;
      const msg = String(err);
      console.error(`set_sync_mode(${slug}, ${next}) failed:`, msg);
      Sentry.captureException(err instanceof Error ? err : new Error(msg), {
        tags: { slug, action: 'set-sync-mode', mode: next, source: 'frontend' },
      });
      error = 'save failed';
    } finally {
      saving = false;
    }
  }

  // A failed read (transient vault blip, offline moment) must not dead-end the
  // control for the whole session — the "—" state is a retry button: clearing
  // `error` re-arms the lazy-load $effect.
  function retryLoad(event: MouseEvent) {
    event.stopPropagation();
    error = null;
  }

  const wrapperTitle = $derived(
    disabled
      ? 'Cloud unreachable — sync mode can\u2019t be changed right now'
      : `Controls what ${label ?? slug} downloads to THIS Mac — not who can access it. Shared = only files shared with you; All = the whole company. Files you've changed but not yet synced are never removed.`,
  );
</script>

<span class="sidebar-sync-mode" class:saving title={wrapperTitle} data-testid="sidebar-sync-mode">
  {#if mode === null && !error}
    <span class="sidebar-sync-mode-loading" aria-hidden="true">…</span>
  {:else if mode === 'custom'}
    <span
      class="sidebar-sync-mode-custom"
      title="Custom paths — managed via `hq sync mode custom`"
    >
      custom
    </span>
  {:else if error}
    <button
      type="button"
      class="sidebar-sync-mode-error"
      title={`${error} — click to retry`}
      onclick={retryLoad}
    >
      —
    </button>
  {:else if mode !== null}
    <button
      type="button"
      class="sidebar-sync-mode-opt"
      class:active={mode === 'shared'}
      disabled={disabled || saving}
      aria-pressed={mode === 'shared'}
      onclick={(e) => setMode('shared', e)}
    >
      Shared
    </button>
    <button
      type="button"
      class="sidebar-sync-mode-opt"
      class:active={mode === 'all'}
      disabled={disabled || saving}
      aria-pressed={mode === 'all'}
      onclick={(e) => setMode('all', e)}
    >
      All
    </button>
  {/if}
</span>

<style>
  .sidebar-sync-mode {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    padding: 2px;
    border-radius: var(--v4-radius-pill);
    /* Opaque-ish glass, not --v4-control-faint: the control overlays the row
       (whose hover fill IS control-faint) and the company name, so it needs
       its own legible surface (US-009 review). */
    background: var(--v4-chrome);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--v4-hairline);
    flex-shrink: 0;
    font-family: var(--font-sans);
  }

  .sidebar-sync-mode.saving {
    opacity: 0.7;
    cursor: progress;
  }

  .sidebar-sync-mode-opt {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 400;
    line-height: 1;
    padding: 2px 7px;
    border-radius: var(--v4-radius-pill);
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .sidebar-sync-mode-opt:hover:not(:disabled):not(.active) {
    color: var(--v4-text-2);
  }

  .sidebar-sync-mode-opt.active {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .sidebar-sync-mode-opt:disabled {
    cursor: default;
  }

  /* A disabled-but-inactive option dims; the active one keeps its fill so the
     current footprint stays legible while the cloud is unreachable. */
  .sidebar-sync-mode-opt:disabled:not(.active) {
    opacity: 0.55;
  }

  .sidebar-sync-mode-loading,
  .sidebar-sync-mode-error,
  .sidebar-sync-mode-custom {
    flex-shrink: 0;
    padding: 2px 7px;
    font-size: var(--text-sm);
    font-weight: 400;
    line-height: 1;
    color: var(--v4-text-3);
  }

  .sidebar-sync-mode-custom {
    border-radius: var(--v4-radius-pill);
  }

  .sidebar-sync-mode-error {
    appearance: none;
    border: 0;
    background: transparent;
    font: inherit;
    opacity: 0.6;
    cursor: pointer;
  }
</style>
