<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  /**
   * New objective sheet (US-026). Period choices match the storyboard.
   * Linking a project opens LinkPicker against the draft's own key results;
   * picked links are saved with the objective in one create (QA-071).
   */
  import type { Objective } from "../projects/local-projects.js";
  import { projectDisplayName, type Project } from "../projects/projects-model.js";
  import { NEW_GOAL_PERIODS } from "./goals-model.js";
  import LinkPicker from "./LinkPicker.svelte";

  interface DraftKr {
    title: string;
    current: string;
    target: string;
    unit: string;
  }

  /** A project linked to a draft key result, by its index in the saved key results. */
  interface DraftLink {
    krIndex: number;
    projectId: string;
    projectName: string;
  }

  interface Props {
    projects: Project[] | null;
    onclose: () => void;
    oncreate: (draft: {
      title: string;
      period: string;
      owner: string;
      keyResults: DraftKr[];
      links: DraftLink[];
    }) => void;
  }

  let { projects, onclose, oncreate }: Props = $props();

  let title = $state("");
  let period = $state<(typeof NEW_GOAL_PERIODS)[number]>("H2 2026");
  let owner = $state("");
  let keyResults = $state<DraftKr[]>([{ title: "", current: "0", target: "", unit: "" }]);
  let linking = $state(false);
  // Links point at positions in keyResults; they are remapped to saved positions on create.
  let links = $state<{ kr: number; projectId: string; projectName: string }[]>([]);

  const DRAFT_ID = "draft";
  // The picker sees the draft as one objective whose key results carry their form position as id.
  const draftObjectives = $derived<Objective[]>(
    keyResults.some((kr) => kr.title.trim())
      ? [
          {
            id: DRAFT_ID,
            title: title.trim() || "New objective",
            description: "",
            status: "",
            timeframe: period,
            owner: owner.trim() || null,
            keyResults: keyResults
              .map((kr, index) => ({ ...kr, id: `draft-kr-${index}` }))
              .filter((kr) => kr.title.trim()),
            initiativeIds: [],
          },
        ]
      : [],
  );
  const visibleLinks = $derived(links.filter((link) => keyResults[link.kr]?.title.trim()));

  function addLink(project: Project, key: string): void {
    const kr = Number(key.replace("draft-kr-", ""));
    if (!Number.isInteger(kr) || !keyResults[kr]) return;
    links = [
      ...links.filter((link) => !(link.kr === kr && link.projectId === project.id)),
      { kr, projectId: project.id, projectName: projectDisplayName(project) },
    ];
  }

  function removeLink(target: { kr: number; projectId: string }): void {
    links = links.filter((link) => !(link.kr === target.kr && link.projectId === target.projectId));
  }

  function addKr(): void {
    keyResults = [...keyResults, { title: "", current: "0", target: "", unit: "" }];
  }

  function create(): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    const kept = keyResults.map((kr, index) => ({ kr, index })).filter(({ kr }) => kr.title.trim());
    const savedIndex = new Map(kept.map(({ index }, saved) => [index, saved]));
    oncreate({
      title: trimmed,
      period,
      owner: owner.trim(),
      keyResults: kept.map(({ kr }) => kr),
      links: links.flatMap((link) => {
        const krIndex = savedIndex.get(link.kr);
        return krIndex === undefined ? [] : [{ krIndex, projectId: link.projectId, projectName: link.projectName }];
      }),
    });
  }
</script>

