<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { updateSettings } from '../lib/settings-mutations';

  type DisplayInfo = { name: string; primary: boolean };

  interface Props {
    /** Parent Settings already owns the same get_settings failure surface. */
    showLoadError?: boolean;
  }

  let { showLoadError = true }: Props = $props();

  let widgetEnabled = $state(true);
  let widgetDisplay = $state<string | null>(null);
  let displays = $state<DisplayInfo[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let loadError = $state<string | null>(null);

  /** True when the stored display name is no longer among returned monitors. */
  const disconnectedDisplay = $derived(
    widgetDisplay && !displays.some((d) => d.name === widgetDisplay) ? widgetDisplay : null,
  );

  $effect(() => {
    void load();
  });

  async function load() {
    loading = true;
    error = null;
    loadError = null;
    try {
      const [settings, displayList] = await Promise.all([
        invoke<{
          widgetEnabled?: boolean | null;
          widgetDisplay?: string | null;
        }>('get_settings'),
        invoke<DisplayInfo[]>('list_displays').catch(() => [] as DisplayInfo[]),
      ]);
      widgetEnabled = settings.widgetEnabled ?? true;
      widgetDisplay = settings.widgetDisplay ?? null;
      displays = displayList;
    } catch (err) {
      loadError = String(err);
    } finally {
      loading = false;
    }
  }

  /**
   * The shared mutation queue reads and merges the latest preferences so this
   * widget patch cannot clobber SettingsPage or VersionPopout changes.
   * `apply_widget_settings` must run after save so the window closes/creates/
   * re-anchors immediately (escape hatch: OFF restores native notifications).
   *
   * Save and apply are not one transaction: save failures throw tagged
   * `save` errors (handlers revert optimistic UI); apply failures throw tagged
   * `apply` errors (disk is already authoritative — keep value, reload).
   */
  async function persist(partial: { widgetEnabled?: boolean; widgetDisplay?: string | null }) {
    try {
      await updateSettings(partial);
    } catch (err) {
      throw { phase: 'save' as const, err };
    }
    try {
      await invoke('apply_widget_settings');
    } catch (err) {
      throw { phase: 'apply' as const, err };
    }
  }

  function isPhaseError(err: unknown, phase: 'save' | 'apply'): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'phase' in err &&
      (err as { phase: string }).phase === phase
    );
  }

  function errorMessage(err: unknown): string {
    if (typeof err === 'object' && err !== null && 'err' in err) {
      return String((err as { err: unknown }).err);
    }
    return String(err);
  }

  async function handleToggle() {
    if (loading || saving) return;
    const previous = widgetEnabled;
    widgetEnabled = !widgetEnabled;
    saving = true;
    error = null;
    try {
      await persist({ widgetEnabled });
    } catch (err) {
      if (isPhaseError(err, 'save')) {
        widgetEnabled = previous;
        error = errorMessage(err);
      } else {
        // Disk already has the new value; keep optimistic state and re-sync.
        // load() clears error — restore after so the apply failure stays visible.
        const msg = errorMessage(err);
        await load();
        error = msg;
      }
    } finally {
      saving = false;
    }
  }

  async function handleDisplayChange(event: Event) {
    if (loading || saving) return;
    const previous = widgetDisplay;
    const value = (event.currentTarget as HTMLSelectElement).value;
    widgetDisplay = value === '' ? null : value;
    saving = true;
    error = null;
    try {
      await persist({ widgetDisplay });
    } catch (err) {
      if (isPhaseError(err, 'save')) {
        widgetDisplay = previous;
        error = errorMessage(err);
      } else {
        // Disk already has the new value; keep optimistic state and re-sync.
        // load() clears error — restore after so the apply failure stays visible.
        const msg = errorMessage(err);
        await load();
        error = msg;
      }
    } finally {
      saving = false;
    }
  }
</script>

<div class="widget-settings" data-loading={loading || undefined}>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Desktop widget</span>
      <span class="setting-desc">Show the floating hq mark and its notifications on your desktop</span>
    </div>
    <button
      type="button"
      class="toggle"
      class:active={widgetEnabled}
      onclick={handleToggle}
      disabled={loading || saving}
      role="switch"
      aria-checked={widgetEnabled}
      aria-label="Desktop widget"
      data-testid="widget-toggle"
    >
      <span class="toggle-knob"></span>
    </button>
  </div>

  {#if widgetEnabled}
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-label">Widget display</span>
        <span class="setting-desc">Which screen the widget anchors to (lower-right)</span>
      </div>
      <select
        class="display-picker"
        data-testid="widget-display-picker"
        aria-label="Widget display"
        value={widgetDisplay ?? ''}
        onchange={handleDisplayChange}
        disabled={loading || saving}
      >
        <option value="">Primary (default)</option>
        {#each displays as display (display.name)}
          <option value={display.name}>
            {display.primary ? `${display.name} (primary)` : display.name}
          </option>
        {/each}
        {#if disconnectedDisplay}
          <option value={disconnectedDisplay}>{disconnectedDisplay} (disconnected)</option>
        {/if}
      </select>
    </div>
  {/if}

  {#if error}
    <p class="error-line" role="alert">{error}</p>
  {:else if loadError && showLoadError}
    <p class="error-line" role="alert">{loadError}</p>
  {/if}
</div>

<style>
  .widget-settings {
    display: block;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 48px;
    padding: 10px 12px;
  }

  .setting-row + .setting-row {
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .setting-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: light-dark(rgba(0, 0, 0, 0.88), rgba(255, 255, 255, 0.92));
    cursor: default;
  }

  .setting-desc {
    font-size: 0.6875rem;
    color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.55));
    line-height: 1.3;
  }

  /* Match the compact semantic switch used by the surrounding Settings page. */
  .toggle {
    position: relative;
    width: 26px;
    height: 16px;
    padding: 0;
    background: var(--v4-control-bg, light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)));
    border: 0;
    border-radius: var(--v4-radius-pill, 999px);
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
    flex-shrink: 0;
  }

  .toggle.active {
    background: var(--v4-ok, #30c866);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: var(--c-bg, light-dark(#ffffff, #111111));
    border-radius: 50%;
    transition: transform 0.2s ease;
    pointer-events: none;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .toggle.active .toggle-knob {
    transform: translateX(10px);
    box-shadow: none;
  }

  .toggle:focus-visible,
  .display-picker:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border, currentColor));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .toggle:disabled,
  .display-picker:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .display-picker {
    font-size: 0.8125rem;
    font-family: inherit;
    max-width: 12rem;
    min-width: 0;
    padding: 0.375rem 1.75rem 0.375rem 0.5rem;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    color: light-dark(rgba(0, 0, 0, 0.88), rgba(255, 255, 255, 0.92));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
    border-radius: var(--radius-field, 6px);
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg width='8' height='6' viewBox='0 0 8 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%23888' stroke-width='1.2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    flex-shrink: 0;
  }

  .display-picker:focus-visible {
    border-color: light-dark(rgba(0, 0, 0, 0.22), rgba(255, 255, 255, 0.22));
  }

  .error-line {
    margin: 0;
    padding: 6px 12px 10px;
    font-size: 0.6875rem;
    line-height: 1.3;
    color: light-dark(#c0392b, #ff6b6b);
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle,
    .toggle-knob {
      transition: none;
    }
  }
</style>
