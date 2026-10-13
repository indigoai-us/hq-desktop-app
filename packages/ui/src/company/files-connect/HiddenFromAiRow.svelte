<script lang="ts">
  /**
   * US-005: the "Hidden from AI" row under one connection in the connected-app
   * detail pane, on the US-004 hq-pro contract. Four switches, one per preset.
   * Owners and admins can change them when the server's `canEdit` agrees;
   * everyone else sees them read-only. A switch flips and shows "Saving…" the
   * moment it is pressed; a refused PUT flips it back with a short line.
   * Server text is never shown.
   */
  import { untrack } from "svelte";
  import {
    EMPTY_ROW_STATE,
    enabledPresetIds,
    isRedactionUnsupported,
    loadFailureLine,
    rowCanEdit,
    withFailed,
    withSaved,
    withToggle,
    type RedactionPresetId,
    type RedactionPresetsApi,
    type RedactionRowState,
  } from "./redaction-presets.js";

  interface Props {
    api: RedactionPresetsApi;
    companyUid: string;
    connectionId: string;
    appName: string;
    /** Role rule from the admin surface (owners and admins). */
    canEdit: boolean;
  }

  let { api, companyUid, connectionId, appName, canEdit }: Props = $props();
  const titleId = $derived(`redaction-title-${connectionId}`);

  let row = $state<RedactionRowState>(EMPTY_ROW_STATE);
  let loadError = $state<string | null>(null);
  // hq-pro without the US-004 route: show nothing rather than an error.
  let unsupported = $state(false);
  const editable = $derived(rowCanEdit(canEdit, row.settings));

  async function load(uid: string, conn: string, alive: () => boolean): Promise<void> {
    row = EMPTY_ROW_STATE;
    loadError = null;
    unsupported = false;
    try {
      const settings = await api.load(uid, conn);
      if (!alive()) return;
      row = { settings, pending: new Set(), error: null };
    } catch (err) {
      if (!alive()) return;
      if (isRedactionUnsupported(err)) {
        unsupported = true;
        return;
      }
      console.warn("[redaction] presets read failed:", err);
      loadError = loadFailureLine(err);
    }
  }

  $effect(() => {
    const uid = companyUid;
    const conn = connectionId;
    let active = true;
    untrack(() => void load(uid, conn, () => active && uid === companyUid && conn === connectionId));
    return () => {
      active = false;
    };
  });

  async function toggle(presetId: RedactionPresetId, previous: boolean): Promise<void> {
    if (!editable || row.pending.has(presetId) || !row.settings) return;
    const uid = companyUid;
    const conn = connectionId;
    row = withToggle(row, presetId, !previous);
    // The PUT replaces the whole list, so send everything the row shows as on.
    const enabled = enabledPresetIds(row.settings!);
    try {
      const saved = await api.save(uid, conn, enabled);
      if (uid !== companyUid || conn !== connectionId) return;
      row = withSaved(row, presetId, saved);
    } catch (err) {
      console.warn("[redaction] preset save failed:", err);
      if (uid !== companyUid || conn !== connectionId) return;
      row = withFailed(row, presetId, previous, err);
    }
  }

  function retryLoad(): void {
    const uid = companyUid;
    const conn = connectionId;
    void load(uid, conn, () => uid === companyUid && conn === connectionId);
  }
</script>

{#if !unsupported}
<section class="hidden-ai" data-testid="redaction-row" data-connection={connectionId} aria-labelledby={titleId}>
  <div class="head">
    <h3 id={titleId}>Hidden from AI</h3>
    <p class="hint">
      {editable || !row.settings
        ? `HQ removes these from ${appName} data before an AI tool sees it.`
        : `HQ removes these from ${appName} data before an AI tool sees it. Only owners and admins can change this.`}
    </p>
  </div>
  {#if loadError}
    <p class="note" role="alert" data-testid="redaction-load-error">
      {loadError}
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
            aria-readonly={!editable}
            disabled={!editable || pending}
            data-testid="redaction-toggle"
            onclick={() => void toggle(preset.id, preset.enabled)}
          ></button>
        </li>
      {/each}
    </ul>
    {#if row.error}<p class="note" role="alert" data-testid="redaction-save-error">{row.error}</p>{/if}
  {/if}
</section>
{/if}

<style>
  .hidden-ai {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
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
