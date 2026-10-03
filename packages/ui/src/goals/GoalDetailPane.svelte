<script lang="ts">
  /**
   * Objective side pane (OWNER-R8). Opens beside the Goals list with what the
   * list already knows; linked project names and statuses fill in once the
   * projects read answers. Add and Remove go through the parent, which owns
   * the goal-link write and its rollback.
   */
  import ReadLoader from "../common/ReadLoader.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import type { Objective } from "../projects/local-projects.js";
  import { projectDisplayName, projectListStatus, type Project, type ProjectListStatus } from "../projects/projects-model.js";
  import { formatKrEnds, goalGlyph, krKey, krProgress, ownerDisplay, type KrLink } from "./goals-model.js";

  interface Props {
    objective: Objective;
    /** Links this objective has, one per project. */
    links: KrLink[];
    /** The company's projects; null while the first read is in flight. */
    projects: Project[] | null;
    projectsError?: string | null;
    canEdit: boolean;
    /** Plain message for a failed add or remove. */
    saveError?: string | null;
    onclose: () => void;
    onopenproject?: (projectId: string) => void;
    onadd: () => void;
    onremove: (projectId: string) => void;
    onretrysave?: () => void;
    onretryprojects?: () => void;
  }

  let {
    objective,
    links,
    projects,
    projectsError = null,
    canEdit,
    saveError = null,
    onclose,
    onopenproject,
    onadd,
    onremove,
    onretrysave,
    onretryprojects,
  }: Props = $props();

  const STATUS_WORDS: Record<ProjectListStatus, string> = {
    live: "Live",
    "in-progress": "In progress",
    complete: "Complete",
    pending: "Planned",
    archived: "Archived",
  };

  const glyph = $derived(goalGlyph(objective.status));
  const owner = $derived(ownerDisplay(objective.owner));
  const rows = $derived(
    links.map((link) => {
      const project = projects?.find((row) => row.id === link.projectId) ?? null;
      return {
        id: link.projectId,
        name: project ? projectDisplayName(project) : link.projectName,
        status: project ? STATUS_WORDS[projectListStatus(project)] : null,
      };
    }),
  );
</script>

