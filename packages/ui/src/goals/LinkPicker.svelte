<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import { dismissable } from "../common/dismissable.js";
  import ReadLoader from "../common/ReadLoader.svelte";
  /**
   * Link picker (US-026). Search projects, then attach the chosen project
   * to a key result. Shared by Link project and New objective.
   */
  import { projectIdentity, type Objective } from "../projects/local-projects.js";
  import { projectDisplayName, type Project } from "../projects/projects-model.js";
  import { krKey } from "./goals-model.js";

  interface Props {
    /** Projects owned by the active company. Null while they are still loading. */
    projects: Project[] | null;
    objectives: Objective[];
    onclose: () => void;
    onlink: (project: Project, objectiveId: string, krKey: string) => void;
    /** Shown when there is no key result to link to. */
    emptyText?: string;
    /** Set when the projects could not be read and nothing is cached. */
    projectsError?: string | null;
    onretry?: () => void;
    /** Opens the key-result form for an objective that has no key results yet. */
    onaddkr?: (objectiveId: string) => void;
  }

  let {
    projects,
    objectives,
    onclose,
    onlink,
    emptyText = "Add an objective before linking.",
    projectsError = null,
    onretry,
    onaddkr,
  }: Props = $props();

  const hasKrs = $derived(objectives.some((objective) => objective.keyResults.length > 0));
  // An existing objective with no key results gets a way to add one instead of an empty list (QA-078).
  const needsKr = $derived(!hasKrs && objectives.length > 0 && onaddkr ? objectives[0] : null);

  let query = $state("");
  let projectId = $state<string | null>(null);
  let target = $state<string | null>(null);

  const matches = $derived(
    (projects ?? []).filter((project) => {
      const name = projectDisplayName(project).toLowerCase();
      return !query.trim() || name.includes(query.trim().toLowerCase());
    }),
  );
  // QA-105: a company can have hundreds of projects; draw the first rows and
  // let the search narrow the rest instead of rendering every one.
  const PICKER_ROW_CAP = 50;
  const visible = $derived(matches.slice(0, PICKER_ROW_CAP));
  // Project ids are only unique per PRD path, so rows and selection use the full identity.
  const chosen = $derived((projects ?? []).find((project) => projectIdentity(project) === projectId) ?? null);

  function pickTarget(objectiveId: string, key: string): void {
    target = `${objectiveId}:${key}`;
    if (!chosen) return;
    onlink(chosen, objectiveId, key);
  }
</script>

<div class="popover" data-testid="link-picker" role="dialog" aria-label="Link project" use:dismissable={{ onclose, trap: false, autofocus: false }}>
  <div class="ctx">
    <span class="t">{chosen ? projectDisplayName(chosen) : "Pick a project"}</span>
    <button class="x" type="button" aria-label="Close" onclick={onclose}>✕</button>
  </div>
  <input class="search" placeholder="Search projects…" bind:value={query} />
  <div class="sec">Projects</div>
  <div class="list">
    {#if projects === null && projectsError}
      <div class="foot" role="alert" data-testid="link-picker-error">
        {projectsError}
        {#if onretry}<button type="button" class="act" onclick={onretry}><RailIcon name="refresh" />Try again</button>{/if}
      </div>
    {:else if projects === null}
      <ReadLoader testid="link-picker-loading" {onretry} />
    {:else}
      {#each visible as project (projectIdentity(project))}
        <button
          type="button"
          class="row hq-contain-row"
          aria-pressed={projectIdentity(project) === projectId}
          onclick={() => (projectId = projectIdentity(project))}
        >{projectDisplayName(project)}</button>
      {:else}
        <p class="foot">{projects.length ? "No projects match." : "No projects in this company yet."}</p>
      {/each}
      {#if matches.length > visible.length}
        <p class="foot" data-testid="link-picker-more">Showing {visible.length} of {matches.length}. Search to find the rest.</p>
      {/if}
    {/if}
  </div>
  <div class="sec">Key results</div>
  <div class="list">
    {#if needsKr}
      <div class="foot" data-testid="link-picker-needs-kr">
        Add a key result to this objective first.
        <button type="button" class="act" onclick={() => onaddkr?.(needsKr.id)}><RailIcon name="plus" />Add key result</button>
      </div>
    {:else if !hasKrs}
      <p class="foot">{emptyText}</p>
    {:else}
    {#each objectives as objective, o (`${o}:${objective.id}`)}
      {#each objective.keyResults as kr, index (index)}
        <button
          type="button"
          class="row"
          disabled={!chosen}
          aria-pressed={target === `${objective.id}:${krKey(kr, index)}`}
          onclick={() => pickTarget(objective.id, krKey(kr, index))}
        >
          <b>{objective.title}</b>
          <span>{kr.title || "Key result"}</span>
        </button>
      {/each}
    {/each}
    {/if}
  </div>
</div>

<style>
  .popover {
    position: absolute;
    right: 16px;
    top: 52px;
    width: 380px;
    /* QA-105: never taller than the overlay it opens in. */
    max-height: min(420px, calc(100% - 68px));
    overflow: auto;
    z-index: 5;
    padding: 6px;
    background: var(--overlay-bg);
    border: 1px solid var(--v4-hairline, var(--v4-rowline));
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover, none);
    color: var(--v4-text-1);
  }
  .ctx, .row { display: flex; align-items: center; gap: 8px; }
  .ctx { padding: 4px 8px 6px; color: var(--v4-text-2); border-bottom: 1px solid var(--v4-rowline); }
  .t { flex: 1; }
  /* QA-107: border-box so full-width rows and the search field stay inside the popover. */
  .row, .search { box-sizing: border-box; }
  .x, .row, .search { font: inherit; color: inherit; background: transparent; border: 0; }
  .search {
    width: 100%;
    height: 28px;
    padding: 0 8px;
    color: var(--v4-text-1);
    border-bottom: 1px solid var(--v4-rowline);
  }
  .sec {
    padding: 8px 8px 2px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }
  .row {
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: 6px;
    color: var(--v4-text-2);
    flex-direction: column;
    align-items: flex-start;
  }
  .row b { font-weight: 600; color: var(--v4-text-1); }
  .row[aria-pressed="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .row:hover:not(:disabled) { background: var(--v4-hover); }
  .act { font: inherit; color: var(--v4-text-1); background: transparent; border: 0; padding: 0 0 0 6px; cursor: pointer; text-decoration: underline; }
  .foot { font-size: 12px; color: var(--v4-text-3); padding: 4px 8px; }
</style>
