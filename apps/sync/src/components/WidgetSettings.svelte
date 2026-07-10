<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';

  type DisplayInfo = { name: string; primary: boolean };

  let widgetEnabled = $state(true);
  let widgetDisplay = $state<string | null>(null);
  let displays = $state<DisplayInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

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
      error = String(err);
    } finally {
      loading = false;
    }
  }

  /**
   * Read-modify-write so unrelated menubar.json keys are never clobbered.
   * `apply_widget_settings` must run after save so the window closes/creates/
   * re-anchors immediately (escape hatch: OFF restores native notifications).
   */
  async function persist(partial: { widgetEnabled?: boolean; widgetDisplay?: string | null }) {
    const prefs = await invoke<Record<string, unknown>>('get_settings');
    await invoke('save_settings', {
      prefs: { ...prefs, widgetEnabled, widgetDisplay, ...partial },
    });
    await invoke('apply_widget_settings');
  }

  async function handleToggle() {
    const previous = widgetEnabled;
    widgetEnabled = !widgetEnabled;
    error = null;
    try {
      await persist({ widgetEnabled });
    } catch (err) {
      widgetEnabled = previous;
      error = String(err);
    }
  }

  async function handleDisplayChange(event: Event) {
    const previous = widgetDisplay;
    const value = (event.currentTarget as HTMLSelectElement).value;
    widgetDisplay = value === '' ? null : value;
    error = null;
    try {
      await persist({ widgetDisplay });
    } catch (err) {
      widgetDisplay = previous;
      error = String(err);
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

  /* macOS-style switch — pattern from Settings.svelte, theme-agnostic colors */
  .toggle {
    position: relative;
    width: 36px;
    height: 20px;
    padding: 0;
    background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12));
    border-radius: 10px;
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
    flex-shrink: 0;
  }

  .toggle.active {
    background: light-dark(#1d1d1f, #ffffff);
    border-color: light-dark(#1d1d1f, #ffffff);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: #ffffff;
    border-radius: 50%;
    transition: transform 0.2s ease;
    pointer-events: none;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .toggle.active .toggle-knob {
    transform: translateX(16px);
    background: light-dark(#ffffff, #111113);
    box-shadow: none;
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
    border-radius: 9px;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg width='8' height='6' viewBox='0 0 8 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%23888' stroke-width='1.2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    flex-shrink: 0;
  }

  .display-picker:focus {
    outline: none;
    border-color: light-dark(rgba(0, 0, 0, 0.22), rgba(255, 255, 255, 0.22));
  }

  .error-line {
    margin: 0;
    padding: 6px 12px 10px;
    font-size: 0.6875rem;
    line-height: 1.3;
    color: light-dark(#c0392b, #ff6b6b);
  }
</style>
