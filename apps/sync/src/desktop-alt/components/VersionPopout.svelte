<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { updateSettings } from '../../lib/settings-mutations';
  import {
    resolvePendingUpdateState,
    type PendingUpdateState,
  } from '../../lib/notificationFeedData';
  import type { SettingsTab } from '../route';

  interface Props {
    version: string;
    onOpenSettings: (tab?: SettingsTab) => void;
    onclose: () => void;
    placement?: 'above' | 'below';
  }

  interface UpdateInfo {
    version: string;
    body?: string;
    date?: string;
  }

  interface CoreState {
    channel: 'release' | 'staging';
    targetVersion: string;
    localVersion: string | null;
    versionBehind: boolean;
    driftReport: { count: number };
  }

  let { version, onOpenSettings, onclose, placement = 'above' }: Props = $props();

  /** null = no newer version known; string = latest available from check/event. */
  let latestVersion = $state<string | null>(null);
  /** Transient / install lifecycle beyond the basic available/up-to-date split. */
  let phase = $state<'idle' | 'checking' | 'downloading' | 'ready' | 'error'>('idle');
  let errorMessage = $state<string | null>(null);
  // Null means no preference has been confirmed yet. Pending and failed writes
  // are separate so the last trusted setting survives every retry path.
  let autoUpdate = $state<boolean | null>(null);
  let autoUpdateLoading = $state(true);
  let autoUpdateSaving = $state(false);
  let pendingAutoUpdate = $state<boolean | null>(null);
  let failedAutoUpdate = $state<boolean | null>(null);
  let autoUpdateLoadError = $state<string | null>(null);
  let autoUpdateSaveError = $state<string | null>(null);
  let autoUpdateLoadGeneration = 0;
  let autoUpdateSaveGeneration = 0;
  let updateLoadGeneration = 0;
  let installActionGeneration = 0;
  let updaterDisposed = false;
  let coreVersion = $state<string | null>(null);
  let coreVersionLoading = $state(true);
  let coreVersionError = $state(false);
  let coreState = $state<CoreState | null>(null);
  let coreStateLoading = $state(true);
  let coreStateError = $state(false);
  let coreLoadGeneration = 0;

  const statusLabel = $derived.by(() => {
    if (phase === 'checking') return 'Checking…';
    if (phase === 'downloading') return 'Downloading…';
    if (phase === 'ready') return 'Restart to apply';
    if (phase === 'error') return errorMessage ?? 'Check failed';
    if (latestVersion) return 'Update available';
    return 'Up to date';
  });

  const latestDisplay = $derived(latestVersion ?? version);
  const showRestart = $derived(
    Boolean(latestVersion) && phase !== 'checking',
  );
  const displayedAutoUpdate = $derived(pendingAutoUpdate ?? autoUpdate ?? false);
  const coreVersionDisplay = $derived.by(() => {
    if (coreVersionLoading) return 'Reading…';
    if (coreVersion) return `v${coreVersion}`;
    return coreVersionError ? 'Unavailable' : 'Not detected';
  });
  const coreStatusLabel = $derived.by(() => {
    if (coreStateLoading) return 'Checking channel status…';
    if (coreStateError) return 'Channel status unavailable';
    if (!coreState) {
      return coreVersion
        ? 'Installed locally · Channel status unavailable'
        : 'HQ folder metadata needs attention';
    }
    const channel = coreState.channel === 'staging' ? 'Staging' : 'Release';
    if (coreState.versionBehind) {
      return `${channel} · Update available to v${coreState.targetVersion}`;
    }
    const driftCount = coreState.driftReport?.count ?? 0;
    if (driftCount > 0) {
      return `${channel} · ${driftCount} drifted ${driftCount === 1 ? 'file' : 'files'}`;
    }
    return `${channel} · Up to date`;
  });
  const checkingAnyUpdate = $derived(
    phase === 'checking' || coreVersionLoading || coreStateLoading,
  );

  $effect(() => {
    updaterDisposed = false;
    let cancelled = false;
    let unlistenAvailable: UnlistenFn | undefined;
    let unlistenCleared: UnlistenFn | undefined;

    // Register the listener FIRST (no awaits before it) so an
    // `update:available` fired while other hydration calls are in flight
    // is never missed.
    const reportListenerError = (reason: unknown) => {
      console.error(
        'version-popout: failed to listen for updater state',
        reason,
      );
    };
    const retainListener = (
      register: () => Promise<UnlistenFn>,
      retain: (unlisten: UnlistenFn) => void,
    ) => {
      try {
        void register()
          .then((unlisten) => {
            if (cancelled) {
              unlisten();
              return;
            }
            retain(unlisten);
          })
          .catch(reportListenerError);
      } catch (reason) {
        reportListenerError(reason);
      }
    };

    retainListener(
      () =>
        listen<UpdateInfo>('update:available', (event) => {
          if (cancelled) return;
          const next = event.payload?.version;
          if (!next) return;
          updateLoadGeneration += 1;
          // install_update announces the same version again immediately before
          // downloading it. Preserve that action, but let a different native
          // version supersede every eventual completion from the older install.
          const sameInstall =
            phase === 'downloading' && latestVersion === next;
          if (!sameInstall) installActionGeneration += 1;
          latestVersion = next;
          errorMessage = null;
          if (phase !== 'downloading') {
            phase = 'idle';
          }
        }),
      (unlisten) => {
        unlistenAvailable = unlisten;
      },
    );
    retainListener(
      () =>
        listen('update:cleared', () => {
          if (cancelled) return;
          updateLoadGeneration += 1;
          installActionGeneration += 1;
          latestVersion = null;
          phase = 'idle';
          errorMessage = null;
        }),
      (unlisten) => {
        unlistenCleared = unlisten;
      },
    );

    // Hydrate an update the background checker already found — without
    // this, an update detected before the pop-out opened would read
    // "Up to date" until a manual check.
    void (async () => {
      const generation = ++updateLoadGeneration;
      try {
        const pending = await invoke<PendingUpdateState | UpdateInfo | null>(
          'get_pending_update',
        );
        if (cancelled || generation !== updateLoadGeneration) return;
        const resolved = resolvePendingUpdateState(pending);
        if (resolved.state === 'resolved') {
          latestVersion = resolved.value?.version ?? null;
        }
      } catch (err) {
        if (cancelled || generation !== updateLoadGeneration) return;
        console.error('get_pending_update failed:', err);
      }
    })();

    void loadAutoUpdate();

    // The installed Core identity is a cheap local read; channel state may
    // involve a slower scan/network lookup. refreshCoreInfo commits each one
    // independently so the version never waits behind the state scan.
    void refreshCoreInfo();

    return () => {
      cancelled = true;
      updaterDisposed = true;
      updateLoadGeneration += 1;
      installActionGeneration += 1;
      coreLoadGeneration += 1;
      autoUpdateLoadGeneration += 1;
      autoUpdateSaveGeneration += 1;
      unlistenAvailable?.();
      unlistenCleared?.();
    };
  });

  async function loadAutoUpdate() {
    const generation = ++autoUpdateLoadGeneration;
    autoUpdateLoading = true;
    autoUpdateLoadError = null;
    try {
      const prefs = await invoke<{ autoUpdate?: boolean | null }>('get_settings');
      if (generation !== autoUpdateLoadGeneration) return;
      autoUpdate = prefs?.autoUpdate ?? true;
    } catch (err) {
      if (generation !== autoUpdateLoadGeneration) return;
      console.error('version-popout: automatic update preference load failed', err);
      // Preserve a previously trusted value when a refresh fails.
      autoUpdateLoadError = 'Couldn’t load the automatic update preference.';
    } finally {
      if (generation === autoUpdateLoadGeneration) {
        autoUpdateLoading = false;
      }
    }
  }

  async function refreshCoreInfo() {
    const generation = ++coreLoadGeneration;
    coreVersionLoading = true;
    coreStateLoading = true;
    coreVersionError = false;
    coreStateError = false;

    const versionRead = invoke<string | null>('get_hq_version')
      .then((value) => {
        if (generation !== coreLoadGeneration) return;
        coreVersion = value;
      })
      .catch((err) => {
        if (generation !== coreLoadGeneration) return;
        console.error('version-popout: HQ Core version refresh failed', err);
        coreVersion = null;
        coreVersionError = true;
      })
      .finally(() => {
        if (generation === coreLoadGeneration) coreVersionLoading = false;
      });

    const stateRead = invoke<CoreState | null>('check_core_state')
      .then((value) => {
        if (generation !== coreLoadGeneration) return;
        coreState = value;
      })
      .catch((err) => {
        if (generation !== coreLoadGeneration) return;
        console.error('version-popout: HQ Core state refresh failed', err);
        coreState = null;
        coreStateError = true;
      })
      .finally(() => {
        if (generation === coreLoadGeneration) coreStateLoading = false;
      });

    await Promise.allSettled([versionRead, stateRead]);
  }

  async function handleCheckForUpdates() {
    if (checkingAnyUpdate || phase === 'downloading') return;
    const generation = ++updateLoadGeneration;
    phase = 'checking';
    errorMessage = null;
    try {
      const [info] = await Promise.all([
        invoke<UpdateInfo | null>('check_for_updates'),
        refreshCoreInfo(),
      ]);
      if (generation !== updateLoadGeneration) return;
      if (info?.version) {
        latestVersion = info.version;
        phase = 'idle';
      } else {
        latestVersion = null;
        phase = 'idle';
      }
    } catch (err) {
      if (generation !== updateLoadGeneration) return;
      console.error('check_for_updates failed:', err);
      errorMessage = 'Check failed';
      phase = 'error';
    }
  }

  async function handleRestartToUpdate() {
    if (phase === 'downloading' || !latestVersion) return;
    const generation = ++installActionGeneration;
    phase = 'downloading';
    errorMessage = null;
    try {
      // Backend re-runs updater.check() inside install_update; on macOS the
      // process is usually replaced before this promise resolves.
      await invoke('install_update');
      if (updaterDisposed || generation !== installActionGeneration) return;
      // Returned without restarting — prompt the user to apply.
      phase = 'ready';
    } catch (err) {
      if (updaterDisposed || generation !== installActionGeneration) return;
      console.error('install_update failed:', err);
      errorMessage = 'Install failed';
      phase = 'error';
    } finally {
      // A different-version event keeps the native action visually busy until
      // its promise settles, then reveals the authoritative newer version. A
      // cleared event already moved the phase to idle and needs no further write.
      if (
        !updaterDisposed &&
        generation !== installActionGeneration &&
        phase === 'downloading'
      ) {
        phase = 'idle';
      }
    }
  }

  async function saveAutoUpdate(next: boolean) {
    if (autoUpdateLoading || autoUpdateSaving || autoUpdate === null) return;
    const trustedValue = autoUpdate;
    const generation = ++autoUpdateSaveGeneration;
    pendingAutoUpdate = next;
    autoUpdateSaving = true;
    autoUpdateSaveError = null;
    failedAutoUpdate = null;
    try {
      await updateSettings({ autoUpdate: next });
      if (generation !== autoUpdateSaveGeneration) return;
      autoUpdate = next;
    } catch (err) {
      if (generation !== autoUpdateSaveGeneration) return;
      console.error('save_settings (autoUpdate) failed:', err);
      autoUpdate = trustedValue;
      failedAutoUpdate = next;
      autoUpdateSaveError = 'Couldn’t save automatic updates.';
    } finally {
      if (generation === autoUpdateSaveGeneration) {
        pendingAutoUpdate = null;
        autoUpdateSaving = false;
      }
    }
  }

  function handleToggleAutoUpdate(event: Event) {
    if (autoUpdateLoading || autoUpdateSaving || autoUpdate === null) return;
    const next = (event.currentTarget as HTMLInputElement).checked;
    void saveAutoUpdate(next);
  }

  function retryAutoUpdateLoad() {
    if (autoUpdateLoading) return;
    void loadAutoUpdate();
  }

  function retryAutoUpdateSave() {
    if (failedAutoUpdate === null) return;
    void saveAutoUpdate(failedAutoUpdate);
  }

  function handleOpenSettings() {
    onOpenSettings('updates');
    onclose();
  }
