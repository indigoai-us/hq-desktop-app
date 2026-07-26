<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import * as Sentry from '@sentry/svelte';

  /**
   * Per-workspace sync controls for the V4 sidebar row chrome.
   *
   * Two policies are intentionally separate:
   *   - `enabled`: local on/off switch for this Mac
   *   - `mode`: remembered cloud-backed company footprint (`shared` / `all`)
   *
   * Disabling a company must not overwrite its remembered footprint. Re-enable
   * simply reuses the existing server-side mode.
   *
   * lazily fetches `get_sync_mode` on mount (parent only mounts
   * after first hover/focus) and writes via `set_sync_mode`.
   */

  interface MembershipSyncConfig {
    membershipId: string;
    syncMode: 'all' | 'shared' | 'custom';
    isDefault: boolean;
    customPaths?: string[] | null;
    updatedBy?: string | null;
  }

  interface SettingsWire {
    personalSyncEnabled?: boolean | null;
    [key: string]: unknown;
  }

  interface Props {
    slug: string;
    label?: string;
    isPersonal?: boolean;
    syncEnabled?: boolean;
    cloudReachable?: boolean;
    onenabledchange?: (enabled: boolean) => void;
  }

  let {
    slug,
    label,
    isPersonal = false,
    syncEnabled = true,
    cloudReachable = true,
    onenabledchange,
  }: Props = $props();

  let enabledState = $state(syncEnabled);
  let mode = $state<'all' | 'shared' | 'custom' | null>(null);
  let saving = $state(false);
  let modeError = $state<string | null>(null);

  $effect(() => {
    enabledState = syncEnabled;
  });

  async function loadMode() {
    if (isPersonal) return;
    modeError = null;
    try {
      const cfg = await invoke<MembershipSyncConfig>('get_sync_mode', {
        companySlug: slug,
      });
      mode = cfg.syncMode;
    } catch (err) {
      console.warn(`get_sync_mode(${slug}) failed:`, err);
      modeError = 'mode unavailable';
    }
  }

  async function loadPersonalEnabled() {
    try {
      const settings = await invoke<SettingsWire>('get_settings');
      enabledState = settings.personalSyncEnabled ?? true;
    } catch (err) {
      console.warn('get_settings(personalSyncEnabled) failed:', err);
      enabledState = true;
    }
  }

  $effect(() => {
    if (isPersonal) {
      void loadPersonalEnabled();
      return;
    }
    if (mode === null && modeError === null) {
      void loadMode();
    }
  });

  async function persistEnabled(next: boolean) {
    if (isPersonal) {
      const prefs = await invoke<Record<string, unknown>>('get_settings').catch(() => ({}));
      await invoke('save_settings', {
        prefs: {
          ...prefs,
          personalSyncEnabled: next,
        },
      });
      window.dispatchEvent(
        new CustomEvent('hq:workspace-sync-enabled-changed', {
          detail: { slug: 'personal', enabled: next },
        }),
      );
      return;
    }

    await invoke<boolean>('set_workspace_sync_enabled', { slug, enabled: next });
    window.dispatchEvent(
      new CustomEvent('hq:workspace-sync-enabled-changed', {
        detail: { slug, enabled: next },
      }),
    );
  }

  async function toggleEnabled(event: Event) {
    event.stopPropagation();
    if (saving) return;
    const next = !enabledState;
    const prev = enabledState;
    saving = true;
    enabledState = next;
    try {
      await persistEnabled(next);
      onenabledchange?.(next);
    } catch (err) {
      enabledState = prev;
      const msg = String(err);
      console.error(`set_workspace_sync_enabled(${slug}, ${next}) failed:`, msg);
      Sentry.captureException(err instanceof Error ? err : new Error(msg), {
        tags: { slug, action: 'set-workspace-sync-enabled', enabled: String(next) },
      });
    } finally {
      saving = false;
    }
  }

  async function setMode(next: 'all' | 'shared', event: MouseEvent) {
    event.stopPropagation();
    if (!cloudReachable || saving || mode === next) return;
    const prev = mode;
    saving = true;
    modeError = null;
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
      modeError = 'save failed';
    } finally {
      saving = false;
    }
  }

  function retryLoad(event: MouseEvent) {
    event.stopPropagation();
    modeError = null;
  }

  const wrapperTitle = $derived(
    isPersonal
      ? 'Turns Personal sync on or off for this Mac. The Settings toggle writes the same value.'
      : `Controls whether ${label ?? slug} syncs on this Mac. Shared/All still only changes the remembered local footprint, not access.`,
  );
</script>

<span class="sidebar-sync-mode" class:saving title={wrapperTitle} data-testid="sidebar-sync-mode">
  <label class="sidebar-sync-enabled" class:off={!enabledState}>
    <input type="checkbox" checked={enabledState} onchange={toggleEnabled} />
    <span>{enabledState ? 'On' : 'Off'}</span>
  </label>

  {#if !isPersonal && enabledState}
    {#if mode === null && !modeError}
      <span class="sidebar-sync-mode-loading" aria-hidden="true">...</span>
    {:else if mode === 'custom'}
      <span
        class="sidebar-sync-mode-custom"
        title="Custom paths - managed via `hq sync mode custom`"
      >
        custom
      </span>
    {:else if modeError}
      <button
        type="button"
        class="sidebar-sync-mode-error"
        title={`${modeError} - click to retry`}
        onclick={retryLoad}
      >
        -
      </button>
    {:else if mode !== null}
      <button
        type="button"
        class="sidebar-sync-mode-opt"
        class:active={mode === 'shared'}
        disabled={!cloudReachable || saving}
        aria-pressed={mode === 'shared'}
        onclick={(e) => setMode('shared', e)}
      >
        Shared
      </button>
      <button
        type="button"
        class="sidebar-sync-mode-opt"
        class:active={mode === 'all'}
        disabled={!cloudReachable || saving}
        aria-pressed={mode === 'all'}
        onclick={(e) => setMode('all', e)}
      >
        All
      </button>
    {/if}
  {/if}
</span>

<style>
  .sidebar-sync-mode {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    padding: 2px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-chrome);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--v4-hairline);
    flex-shrink: 0;
    font-family: var(--font-sans);
  }

  .sidebar-sync-enabled {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-2);
    font-size: var(--text-sm);
    line-height: 1;
    cursor: pointer;
    user-select: none;
  }

  .sidebar-sync-enabled.off {
    color: var(--v4-text-3);
  }

  .sidebar-sync-enabled input {
    width: 12px;
    height: 12px;
    margin: 0;
    accent-color: var(--v4-primary-fg);
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
