<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
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
  }

  let { projects, objectives, onclose, onlink, emptyText = "Add an objective before linking." }: Props = $props();

  let query = $state("");
  let projectId = $state<string | null>(null);
  let target = $state<string | null>(null);

  const visible = $derived(
    (projects ?? []).filter((project) => {
      const name = projectDisplayName(project).toLowerCase();
      return !query.trim() || name.includes(query.trim().toLowerCase());
    }),
  );
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
    {#if projects === null}
      {#each [0, 1, 2] as i (i)}<div class="shimmer" data-testid="link-picker-loading"></div>{/each}
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
    {/if}
  </div>
  <div class="sec">Key results</div>
  <div class="list">
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
    {:else}
      <p class="foot">{emptyText}</p>
    {/each}
  </div>
</div>

<style>
  .popover {
    position: absolute;
    right: 16px;
    top: 52px;
    width: 380px;
    max-height: 420px;
    overflow: auto;
    z-index: 5;
    padding: 6px;
    background: var(--v4-popover, var(--v4-ground, #111));
    border: 1px solid var(--v4-hairline, var(--v4-rowline));
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover, none);
    color: var(--v4-text-1);
  }
  .ctx, .row { display: flex; align-items: center; gap: 8px; }
  .ctx { padding: 4px 8px 6px; color: var(--v4-text-2); border-bottom: 1px solid var(--v4-rowline); }
  .t { flex: 1; }
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
  .shimmer { height: 22px; margin: 4px 8px; border-radius: 6px; background: var(--v4-hover); }
  .foot { font-size: 12px; color: var(--v4-text-3); padding: 4px 8px; }
</style>