<aside class="pane" data-testid="goal-pane" aria-label={objective.title || "Objective"}>
  <header class="ph">
    <h2 class="pt" title={objective.title}>{objective.title || "Objective"}</h2>
    <button type="button" class="x" aria-label="Close" data-testid="goal-pane-close" onclick={onclose}>✕</button>
  </header>
  <div class="pb">
    <div class="meta" data-testid="goal-pane-meta">
      {#if objective.timeframe}<span>{objective.timeframe}</span><span aria-hidden="true">·</span>{/if}
      <span class="st"><i class="sdot" data-status={glyph.label}></i>{glyph.label}</span>
    </div>

    {#if owner}
      <div class="fr" data-testid="goal-pane-owner">
        <span class="lb">Owner</span>
        <span class="val"><span class="nm" title={owner.name}>{owner.name}</span>{#if owner.email}<span class="em" title={owner.email}>{owner.email}</span>{/if}</span>
      </div>
    {/if}

    {#if objective.description}
      <p class="desc" data-testid="goal-pane-description">{objective.description}</p>
    {/if}

    {#if objective.keyResults.length}
      <div class="sech">Key results</div>
      {#each objective.keyResults as kr, index (krKey(kr, index))}
        {@const pct = krProgress(kr)}
        <div class="kr">
          <div class="kt" title={kr.title}>{kr.title || "Key result"}</div>
          <div class="km">
            <span class="bar"><i style:width="{pct ?? 0}%"></i></span>
            {#if pct != null}<span class="pct">{pct}%</span>{/if}
            <span class="ct">{formatKrEnds(kr)}</span>
          </div>
        </div>
      {/each}
    {/if}

    <div class="sech">
      Linked projects
      <span class="grow"></span>
      {#if canEdit}
        <RailButton icon="plus" data-testid="goal-pane-add" onclick={onadd}>Add project</RailButton>
      {/if}
    </div>
    {#if saveError}
      <div class="failed" role="alert" data-testid="goal-pane-save-error">
        <span>{saveError}</span>
        {#if onretrysave}<button type="button" class="act" onclick={onretrysave}>Try again</button>{/if}
      </div>
    {/if}
    {#each rows as row (row.id)}
      <div class="lp" data-testid="goal-pane-project">
        <button type="button" class="lp-open" title={row.name} onclick={() => onopenproject?.(row.id)}>
          <span class="lp-name">{row.name}</span>
          {#if row.status}<span class="lp-status">{row.status}</span>{/if}
        </button>
        {#if canEdit}
          <button type="button" class="act rm" aria-label={`Remove ${row.name}`} data-testid="goal-pane-remove" onclick={() => onremove(row.id)}>Remove</button>
        {/if}
      </div>
    {:else}
      {#if projects === null && projectsError}
        <div class="failed" role="alert" data-testid="goal-pane-projects-error">
          <span>{projectsError}</span>
          {#if onretryprojects}<button type="button" class="act" onclick={onretryprojects}>Try again</button>{/if}
        </div>
      {:else if projects === null}
        <ReadLoader testid="goal-pane-loader" onretry={onretryprojects ?? null} />
      {:else}
        <p class="empty" data-testid="goal-pane-empty">No linked projects yet.</p>
      {/if}
    {/each}
  </div>
</aside>

<style>
  .pane { flex: 0 0 340px; width: 340px; min-width: 0; min-height: 0; border-left: 1px solid var(--line); display: flex; flex-direction: column; font-size: 13px; color: var(--t1); }
  .ph { display: flex; align-items: center; gap: 8px; height: 52px; box-sizing: border-box; padding: 0 10px 0 16px; border-bottom: 1px solid var(--line); flex: none; }
  .pt { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { font: inherit; color: var(--t2); background: transparent; border: 0; border-radius: 6px; width: 28px; height: 28px; cursor: pointer; }
  .x:hover { background: var(--hover); color: var(--t1); }
  .pb { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px 16px 24px; }
  .meta { display: flex; align-items: center; gap: 6px; color: var(--t3); }
  .st { display: inline-flex; align-items: center; gap: 6px; }
  .sdot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--t2); box-sizing: border-box; }
  .sdot[data-status="at risk"] { background: var(--warn); }
  .sdot[data-status="off track"], .sdot[data-status="not started"] { background: transparent; border: 1px solid var(--t3); }
  .sdot[data-status="complete"] { background: var(--t1); }
  .fr { display: grid; grid-template-columns: 64px 1fr; gap: 8px; margin-top: 12px; align-items: baseline; }
  .lb { color: var(--t3); }
  .val { display: flex; gap: 6px; min-width: 0; }
  .nm, .em, .kt, .lp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .em { color: var(--t3); }
  .desc { margin: 12px 0 0; color: var(--t2); line-height: 18px; overflow-wrap: anywhere; }
  .sech { display: flex; align-items: center; gap: 8px; margin: 20px 0 6px; color: var(--t2); font-weight: 500; min-height: 28px; }
  .grow { flex: 1; }
  .kr { padding: 4px 0 6px; }
  .kt { color: var(--t2); }
  .km { display: flex; align-items: center; gap: 8px; margin-top: 4px; color: var(--t3); font-variant-numeric: tabular-nums; }
  .bar { flex: 1 1 auto; height: 3px; background: var(--line2); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--t2); }
  .lp { display: flex; align-items: center; gap: 4px; border-radius: 6px; }
  .lp:hover { background: var(--hover); }
  .lp-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font: inherit; color: var(--t1); background: transparent; border: 0; padding: 6px 8px; text-align: left; cursor: pointer; min-height: 28px; }
  .lp-status { flex: none; color: var(--t3); }
  .act { font: inherit; color: var(--t2); background: transparent; border: 0; min-height: 28px; padding: 4px 8px; cursor: pointer; border-radius: 6px; }
  .act:hover { color: var(--t1); background: var(--hover); }
  .failed { display: flex; align-items: center; gap: 8px; color: var(--t2); padding: 4px 0; }
  .empty { margin: 0; padding: 6px 0; color: var(--t3); }
</style>