<div class="scrim" data-testid="new-goal-sheet" role="presentation" onclick={onclose}></div>
<div class="sheet" role="dialog" aria-label="New objective" use:dismissable={{ onclose }}>
  <div class="sh">New objective <span class="grow"></span>
    <button class="x" type="button" aria-label="Close" onclick={onclose}>✕</button>
  </div>
  <div class="sb">
    <label class="fr"><span class="lb">Objective</span>
      <textarea bind:value={title} rows="2"></textarea>
    </label>
    <div class="fr"><span class="lb">Period</span>
      <div class="tabs" role="tablist">
        {#each NEW_GOAL_PERIODS as id (id)}
          <button type="button" class="tab" role="tab" aria-selected={period === id} onclick={() => (period = id)}>{id}</button>
        {/each}
      </div>
    </div>
    <label class="fr"><span class="lb">Owner</span>
      <input bind:value={owner} />
    </label>
    <div class="fr"><span class="lb">Key results</span>
      <div>
        {#each keyResults as kr, index (index)}
          <div class="krb">
            <input placeholder="Key result" bind:value={kr.title} />
            <div class="nums">
              <input aria-label="current" bind:value={kr.current} />
              <input aria-label="target" bind:value={kr.target} />
              <input aria-label="unit" bind:value={kr.unit} />
            </div>
          </div>
        {/each}
        <button type="button" class="add" onclick={addKr}>Add key result</button>
      </div>
    </div>
    <div class="fr"><span class="lb">Linked projects</span>
      <div>
        {#each visibleLinks as link (`${link.kr}:${link.projectId}`)}
          <div class="lk" data-testid="new-goal-linked">
            <span>{link.projectName} → {keyResults[link.kr].title}</span>
            <button type="button" class="x" aria-label="Remove link" onclick={() => removeLink(link)}>✕</button>
          </div>
        {/each}
        <button type="button" class="btn" data-testid="new-goal-link" onclick={() => (linking = true)}>+ Link</button>
      </div>
    </div>
  </div>
  <div class="sf">
    <span class="hint">Shows under Objectives as ○ not started until the board records a status.</span>
    <button type="button" class="btn" onclick={onclose}>Cancel</button>
    <button type="button" class="btn primary" onclick={create}>Create objective</button>
  </div>
  {#if linking}
    <LinkPicker
      {projects}
      objectives={draftObjectives}
      emptyText="Name a key result above, then link a project to it."
      onclose={() => (linking = false)}
      onlink={(project, _objectiveId, key) => {
        addLink(project, key);
        linking = false;
      }}
    />
  {/if}
</div>

<style>
  .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 8; }
  .sheet {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(480px, calc(100% - 32px));
    max-height: calc(100% - 40px);
    display: flex;
    flex-direction: column;
    z-index: 9;
    background: var(--v4-popover, var(--v4-ground, #161616));
    border: 1px solid var(--v4-hairline, var(--v4-rowline));
    border-radius: 8px;
    color: var(--v4-text-1);
    overflow: hidden;
    position: relative;
  }
  .sh, .sf { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
  .sh { border-bottom: 1px solid var(--v4-hairline, var(--v4-rowline)); font-weight: 600; }
  .sf { border-top: 1px solid var(--v4-hairline, var(--v4-rowline)); }
  .grow { flex: 1; }
  .hint { flex: 1; font-size: 12px; color: var(--v4-text-3); }
  .sb { overflow: auto; min-height: 0; }
  .fr {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .lb { font-size: 12px; color: var(--v4-text-3); padding-top: 6px; }
  input, textarea, .btn, .tab, .add, .x {
    font: inherit;
    color: var(--v4-text-1);
    background: var(--v4-control-bg, transparent);
    border: 1px solid var(--v4-control-border, var(--v4-rowline));
    border-radius: 6px;
  }
  input, textarea { width: 100%; padding: 6px 8px; }
  .x, .add, .tab, .btn { background: transparent; }
  .tabs { display: flex; gap: 0; width: max-content; padding: 2px; background: var(--v4-control-faint); border-radius: 6px; }
  .tab { border: 0; padding: 3px 8px; color: var(--v4-text-2); }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .krb { border: 1px solid var(--v4-control-border, var(--v4-rowline)); border-radius: 6px; padding: 8px; margin-bottom: 6px; }
  .nums { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 6px; }
  .add, .btn { border: 0; color: var(--v4-text-2); padding: 4px 8px; }
  .btn { border: 1px solid var(--v4-rowline); }
  .btn.primary { background: var(--v4-active-row); color: var(--v4-text-1); }
  .x { border: 0; }
  .lk { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--v4-text-2); padding: 2px 0 6px; }
  .lk span { flex: 1; }
</style>
