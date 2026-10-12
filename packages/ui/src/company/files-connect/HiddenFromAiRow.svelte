<script lang="ts">
  /**
   * US-005: the "Hidden from AI" row inside the connected-app detail pane.
   * One switch per redaction preset. Owners and admins can change them;
   * members see the same switches read-only. A switch flips and shows
   * "Saving…" the moment it is pressed, and goes back with a plain error line
   * if the save fails. Server text is never shown.
   */
  import { untrack } from "svelte";
  import {
    EMPTY_ROW_STATE,
    withFailed,
    withSaved,
    withToggle,
    type RedactionAppRef,
    type RedactionPresetsApi,
    type RedactionRowState,
  } from "./redaction-presets.js";

  interface Props {
    api: RedactionPresetsApi;
    companyUid: string;
    app: RedactionAppRef;
    appName: string;
    canEdit: boolean;
  }

  let { api, companyUid, app, appName, canEdit }: Props = $props();
  // Reload only when the app itself changes, not on every parent re-render.
  const appKey = $derived(app.key);

  let row = $state<RedactionRowState>(EMPTY_ROW_STATE);
  let loadFailed = $state(false);

  async function load(uid: string, key: string, alive: () => boolean): Promise<void> {
    row = EMPTY_ROW_STATE;
    loadFailed = false;
    try {
      const settings = await api.load(uid, { key, connectionIds: [...app.connectionIds] });
      if (!alive()) return;
      row = { settings, pending: new Set(), error: null };
    } catch (err) {
      console.warn("[redaction] presets read failed:", err);
      if (!alive()) return;
      loadFailed = true;
    }
  }

  $effect(() => {
    const uid = companyUid;
    const key = appKey;
    let active = true;
    untrack(() => void load(uid, key, () => active && uid === companyUid && key === appKey));
    return () => {
      active = false;
    };
  });

  async function toggle(presetId: string, previous: boolean): Promise<void> {
    if (!canEdit || row.pending.has(presetId)) return;
    const uid = companyUid;
    const key = appKey;
    const next = !previous;
    row = withToggle(row, presetId, next);
    try {
      const saved = await api.set(uid, { key, connectionIds: [...app.connectionIds] }, presetId, next);
      if (uid !== companyUid || key !== appKey) return;
      row = withSaved(row, presetId, saved);
    } catch (err) {
      console.warn("[redaction] preset save failed:", err);
      if (uid !== companyUid || key !== appKey) return;
      row = withFailed(row, presetId, previous);
    }
  }

  function retryLoad(): void {
    const uid = companyUid;
    const key = appKey;
    void load(uid, key, () => uid === companyUid && key === appKey);
  }
</script>

<section class="hidden-ai" data-testid="redaction-row" aria-labelledby="redaction-row-title">
  <div class="head">
    <h3 id="redaction-row-title">Hidden from AI</h3>
    <p class="hint">
      {canEdit
        ? `HQ removes these from ${appName} data before an AI tool sees it.`
        : `HQ removes these from ${appName} data before an AI tool sees it. Only owners and admins can change this.`}
    </p>
  </div>
  {#if loadFailed}
    <p class="note" role="alert" data-testid="redaction-load-error">
      Couldn't load these settings.
      <button type="button" class="retry" data-testid="redaction-retry" onclick={retryLoad}>Try again</button>
    </p>
  {:else if !row.settings}
    <p class="note" role="status" aria-live="polite" data-testid="redaction-loading">Loading…</p>
  {:else}
    <ul class="presets">
      {#each row.settings.presets as preset (preset.id)}
        {@const pending = row.pending.has(preset.id)}
        <li class="preset" data-testid="redaction-preset" data-preset={preset.id}>
          <span class="label">{preset.label}</span>
          {#if pending}<span class="status" role="status" aria-live="polite" data-testid="redaction-pending">Saving…</span>{/if}
          <button
            type="button"
            class="toggle"
            class:on={preset.enabled}
            role="switch"
            aria-checked={preset.enabled}
            aria-label={preset.label}
            aria-busy={pending}
            aria-readonly={!canEdit}
            disabled={!canEdit || pending}
            data-testid="redaction-toggle"
            onclick={() => void toggle(preset.id, preset.enabled)}
          ></button>
        </li>
      {/each}
    </ul>
    {#if row.error}<p class="note" role="alert" data-testid="redaction-save-error">{row.error}</p>{/if}
  {/if}
</section>

<style>
  .hidden-ai {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line, var(--v4-rowline));
  }
  h3 {
    margin: 0;
    color: var(--t1, var(--v4-text-1));
    font-size: 13px;
    font-weight: 500;
  }
  .hint {
    margin: 2px 0 0;
    color: var(--t2, var(--v4-text-2));
    font-size: 12px;
    line-height: 1.45;
  }
  .presets {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .preset {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
  }
  .label {
    min-width: 0;
    color: var(--t1, var(--v4-text-1));
    font-size: 12.5px;
  }
  .status,
  .note {
    color: var(--t3, var(--v4-text-3));
    font-size: 11px;
  }
  .status {
    margin-left: auto;
  }
  .note {
    margin: 0;
  }
  .toggle {
    position: relative;
    flex: 0 0 34px;
    width: 34px;
    height: 20px;
    margin-left: auto;
    padding: 0;
    border: none;
    border-radius: 10px;
    background: var(--line2, var(--v4-control-border, rgba(255, 255, 255, 0.16)));
    cursor: pointer;
  }
  .status + .toggle {
    margin-left: 0;
  }
  .toggle::after {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--t2, var(--v4-text-2));
    content: "";
    transition: transform 0.15s;
  }
  .toggle.on {
    background: #2a3644;
  }
  .toggle.on::after {
    transform: translateX(14px);
    background: var(--ice, #c9d6e4);
  }
  .toggle:focus-visible,
  .retry:focus-visible {
    outline: 1px solid var(--ice, #c9d6e4);
    outline-offset: 2px;
  }
  .toggle:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .toggle[aria-busy="true"] {
    opacity: 0.8;
  }
  .retry {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
