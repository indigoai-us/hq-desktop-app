<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * New project sheet (US-023, storyboard new-project): name, company, repo or
   * vault-only, owner, linked KR through LinkPicker, and start from Blank,
   * Brainstorm, or PRD. Create hands the request to Claude Code via `oncreate`.
   */
  import LinkPicker from "./LinkPicker.svelte";
  import { dismissable } from "../common/dismissable.js";
  import { clearFormDraft, readFormDraft, saveFormDraft } from "../common/form-drafts.js";
  import type { Objective } from "./local-projects.js";
  import {
    NEW_PROJECT_START_LABEL,
    projectSlug,
    startHint,
    vaultProjectPath,
    type LinkPickerOption,
    type NewProjectDraft,
    type NewProjectLocation,
    type NewProjectStart,
  } from "./new-project.js";

  let {
    company: initialCompany,
    companies,
    owners = [],
    objectives = [],
    onclose,
    oncreate,
  }: {
    company: string;
    companies: readonly string[];
    owners?: readonly string[];
    objectives?: readonly Objective[];
    onclose: () => void;
    oncreate: (draft: NewProjectDraft) => Promise<void>;
  } = $props();

  // QA-088: an unsubmitted draft survives a close for the session.
  const DRAFT_KEY = "new-project";
  const restored = readFormDraft<Omit<NewProjectDraft, "company"> & { company: string }>(DRAFT_KEY);
  let draftRestored = $state(restored !== null);
  let confirmingDiscard = $state(false);

  let name = $state(restored?.name ?? "");
  let company = $state(restored?.company ?? "");
  $effect.pre(() => {
    if (!company) company = initialCompany;
  });
  let location = $state<NewProjectLocation>(restored?.location ?? "vault");
  let repo = $state(restored?.repo ?? "");
  let owner = $state(restored?.owner ?? "");
  let link = $state<LinkPickerOption | null>(restored?.link ?? null);
  let start = $state<NewProjectStart>(restored?.start ?? "brainstorm");
  let creating = $state(false);
  let error = $state<string | null>(null);

  const id = $derived(projectSlug(name));
  const command = $derived(startHint(start, id));
  const STARTS: NewProjectStart[] = ["blank", "brainstorm", "prd"];

  const dirty = $derived(name.trim() !== "" || repo.trim() !== "" || owner.trim() !== "" || link !== null);

  /** Close and keep the draft for the next open. */
  function close(): void {
    if (dirty) saveFormDraft(DRAFT_KEY, { name, company, location, repo, owner, link, start });
    else clearFormDraft(DRAFT_KEY);
    onclose();
  }

  /** Escape on the form itself: ask before discarding a non-empty draft. */
  function escape(): void {
    if (dirty) confirmingDiscard = true;
    else close();
  }

  function discard(): void {
    clearFormDraft(DRAFT_KEY);
    onclose();
  }

  function clearDraft(): void {
    clearFormDraft(DRAFT_KEY);
    name = "";
    company = initialCompany;
    location = "vault";
    repo = "";
    owner = "";
    link = null;
    start = "brainstorm";
    draftRestored = false;
  }

  async function create(): Promise<void> {
    if (creating || !id) return;
    creating = true;
    error = null;
    try {
      await oncreate({ name, company, location, repo, owner, link, start });
      clearFormDraft(DRAFT_KEY);
      onclose();
    } catch (err) {
      console.error("new project failed:", err);
      error = err instanceof Error ? err.message : "Could not create the project";
      creating = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={() => close()}></div>
<div
  class="sheet"
  role="dialog"
  aria-label="New project"
  data-testid="new-project-sheet"
  use:dismissable={{ onclose: escape, autofocus: false }}
>
  <header class="sh">
    New project
    <span class="sub">{company} · board</span>
    <span class="grow"></span>
    <button type="button" class="icon" aria-label="Close" onclick={() => close()}>✕</button>
  </header>
  {#if draftRestored}
    <div class="restored" data-testid="new-project-draft-restored">
      Draft restored · <button type="button" class="link" onclick={clearDraft}>Clear</button>
    </div>
  {/if}
  <div class="sb">
    <div class="fr">
      <div class="lb">Name</div>
      <div>
        <label class="search">
          <!-- svelte-ignore a11y_autofocus -->
          <input data-testid="new-project-name" bind:value={name} placeholder="project-name" autofocus />
        </label>
        <p class="hint">
          Project id <span class="mono">{id || "—"}</span> · appears on the board as Not started
        </p>
      </div>
    </div>
    <div class="fr">
      <div class="lb">Company</div>
      <div class="tabs" role="tablist" data-testid="new-project-companies">
        {#each companies as slug (slug)}
          <button type="button" class="tab" role="tab" aria-selected={company === slug} onclick={() => (company = slug)}
            >{slug}</button
          >
        {/each}
      </div>
    </div>
    <div class="fr">
      <div class="lb">Location</div>
      <div role="radiogroup" aria-label="Location">
        <button
          type="button"
          class="opt"
          role="radio"
          aria-checked={location === "repo"}
          data-testid="new-project-repo"
          onclick={() => (location = "repo")}
        >
          <i></i>
          <div>
            <b>Repo</b>
            {#if location === "repo"}
              <input
                class="repo"
                bind:value={repo}
                placeholder="repos/private/…"
                data-testid="new-project-repo-path"
                onclick={(event) => event.stopPropagation()}
              />
            {/if}
            <div class="m">Branch created on the first story</div>
          </div>
        </button>
        <button
          type="button"
          class="opt"
          role="radio"
          aria-checked={location === "vault"}
          data-testid="new-project-vault"
          onclick={() => (location = "vault")}
        >
          <i></i>
          <div>
            <b>Vault only</b> · <code class="mono">{vaultProjectPath(company, id)}</code>
            <div class="m">No repo link; PRD and notes live in the vault</div>
          </div>
        </button>
        <p class="hint">The vault folder is always created. Repo is optional.</p>
      </div>
    </div>
    <div class="fr">
      <div class="lb">Owner</div>
      <label class="search">
        <input list="new-project-owners" bind:value={owner} placeholder="Owner" data-testid="new-project-owner" />
        <datalist id="new-project-owners">
          {#each owners as person (person)}<option value={person}></option>{/each}
        </datalist>
      </label>
    </div>
    <div class="fr">
      <div class="lb">Linked goal</div>
      <div>
        <LinkPicker {objectives} value={link} onchange={(next) => (link = next)} />
        <p class="hint">Optional. Board progress rolls into this KR.</p>
      </div>
    </div>
    <div class="fr">
      <div class="lb">Start from</div>
      <div>
        <div class="tabs" role="tablist" data-testid="new-project-start">
          {#each STARTS as option (option)}
            <button type="button" class="tab" role="tab" aria-selected={start === option} onclick={() => (start = option)}
              >{NEW_PROJECT_START_LABEL[option]}</button
            >
          {/each}
        </div>
        <p class="hint">
          {#if command}
            Opens a Claude Code session running <span class="mono">{command}</span> before any stories exist.
          {:else}
            Creates an empty project folder and card.
          {/if}
        </p>
      </div>
    </div>
  </div>
  <footer class="sf">
    <span class="hint">
      {#if error}{error}{:else}Creates the folder, the board card{#if command}, and the {start === "prd" ? "PRD" : "brainstorm"} session{/if}{/if}
    </span>
    <RailButton icon="x" onclick={() => close()}>Cancel</RailButton>
    <RailButton icon="check" variant="primary"
      data-testid="new-project-create"
      disabled={creating || !id}
      onclick={() => void create()}>{creating ? "Creating…" : "Create project"}</RailButton>
  </footer>
  {#if confirmingDiscard}
    <div
      class="confirm"
      role="alertdialog"
      aria-label="Discard draft?"
      data-testid="new-project-discard"
      use:dismissable={{ onclose: () => (confirmingDiscard = false) }}
    >
      <span>Discard draft?</span>
      <span class="grow"></span>
      <RailButton icon="pencil" onclick={() => (confirmingDiscard = false)}>Keep editing</RailButton>
      <RailButton icon="trash" variant="primary" data-testid="new-project-discard-confirm" onclick={discard}>Discard</RailButton>
    </div>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 70; }
  .sheet {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(480px, calc(100vw - 32px)); max-height: calc(100% - 40px);
    display: flex; flex-direction: column; overflow: hidden; z-index: 71;
    background: var(--overlay-bg); border: 1px solid var(--overlay-border);
    border-radius: 8px; box-shadow: var(--v4-shadow-popover); color: var(--v4-text-1);
  }
  .sh {
    height: 52px; flex: none; display: flex; align-items: center; gap: 8px;
    padding: 0 10px 0 20px; border-bottom: 1px solid var(--v4-hairline); font-size: 13px; font-weight: 500;
  }
  .sub { font-size: 13px; font-weight: 400; color: var(--v4-text-3); }
  .grow { flex: 1; }
  .icon { border: 0; background: transparent; color: var(--v4-text-3); }
  .sb { overflow: auto; min-height: 0; }
  .fr {
    display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; align-items: start;
    padding: 10px 20px; border-bottom: 1px solid var(--v4-rowline);
  }
  .fr:last-child { border-bottom: 0; }
  .lb { font-size: 13px; color: var(--v4-text-3); padding-top: 6px; line-height: 1.3; }
  .search {
    display: flex; align-items: center; height: 28px; gap: 4px; padding: 0 8px;
    border: 1px solid var(--v4-control-border); border-radius: 6px;
  }
  .search input, .repo {
    flex: 1; min-width: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px;
  }
  .repo { display: block; width: 100%; margin-top: 4px; font-family: var(--font-mono); font-size: 13px; }
  .hint { margin: 5px 0 0; font-size: 13px; line-height: 1.4; color: var(--v4-text-3); }
  .mono { font-family: var(--font-mono); font-size: 13px; }
  .tabs {
    display: flex; gap: 2px; width: max-content; max-width: 100%; flex-wrap: wrap; padding: 2px;
    border-radius: 6px; border: 1px solid var(--v4-control-border); background: var(--v4-control-faint);
  }
  .tab {
    border: 0; background: transparent; color: var(--v4-text-2); font: inherit; font-size: 13px;
    padding: 4px 8px; border-radius: 4px;
  }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .opt {
    display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: start; width: 100%;
    padding: 8px 10px; border: 1px solid var(--v4-control-border); border-radius: 6px;
    background: var(--v4-control-faint); color: var(--v4-text-2); font: inherit; font-size: 13px; text-align: left;
  }
  .opt + .opt { margin-top: 6px; }
  .opt i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--v4-text-3); margin-top: 3px; }
  .opt[aria-checked="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .opt[aria-checked="true"] i { border: 4px solid var(--v4-text-1); }
  .opt b { font-weight: 500; color: var(--v4-text-1); }
  .opt .m { margin-top: 2px; font-size: 13px; line-height: 1.4; color: var(--v4-text-3); }
  .sf { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--v4-hairline); }
  .sf .hint { flex: 1; margin: 0; }
  .restored {
    display: flex; align-items: center; gap: 4px; padding: 6px 20px; font-size: 13px;
    color: var(--v4-text-3); border-bottom: 1px solid var(--v4-hairline);
  }
  .link { border: 0; padding: 0; background: transparent; color: var(--v4-text-1); font: inherit; text-decoration: underline; }
  .confirm {
    flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 20px;
    border-top: 1px solid var(--v4-hairline); background: var(--v4-control-faint); font-size: 13px;
  }
  .confirm .grow { flex: 1; }
</style>
