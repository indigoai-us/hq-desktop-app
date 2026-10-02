<script lang="ts">
  /**
   * Edit bot sheet. Tabs are the new-agent stepper steps (Identity through
   * Runtime). Field groups follow that step's content. Save is local until
   * the host applies it on the next heartbeat.
   */
  import {
    EDIT_BOT_TABS,
    editBotTabLabel,
    type EditBotTab,
  } from "./profile-pane-model.js";
  import { emptyDraft, type AgentStepperDraft } from "../../agents/agent-stepper-model.js";

  interface Props {
    name: string;
    draft?: AgentStepperDraft | null;
    onclose?: () => void;
    onsave?: (draft: AgentStepperDraft) => void;
  }

  let { name, draft = null, onclose, onsave }: Props = $props();

  let tab = $state<EditBotTab>("identity");
  let local = $state<AgentStepperDraft>(emptyDraft());

  $effect(() => {
    local = draft ? structuredClone(draft) : emptyDraft({ name });
  });
</script>

<div class="ov" data-testid="edit-bot-sheet">
  <div class="sheet" role="dialog" aria-label="Edit bot">
    <header class="sh">
      Edit bot
      <span class="sub">{name}</span>
      <button type="button" class="icon" aria-label="Close" data-testid="edit-bot-close" onclick={() => onclose?.()}>✕</button>
    </header>
    <div class="stabs" role="tablist">
      {#each EDIT_BOT_TABS as id (id)}
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={tab === id}
          data-testid="edit-bot-tab-{id}"
          onclick={() => (tab = id)}
        >{editBotTabLabel(id)}</button>
      {/each}
    </div>
    <div class="sb">
      {#if tab === "identity"}
        <div class="fr"><label for="eb-name">Name</label><input id="eb-name" class="fld" data-testid="edit-bot-name" bind:value={local.name} /></div>
        <div class="fr"><label for="eb-handle">Handle</label><input id="eb-handle" class="fld" bind:value={local.handle} /></div>
        <div class="fr"><label for="eb-purpose">Purpose</label><textarea id="eb-purpose" class="fld ta" bind:value={local.description}></textarea></div>
        <p class="hint">Shown on the profile pane. Applies on the next heartbeat.</p>
      {:else if tab === "membership"}
        <div class="fr"><span>Home company</span><span>{local.companies.find((c) => c.joined)?.label ?? "None yet"}</span></div>
        {#each local.companies as company (company.id)}
          <label class="rd"><input type="checkbox" bind:checked={company.joined} /> {company.label} <small>{company.role}</small></label>
        {/each}
        {#if local.companies.length === 0}<p class="hint">No companies are cached yet.</p>{/if}
      {:else if tab === "access"}
        {#each local.grants as grant (grant.path)}
          <div class="fr">
            <span class="mono">{grant.path}</span>
            <span>{grant.write ? "read · write" : grant.read ? "read" : "none"}</span>
          </div>
        {/each}
        {#each local.secrets as secret (secret.name)}
          <div class="fr"><span>{secret.name}</span><span>{secret.granted ? "mounted per run" : "not granted"}</span></div>
        {/each}
        {#if local.grants.length === 0 && local.secrets.length === 0}
          <p class="hint">No vault grants are cached. Names only — secret values stay hidden.</p>
        {/if}
      {:else if tab === "capabilities"}
        {#each local.skills as skill (skill.id)}
          <label class="rd"><input type="checkbox" bind:checked={skill.selected} /> {skill.title}</label>
        {/each}
        {#each local.tools as tool (tool.id)}
          <label class="rd"><input type="checkbox" bind:checked={tool.selected} /> {tool.title}</label>
        {/each}
        <div class="fr"><span>Model</span><span class="mono">{local.model}</span></div>
        {#if local.skills.length === 0 && local.tools.length === 0}
          <p class="hint">Capabilities refresh from the bot record. This tab edits the cached draft.</p>
        {/if}
      {:else}
        <div class="fr"><span>Place</span><span>{local.place}</span></div>
        <div class="fr"><span>Box</span><span>{local.size} · {local.region}</span></div>
        <p class="hint">Runtime changes apply on the next heartbeat, about 30 s. Pause the bot first if it is live.</p>
      {/if}
    </div>
    <footer class="sf">
      <span class="note">Applies on the next heartbeat · about 30 s</span>
      <span class="grow"></span>
      <button type="button" class="btn" onclick={() => onclose?.()}>Cancel</button>
      <button type="button" class="btn primary" data-testid="edit-bot-save" onclick={() => onsave?.(local)}>Save</button>
    </footer>
  </div>
</div>

<style>
  .ov { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); }
  .sheet {
    width: min(560px, calc(100% - 32px)); max-height: calc(100% - 48px);
    display: flex; flex-direction: column;
    background: var(--v4-popover, var(--v4-ground));
    border: 1px solid var(--v4-hairline, var(--line));
    border-radius: 8px; color: var(--v4-text-1); overflow: hidden;
  }
  .sh, .sf {
    height: 52px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 16px;
    border-bottom: 1px solid var(--v4-hairline, var(--line)); font-size: 15px; font-weight: 600;
  }
  .sf { border-bottom: 0; border-top: 1px solid var(--v4-hairline, var(--line)); font-weight: 400; }
  .sub, .note { font-weight: 400; font-size: 12px; color: var(--v4-text-3); }
  .icon { margin-left: auto; border: 0; background: transparent; color: var(--v4-text-3); cursor: pointer; }
  .stabs { display: flex; gap: 2px; padding: 8px 12px; border-bottom: 1px solid var(--v4-rowline, var(--line)); overflow: auto; }
  .tab {
    border: 0; background: transparent; color: var(--v4-text-2); font: inherit; font-size: 13px;
    padding: 4px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  }
  .tab[aria-selected="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .sb { min-height: 0; overflow: auto; padding: 4px 0 12px; }
  .fr { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; align-items: center; padding: 10px 16px; font-size: 13px; }
  .fld {
    min-height: 28px; border-radius: 6px; background: var(--v4-control-faint); border: 1px solid var(--v4-control-border, var(--line));
    color: var(--v4-text-1); padding: 4px 10px; font: inherit; width: 100%; box-sizing: border-box;
  }
  .fld.ta { min-height: 64px; resize: vertical; }
  .hint { font-size: 12px; color: var(--v4-text-3); padding: 0 16px; line-height: 1.45; }
  .rd { display: flex; gap: 8px; align-items: center; padding: 4px 16px; font-size: 13px; }
  .rd small { color: var(--v4-text-3); }
  .mono { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 12px; }
  .grow { flex: 1; }
  .btn {
    border: 1px solid var(--v4-control-border, var(--line)); background: transparent; color: var(--v4-text-1);
    border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
</style>
