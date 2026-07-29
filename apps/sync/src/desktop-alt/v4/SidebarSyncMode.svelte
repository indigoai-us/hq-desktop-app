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

  type SyncMutation =
    | { kind: 'enabled'; next: boolean }
    | { kind: 'mode'; next: 'all' | 'shared' };

  type SyncMutationFailure = SyncMutation & { message: string };

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

  let enabledState = $state(true);
  let mode = $state<'all' | 'shared' | 'custom' | null>(null);
  let pendingMutation = $state<SyncMutation | null>(null);
  let mutationFailure = $state<SyncMutationFailure | null>(null);
  let modeError = $state<string | null>(null);
  const saving = $derived(pendingMutation !== null);

  $effect.pre(() => {
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

  function mutationErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err.trim()) return err;
    return 'The sync preference could not be saved.';
  }

  async function applyEnabled(next: boolean, isRetry = false): Promise<void> {
    if (saving) return;
    const prev = enabledState;
    pendingMutation = { kind: 'enabled', next };
    if (!isRetry) mutationFailure = null;
    enabledState = next;
    try {
      await persistEnabled(next);
      onenabledchange?.(next);
      mutationFailure = null;
    } catch (err) {
      enabledState = prev;
      const msg = mutationErrorMessage(err);
      console.error(`set_workspace_sync_enabled(${slug}, ${next}) failed:`, msg);
      Sentry.captureException(err instanceof Error ? err : new Error(msg), {
        tags: { slug, action: 'set-workspace-sync-enabled', enabled: String(next) },
      });
      mutationFailure = { kind: 'enabled', next, message: msg };
    } finally {
      pendingMutation = null;
    }
  }

  async function toggleEnabled(event: Event): Promise<void> {
    event.stopPropagation();
    await applyEnabled(!enabledState);
  }

  async function applyMode(
    next: 'all' | 'shared',
    confirmReduction: boolean,
    isRetry = false,
  ): Promise<void> {
    if (!cloudReachable || saving || mode === next) return;
    // Reducing an All footprint can remove already-downloaded files that are
    // outside the member's Shared scope. Make that local consequence explicit
    // before writing the preference; unsynced edits remain protected by the
    // backend and are called out so this does not sound like data loss.
    if (confirmReduction && mode === 'all' && next === 'shared') {
      const confirmed = window.confirm(
        `Switch ${label ?? slug} to Shared? Files that are not shared with you may be removed from this Mac after the next sync. Unsynced edits are preserved.`,
      );
      if (!confirmed) return;
    }
    const prev = mode;
    pendingMutation = { kind: 'mode', next };
    if (!isRetry) mutationFailure = null;
    mode = next;
    try {
      const cfg = await invoke<MembershipSyncConfig>('set_sync_mode', {
        companySlug: slug,
        mode: next,
      });
      mode = cfg.syncMode;
      mutationFailure = null;
    } catch (err) {
      mode = prev;
      const msg = mutationErrorMessage(err);
      console.error(`set_sync_mode(${slug}, ${next}) failed:`, msg);
      Sentry.captureException(err instanceof Error ? err : new Error(msg), {
        tags: { slug, action: 'set-sync-mode', mode: next, source: 'frontend' },
      });
      mutationFailure = { kind: 'mode', next, message: msg };
    } finally {
      pendingMutation = null;
    }
  }

  async function setMode(next: 'all' | 'shared', event: MouseEvent): Promise<void> {
    event.stopPropagation();
    await applyMode(next, true);
  }

  async function retryMutation(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const failure = mutationFailure;
    if (!failure || saving) return;
    if (failure.kind === 'enabled') {
      await applyEnabled(failure.next, true);
    } else {
      // The operator already confirmed an All → Shared reduction before the
      // failed write. A network retry must not ask for the same consent twice.
      await applyMode(failure.next, false, true);
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

<span
  class="sidebar-sync-mode"
  class:saving
  title={wrapperTitle}
  data-testid="sidebar-sync-mode"
  aria-busy={saving}
>
  <label
    class="sidebar-sync-enabled"
    class:off={!enabledState}
    class:pending={pendingMutation?.kind === 'enabled'}
  >
    <input
      type="checkbox"
      checked={enabledState}
      onchange={toggleEnabled}
      disabled={saving}
      aria-busy={pendingMutation?.kind === 'enabled'}
    />
    <span>{pendingMutation?.kind === 'enabled' ? 'Saving…' : enabledState ? 'On' : 'Off'}</span>
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
        aria-busy={pendingMutation?.kind === 'mode' && pendingMutation.next === 'shared'}
        onclick={(e) => setMode('shared', e)}
      >
        {pendingMutation?.kind === 'mode' && pendingMutation.next === 'shared'
          ? 'Saving…'
          : 'Shared'}
      </button>
      <button
        type="button"
        class="sidebar-sync-mode-opt"
        class:active={mode === 'all'}
        disabled={!cloudReachable || saving}
        aria-pressed={mode === 'all'}
        aria-busy={pendingMutation?.kind === 'mode' && pendingMutation.next === 'all'}
        onclick={(e) => setMode('all', e)}
      >
        {pendingMutation?.kind === 'mode' && pendingMutation.next === 'all' ? 'Saving…' : 'All'}
      </button>
    {/if}
  {/if}
  {#if mutationFailure}
    <span
      class="sidebar-sync-mutation-error"
      role="alert"
      title={mutationFailure.message}
      data-testid="sidebar-sync-mutation-error"
    >
      <span>Failed</span>
      <button
        type="button"
        onclick={retryMutation}
        disabled={saving || (mutationFailure.kind === 'mode' && !cloudReachable)}
        aria-busy={saving}
      >
        {saving ? 'Retrying…' : 'Retry'}
      </button>
    </span>
  {/if}
</span>

<style>
  .sidebar-sync-mode {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
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
    cursor: progress;
  }

  .sidebar-sync-enabled.pending {
    opacity: 0.72;
  }

  .sidebar-sync-mode-opt {
    appearance: none;
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 400;
    line-height: 1;
    padding: 3px 4px 2px;
    border-radius: 0;
    cursor: pointer;
    transition:
      border-color 0.12s ease,
      color 0.12s ease;
  }

  .sidebar-sync-mode-opt:hover:not(:disabled):not(.active) {
    color: var(--v4-text-2);
  }

  .sidebar-sync-mode-opt.active {
    border-bottom-color: var(--v4-text-2);
    background: transparent;
    color: var(--v4-text-1);
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
    border-radius: 0;
  }

  .sidebar-sync-mode-error {
    appearance: none;
    border: 0;
    background: transparent;
    font: inherit;
    opacity: 0.6;
    cursor: pointer;
  }

  .sidebar-sync-mutation-error {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--v4-error);
    font-size: var(--text-sm);
    line-height: 1;
  }

  .sidebar-sync-mutation-error button {
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .sidebar-sync-mutation-error button:disabled {
    cursor: progress;
    opacity: 0.58;
  }
</style>
