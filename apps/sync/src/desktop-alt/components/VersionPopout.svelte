<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

  interface Props {
    version: string;
    onOpenSettings: () => void;
    onclose: () => void;
  }

  interface UpdateInfo {
    version: string;
    body?: string;
    date?: string;
  }

  let { version, onOpenSettings, onclose }: Props = $props();

  /** null = no newer version known; string = latest available from check/event. */
  let latestVersion = $state<string | null>(null);
  /** Transient / install lifecycle beyond the basic available/up-to-date split. */
  let phase = $state<'idle' | 'checking' | 'downloading' | 'ready' | 'error'>('idle');
  let errorMessage = $state<string | null>(null);
  let autoUpdate = $state(true);
  let autoUpdateLoading = $state(true);
  let autoUpdateSaving = $state(false);

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
    Boolean(latestVersion) && phase !== 'downloading' && phase !== 'checking',
  );

  $effect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    // Register the listener FIRST (no awaits before it) so an
    // `update:available` fired while other hydration calls are in flight
    // is never missed.
    void (async () => {
      try {
        const fn = await listen<UpdateInfo>('update:available', (event) => {
          if (cancelled) return;
          const next = event.payload?.version;
          if (!next) return;
          latestVersion = next;
          if (phase === 'error') {
            phase = 'idle';
            errorMessage = null;
          }
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (err) {
        console.error('version-popout: failed to listen for update:available', err);
      }
    })();

    // Hydrate an update the background checker already found — without
    // this, an update detected before the pop-out opened would read
    // "Up to date" until a manual check.
    void (async () => {
      try {
        const pending = await invoke<UpdateInfo | null>('get_pending_update');
        if (!cancelled && pending?.version) {
          latestVersion = pending.version;
        }
      } catch (err) {
        console.error('get_pending_update failed:', err);
      }
    })();

    void (async () => {
      try {
        const prefs = await invoke<{ autoUpdate?: boolean | null }>('get_settings');
        if (!cancelled) {
          autoUpdate = prefs?.autoUpdate ?? true;
        }
      } catch {
        if (!cancelled) autoUpdate = true;
      } finally {
        if (!cancelled) autoUpdateLoading = false;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  });

  async function handleCheckForUpdates() {
    if (phase === 'checking' || phase === 'downloading') return;
    phase = 'checking';
    errorMessage = null;
    try {
      const info = await invoke<UpdateInfo | null>('check_for_updates');
      if (info?.version) {
        latestVersion = info.version;
        phase = 'idle';
      } else {
        latestVersion = null;
        phase = 'idle';
      }
    } catch (err) {
      console.error('check_for_updates failed:', err);
      errorMessage = 'Check failed';
      phase = 'error';
    }
  }

  async function handleRestartToUpdate() {
    if (phase === 'downloading' || !latestVersion) return;
    phase = 'downloading';
    errorMessage = null;
    try {
      // Backend re-runs updater.check() inside install_update; on macOS the
      // process is usually replaced before this promise resolves.
      await invoke('install_update');
      // Returned without restarting — prompt the user to apply.
      phase = 'ready';
    } catch (err) {
      console.error('install_update failed:', err);
      errorMessage = 'Install failed';
      phase = 'error';
    }
  }

  async function handleToggleAutoUpdate() {
    if (autoUpdateLoading || autoUpdateSaving) return;
    const previous = autoUpdate;
    const next = !autoUpdate;
    autoUpdate = next;
    autoUpdateSaving = true;
    try {
      // Read-modify-write the FULL prefs object — never save a partial.
      const prefs = await invoke<Record<string, unknown>>('get_settings');
      await invoke('save_settings', { prefs: { ...prefs, autoUpdate: next } });
    } catch (err) {
      console.error('save_settings (autoUpdate) failed:', err);
      autoUpdate = previous;
    } finally {
      autoUpdateSaving = false;
    }
  }

  function handleOpenSettings() {
    onOpenSettings();
    onclose();
  }
</script>

<div
  class="version-popout"
  data-testid="version-popout"
  role="dialog"
  aria-label="Version and updates"
>
  <div class="vp-rows">
    <div class="vp-row">
      <span class="vp-label">Current</span>
      <span class="vp-value mono" data-testid="version-popout-current">v{version}</span>
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

  <div class="vp-actions">
    <button
      type="button"
      class="vp-btn"
      data-testid="version-popout-check"
      disabled={phase === 'checking' || phase === 'downloading'}
      onclick={handleCheckForUpdates}
    >
      {phase === 'checking' ? 'Checking…' : 'Check for updates'}
    </button>

    {#if showRestart}
      <button
        type="button"
        class="vp-btn vp-btn-primary"
        data-testid="version-popout-restart"
        disabled={phase === 'downloading'}
        onclick={handleRestartToUpdate}
      >
        {phase === 'downloading' ? 'Downloading…' : 'Restart to update'}
      </button>
    {/if}
  </div>

  <div class="vp-divider" aria-hidden="true"></div>

  <label class="vp-toggle-row">
    <span class="vp-toggle-copy">
      <strong>Automatic updates</strong>
      <small>Install app updates in the background</small>
    </span>
    <input
      type="checkbox"
      data-testid="version-popout-auto-toggle"
      checked={autoUpdate}
      disabled={autoUpdateLoading || autoUpdateSaving}
      onchange={handleToggleAutoUpdate}
      aria-label="Automatic updates"
    />
  </label>

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
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    z-index: 200;
    width: 260px;
    padding: 12px;
    border: 1px solid var(--border-strong, var(--pop-border, rgba(120, 120, 128, 0.3)));
    border-radius: 10px;
    background: var(--surface-panel, var(--pop-bg, rgba(38, 38, 40, 0.96)));
    box-shadow: var(--pop-shadow, 0 12px 32px rgba(0, 0, 0, 0.18));
    color: var(--fg, var(--c-text, inherit));
    font-size: var(--text-xs, 13px);
    line-height: 1.35;
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

  .vp-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
  }

  .vp-toggle-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
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
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    accent-color: var(--fg);
    cursor: pointer;
  }

  .vp-toggle-row input[type='checkbox']:disabled {
    cursor: default;
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
</style>
