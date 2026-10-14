<script lang="ts">
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import ControlDialog from "./ControlDialog.svelte";
  import type { CloudTabProps } from "./cloud-bot-tabs.js";
  import { brainFromPayload, controlError } from "./agent-control-model.js";

  let { uid, control, view, offline, onview, onoffline }: CloudTabProps = $props();

  const brain = $derived(view.brain);
  let picking = $state(false);
  let chosen = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  function openPicker(): void {
    chosen = brain.model;
    error = null;
    picking = true;
  }

  async function saveModel(): Promise<void> {
    if (busy || !chosen || chosen === brain.model) return;
    busy = true;
    error = null;
    const res = await control.setModel(uid, chosen);
    if (!res.ok) {
      busy = false;
      const e = controlError(res);
      if (e.offline) onoffline();
      error = e.message;
      return;
    }
    const read = await control.getBrain(uid);
    busy = false;
    if (!read.ok) {
      error = "Saved, but the bot did not read it back. Check again in a moment.";
      return;
    }
    const next = brainFromPayload(read.value);
    onview({ brain: next });
    if (next.model !== chosen) {
      error = "The bot did not keep the new model.";
      return;
    }
    picking = false;
  }
</script>

<section class="cp-section" data-testid="cloud-brain-model">
  <div class="cp-head">
    <span class="cp-label">Model</span>
    <button type="button" class="cp-btn cp-act" data-testid="cloud-brain-model-change" disabled={offline || brain.availableModels.length === 0} onclick={openPicker}><RailIcon name="sliders" />Change</button>
  </div>
  <dl class="cp-kv">
    <dt>In use</dt><dd class="cp-mono" data-testid="cloud-brain-model-value">{brain.model || "Not set"}</dd>
    {#if brain.provider}<dt>Provider</dt><dd>{brain.provider}</dd>{/if}
  </dl>
</section>

{#if picking}
  <ControlDialog title="Choose a model" subtitle={view.agent.displayName} dirty={chosen !== brain.model} {busy} testid="cloud-model-dialog" onclose={() => (picking = false)}>
    <div class="models" role="radiogroup" aria-label="Model">
      {#each brain.availableModels as model (model)}
        <label class="model" data-testid="cloud-model-option">
          <input type="radio" name="cloud-model" value={model} bind:group={chosen} />
          <span class="cp-mono">{model}</span>
          {#if model === brain.model}<span class="cp-count">Current</span>{/if}
        </label>
      {/each}
    </div>
    {#if error}<p class="cp-error" role="alert" data-testid="cloud-model-error">{error}</p>{/if}
    {#snippet footer()}
      <span class="cp-grow"></span>
      <button type="button" class="cp-btn primary" data-testid="cloud-model-save" disabled={busy || offline || !chosen || chosen === brain.model} onclick={() => void saveModel()}>
        {#if busy}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="save" />{/if}Save
      </button>
    {/snippet}
  </ControlDialog>
{/if}

<style>
  .models { display: flex; flex-direction: column; }
  .model {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 8px;
    border-radius: 6px;
    color: var(--v4-text-1);
    cursor: pointer;
  }
  .model:hover { background: var(--overlay-hover); }
  .model .cp-count { margin-left: auto; }
</style>
