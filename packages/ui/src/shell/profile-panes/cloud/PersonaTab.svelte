<script lang="ts">
  import type { AgentControlPersona, AgentControlPersonaPatch } from "@hq/platform";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import ControlDialog from "./ControlDialog.svelte";
  import type { CloudTabProps } from "./cloud-bot-tabs.js";
  import { controlError, personaFromPayload } from "./agent-control-model.js";

  let { uid, control, view, offline, onview, onoffline }: CloudTabProps = $props();

  let editing = $state(false);
  let draft = $state<AgentControlPersona>(personaFromPayload(null));
  let busy = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);

  const persona = $derived(view.persona);
  const displayName = $derived(persona.displayName || view.agent.displayName);
  const title = $derived(persona.title || view.agent.title);
  const dirty = $derived(
    editing &&
      (draft.displayName !== displayName ||
        draft.title !== title ||
        draft.description !== persona.description ||
        draft.instructions !== persona.instructions),
  );

  function openEdit(): void {
    draft = { ...persona, displayName, title };
    error = null;
    saved = false;
    editing = true;
  }

  function changes(): AgentControlPersonaPatch {
    const patch: AgentControlPersonaPatch = {};
    if (draft.displayName !== displayName) patch.displayName = draft.displayName.trim();
    if (draft.title !== title) patch.title = draft.title.trim();
    if (draft.description !== persona.description) patch.description = draft.description.trim();
    if (draft.instructions !== persona.instructions) patch.instructions = draft.instructions;
    return patch;
  }

  function hasPersona(value: unknown): boolean {
    const r = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    const inner = r && r.persona && typeof r.persona === "object" ? (r.persona as Record<string, unknown>) : r;
    return !!inner && typeof inner.instructions === "string";
  }

  async function save(): Promise<void> {
    if (busy || !dirty) return;
    if (!draft.displayName.trim()) {
      error = "The bot needs a name.";
      return;
    }
    busy = true;
    error = null;
    const res = await control.updatePersona(uid, changes());
    if (!res.ok) {
      busy = false;
      const e = controlError(res);
      if (e.offline) onoffline();
      error = e.message;
      return;
    }
    let next: AgentControlPersona;
    if (hasPersona(res.value)) {
      next = personaFromPayload(res.value);
    } else {
      const read = await control.getPersona(uid);
      if (!read.ok) {
        busy = false;
        error = "Saved, but the bot did not read it back. Check again in a moment.";
        return;
      }
      next = personaFromPayload(read.value);
    }
    busy = false;
    onview({
      persona: next,
      agent: { ...view.agent, displayName: next.displayName || view.agent.displayName, title: next.title },
    });
    saved = true;
    editing = false;
  }
</script>

<section class="cp-section" data-testid="cloud-persona">
  <div class="cp-head">
    <span class="cp-label">Profile</span>
    <button type="button" class="cp-btn cp-act" data-testid="cloud-persona-edit" disabled={offline} onclick={openEdit}><RailIcon name="pencil" />Edit</button>
  </div>
  <dl class="cp-kv">
    <dt>Name</dt><dd data-testid="cloud-persona-name">{displayName}</dd>
    <dt>Title</dt><dd data-testid="cloud-persona-title">{title || "None"}</dd>
    <dt>Description</dt><dd data-testid="cloud-persona-description">{persona.description || "None"}</dd>
  </dl>
  {#if saved}<p class="cp-muted" role="status" data-testid="cloud-persona-saved">Saved. This is what the bot read back.</p>{/if}
</section>

<section class="cp-section" data-testid="cloud-persona-instructions">
  <div class="cp-head">
    <span class="cp-label">Instructions</span>
    {#if persona.instructionsPath}<span class="cp-count cp-mono">{persona.instructionsPath}</span>{/if}
  </div>
  {#if persona.instructions.trim()}
    <p class="cp-clamp" data-testid="cloud-persona-preview">{persona.instructions}</p>
    <button type="button" class="cp-btn quiet" data-testid="cloud-persona-open" onclick={openEdit} disabled={offline}><RailIcon name="eye" />Open instructions</button>
  {:else}
    <div class="cp-empty" data-testid="cloud-persona-empty">
      <p>No instructions yet. They tell the bot how to sound and what to focus on.</p>
      <button type="button" class="cp-btn" disabled={offline} onclick={openEdit}><RailIcon name="pencil" />Write instructions</button>
    </div>
  {/if}
</section>

{#if editing}
  <ControlDialog title="Edit persona" subtitle={view.agent.displayName} wide {dirty} {busy} testid="cloud-persona-dialog" onclose={() => (editing = false)}>
    <label class="cp-field">
      <span>Name</span>
      <input class="cp-input" data-autofocus data-testid="cloud-persona-name-input" bind:value={draft.displayName} />
    </label>
    <label class="cp-field">
      <span>Title</span>
      <input class="cp-input" data-testid="cloud-persona-title-input" bind:value={draft.title} placeholder="Research analyst" />
    </label>
    <label class="cp-field">
      <span>Description</span>
      <textarea class="cp-textarea" data-testid="cloud-persona-description-input" bind:value={draft.description}></textarea>
    </label>
    <label class="cp-field">
      <span>Instructions</span>
      <textarea class="cp-textarea roomy" data-testid="cloud-persona-instructions-input" bind:value={draft.instructions} spellcheck="false"></textarea>
    </label>
    {#if error}<p class="cp-error" role="alert" data-testid="cloud-persona-error">{error}</p>{/if}
    {#snippet footer()}
      <span class="cp-grow"></span>
      <button type="button" class="cp-btn primary" data-testid="cloud-persona-save" disabled={!dirty || busy || offline} onclick={() => void save()}>
        {#if busy}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="save" />{/if}Save
      </button>
    {/snippet}
  </ControlDialog>
{/if}