</script>

<div
  class="version-popout"
  class:below={placement === 'below'}
  data-testid="version-popout"
  role="dialog"
  aria-label="Version and updates"
>
  <div class="vp-product">
    <div class="vp-product-heading">
      <strong>Desktop app</strong>
      <span class="vp-kind">APP</span>
    </div>
    <div class="vp-rows">
      <div class="vp-row">
        <span class="vp-label">Installed</span>
        <span class="vp-value mono" data-testid="version-popout-current">
          <span data-testid="version-popout-app-current">v{version}</span>
        </span>
      </div>
      <div class="vp-row">
        <span class="vp-label">Latest</span>
        <span class="vp-value mono" data-testid="version-popout-latest">v{latestDisplay}</span>
      </div>
      <div class="vp-row">
        <span class="vp-label">Status</span>
        <span class="vp-status" data-testid="version-popout-status">{statusLabel}</span>
      </div>
    </div>
  </div>

  <div class="vp-product core">
    <div class="vp-product-heading">
      <strong>HQ Core</strong>
      <span class="vp-kind core">CORE</span>
    </div>
    <div class="vp-rows">
      <div class="vp-row">
        <span class="vp-label">Installed</span>
        <span class="vp-value mono" data-testid="version-popout-core-current">
          {coreVersionDisplay}
        </span>
      </div>
      <div class="vp-core-status" data-testid="version-popout-core-status">
        {coreStatusLabel}
      </div>
    </div>
  </div>

  <div class="vp-actions">
    <button
      type="button"
      class="vp-btn"
      data-testid="version-popout-check"
      disabled={checkingAnyUpdate || phase === 'downloading'}
      aria-busy={checkingAnyUpdate}
      onclick={handleCheckForUpdates}
    >
      {#if checkingAnyUpdate}
        <span class="vp-inline-spinner" aria-hidden="true"></span>
        Checking app + Core…
      {:else}
        Check all updates
      {/if}
    </button>

    {#if showRestart}
      <button
        type="button"
        class="vp-btn vp-btn-primary"
        data-testid="version-popout-restart"
        disabled={phase === 'downloading'}
        aria-busy={phase === 'downloading'}
        onclick={handleRestartToUpdate}
      >
        {#if phase === 'downloading'}
          <span class="vp-inline-spinner" aria-hidden="true"></span>
          Downloading…
        {:else}
          Restart to update
        {/if}
      </button>
    {/if}
  </div>

  <div class="vp-divider" aria-hidden="true"></div>

  <div class="vp-toggle-block" aria-busy={autoUpdateLoading || autoUpdateSaving}>
    <div class="vp-toggle-row">
      <label
        class="vp-toggle-copy"
        for="version-popout-auto-toggle"
        id="version-popout-auto-description"
      >
        <strong>Automatic updates</strong>
        <small>Install app, HQ Core, and CLI updates in the background</small>
      </label>
      {#if autoUpdate !== null}
        <input
          id="version-popout-auto-toggle"
          type="checkbox"
          data-testid="version-popout-auto-toggle"
          checked={displayedAutoUpdate}
          disabled={autoUpdateLoading || autoUpdateSaving}
          onchange={handleToggleAutoUpdate}
          aria-label="Automatic updates"
          aria-describedby="version-popout-auto-description"
          aria-busy={autoUpdateSaving}
        />
      {:else if autoUpdateLoading}
        <span
          class="vp-toggle-state"
          data-testid="version-popout-auto-loading"
          role="status"
        >
          <span class="vp-inline-spinner" aria-hidden="true"></span>
          Reading…
        </span>
      {/if}
    </div>

    {#if autoUpdateSaving}
      <div class="vp-inline-feedback" data-testid="version-popout-auto-feedback" role="status">
        <span class="vp-inline-spinner" aria-hidden="true"></span>
        Saving automatic updates…
      </div>
    {:else if autoUpdateSaveError}
      <div
        class="vp-inline-feedback is-error"
        id="version-popout-auto-feedback"
        data-testid="version-popout-auto-feedback"
        role="alert"
      >
        <span>{autoUpdateSaveError}</span>
        <button
          type="button"
          class="vp-inline-retry"
          data-testid="version-popout-auto-retry"
          onclick={retryAutoUpdateSave}
        >
          Retry
        </button>
      </div>
    {:else if autoUpdateLoadError}
      <div
        class="vp-inline-feedback is-error"
        id="version-popout-auto-feedback"
        data-testid="version-popout-auto-feedback"
        role="alert"
      >
        <span>{autoUpdateLoadError}</span>
        <button
          type="button"
          class="vp-inline-retry"
          data-testid="version-popout-auto-retry"
          disabled={autoUpdateLoading}
          aria-busy={autoUpdateLoading}
          onclick={retryAutoUpdateLoad}
        >
          {autoUpdateLoading ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    {/if}
  </div>

  <button
    type="button"
    class="vp-settings-link"
    data-testid="version-popout-settings-link"
    onclick={handleOpenSettings}
  >
    All update settings
  </button>
</div>

<style>
  .version-popout {
    position: fixed;
    right: 12px;
    bottom: 40px;
    z-index: 10000;
    width: 320px;
    max-height: calc(100vh - 56px);
    overflow-y: auto;
    padding: 12px;
    border: 1px solid var(--border-strong, var(--pop-border, rgba(120, 120, 120, 0.3)));
    border-radius: var(--v4-radius-popover);
    opacity: 1;
    background: var(
      --v4-popover-strong,
      var(--v4-popover, var(--pop-bg, rgba(42, 42, 42, 0.86)))
    );
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, var(--pop-shadow)), inset 0 1px 0 var(--v4-glass-highlight);
    color: var(--fg, var(--c-text, inherit));
    font-size: var(--text-xs, 13px);
    line-height: 1.35;
  }

  .version-popout.below {
    top: 48px;
    bottom: auto;
  }

  .vp-product {
    display: grid;
    gap: 8px;
    padding: 2px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .vp-product + .vp-product {
    margin-top: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--border-strong);
  }

  .vp-product.core {
    background: transparent;
  }

  .vp-product-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .vp-product-heading strong {
    color: var(--fg);
    font-size: var(--text-sm, 13px);
    font-weight: 650;
  }

  .vp-kind {
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 0;
    border: 0;
    border-radius: 0;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.06em;
  }

  .vp-kind.core {
    color: var(--muted);
  }

  .vp-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .vp-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .vp-label {
    color: var(--muted);
    flex: 0 0 auto;
  }

  .vp-value,
  .vp-status {
    min-width: 0;
    text-align: right;
  }

  .vp-status {
    color: var(--fg);
  }

  .vp-core-status {
    overflow: hidden;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-mono);
    color: var(--fg-data, var(--fg));
  }

  .vp-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }

  .vp-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    min-height: 28px;
    padding: 4px 10px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--row-active);
    color: var(--fg);
    font: inherit;
    font-size: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .vp-btn:hover:not(:disabled) {
    background: var(--row-hover, var(--row-active));
  }

  .vp-btn:focus-visible,
  .vp-settings-link:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border, currentColor));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .vp-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .vp-btn-primary {
    background: var(--fg);
    border-color: var(--fg);
    color: var(--surface-panel);
  }

  .vp-btn-primary:hover:not(:disabled) {
    opacity: 0.9;
    background: var(--fg);
  }

  .vp-divider {
    height: 1px;
    margin: 12px 0;
    background: var(--border-strong);
  }

  .vp-toggle-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .vp-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .vp-toggle-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    cursor: pointer;
  }

  .vp-toggle-copy strong {
    font-size: inherit;
    font-weight: 600;
    color: var(--fg);
  }

  .vp-toggle-copy small {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.3;
  }

  .vp-toggle-row input[type='checkbox'] {
    appearance: none;
    -webkit-appearance: none;
    position: relative;
    flex: 0 0 auto;
    width: 26px;
    height: 16px;
    border: 0;
    border-radius: var(--v4-radius-pill, 999px);
    background: var(--v4-control-bg, var(--row-active));
    cursor: pointer;
  }

  .vp-toggle-row input[type='checkbox']::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: var(--v4-radius-pill, 999px);
    background: var(--c-bg, var(--surface-panel));
    box-shadow: var(--v4-shadow-card, 0 1px 2px rgba(0, 0, 0, 0.2));
    transition: transform 0.15s ease;
  }

  .vp-toggle-row input[type='checkbox']:checked {
    background: var(--v4-ok, #30c866);
  }

  .vp-toggle-row input[type='checkbox']:checked::after {
    transform: translateX(10px);
  }

  .vp-toggle-row input[type='checkbox']:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border, currentColor));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .vp-toggle-row input[type='checkbox']:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .vp-toggle-state,
  .vp-inline-feedback {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.35;
  }

  .vp-toggle-state {
    flex: 0 0 auto;
  }

  .vp-inline-feedback {
    justify-content: flex-start;
  }

  .vp-inline-feedback.is-error {
    color: var(--v4-error, var(--muted));
  }

  .vp-inline-retry {
    appearance: none;
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

  .vp-inline-retry:hover:not(:disabled) {
    border-bottom-color: transparent;
  }

  .vp-inline-retry:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border, currentColor));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .vp-inline-retry:disabled {
    cursor: progress;
    opacity: 0.55;
  }

  .vp-inline-spinner {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    border: 1px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: vp-spin 0.7s linear infinite;
  }

  @keyframes vp-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .vp-settings-link {
    display: block;
    width: 100%;
    margin-top: 10px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .vp-settings-link:hover {
    color: var(--fg);
    text-decoration: underline;
  }

  @media (prefers-reduced-transparency: reduce) {
    .version-popout {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: var(--v4-shadow-popover, var(--pop-shadow));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .vp-toggle-row input[type='checkbox']::after {
      transition: none;
    }

    .vp-inline-spinner {
      animation: none;
    }
  }
</style>
