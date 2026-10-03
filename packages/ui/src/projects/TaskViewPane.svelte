<!--
  Task view pane (console-rail US-024). 360 px pane to the right of the
  project board: who is on it now, the task list with done / open / live
  marks, and the selected task with acceptance criteria, owner, bot,
  dependencies, branch, and actions. Paints from the stories the board has
  cached; the board refreshes them in the background.
-->
<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
  import type { PortfolioSessionRef } from "../chat/portfolio-session.js";
  import BoardFaces from "./BoardFaces.svelte";
  import { boardFaces, facesCaption } from "./board-faces.js";
  import {
    projectDisplayName,
    type Project,
    type ProjectLiveRunView,
    type Story,
  } from "./projects-model.js";
  import {
    defaultTaskId,
    doneSummary,
    taskBot,
    taskMark,
    taskOwner,
  } from "./task-view.js";

  interface Props {
    project: Project;
    stories: readonly Story[];
    /** True while the first read for this project has not landed yet. */
    loading?: boolean;
    error?: string | null;
    branch?: string | null;
    sessions: readonly PortfolioSessionRef[];
    liveRun?: ProjectLiveRunView | null;
    /** Lead person label for the Now row. */
    lead?: string | null;
    onclose: () => void;
    onopenproject: (storyId: string | null) => void;
    onmarkdone?: (story: Story) => void;
  }

  let {
    project,
    stories,
    loading = false,
    error = null,
    branch = null,
    sessions,
    liveRun = null,
    lead = null,
    onclose,
    onopenproject,
    onmarkdone,
  }: Props = $props();

  let pickedId = $state<string | null>(null);
  let pickedFor = $state<string | null>(null);

  const selectedId = $derived(
    pickedFor === project.id &&
      pickedId !== null &&
      stories.some((s) => s.id === pickedId)
      ? pickedId
      : defaultTaskId(stories, sessions),
  );
  const selected = $derived(
    stories.find((s) => s.id === selectedId) ?? null,
  );
  const nowFaces = $derived(
    boardFaces(lead ? [lead] : [], liveRun?.bots ?? []),
  );
  /** Now row copy: who, phase, elapsed when live; a quiet idle line otherwise. */
  const nowLine = $derived(
    liveRun
      ? [
          nowFaces.length > 0 ? facesCaption(nowFaces) : null,
          liveRun.phase ?? "Live",
          liveRun.elapsed,
        ]
          .filter(Boolean)
          .join(" · ")
      : [lead, "Nothing running"].filter(Boolean).join(" · "),
  );
  const owner = $derived(selected ? taskOwner(selected) : null);
  const bot = $derived(selected ? taskBot(selected, sessions) : null);
  const selectedMark = $derived(
    selected ? taskMark(selected, sessions) : "open",
  );

  function pick(id: string): void {
    pickedFor = project.id;
    pickedId = id;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
  class="tpane"
  aria-label="Task view"
  data-testid="task-view-pane"
  onkeydown={onKeydown}
>
  <div class="ph">
    {#if liveRun}
      <span class="chip live"><i class="ldot" aria-hidden="true"></i>Active</span>
    {/if}
    <span class="ph-title" title={projectDisplayName(project)}
      >{projectDisplayName(project)}</span
    >
    <span class="grow"></span>
    <button
      type="button"
      class="icon-btn"
      aria-label="Open project"
      title="Open project"
      data-testid="task-view-open-project"
      onclick={() => onopenproject(selected?.id ?? null)}>↗</button
    >
    <button
      type="button"
      class="icon-btn"
      aria-label="Close"
      data-testid="task-view-close"
      onclick={onclose}>✕</button
    >
  </div>

  <div class="pb">
    <div class="kind">Now</div>
    <div class="now" class:is-live={liveRun !== null} data-testid="task-view-now">
      {#if nowFaces.length > 0}
        <BoardFaces faces={nowFaces} />
      {/if}
      <div class="now-text">
        <div class="now-title">
          {#if liveRun}<i class="ldot" aria-hidden="true"></i>{/if}{nowLine}
        </div>
      </div>
    </div>

    {#if stories.length === 0 && loading}
      <div class="kind">Tasks</div>
      <div class="sk" aria-busy="true" aria-label="Loading tasks" data-testid="task-view-skeleton">
        <div class="sk-row"></div>
        <div class="sk-row"></div>
        <div class="sk-row short"></div>
      </div>
    {:else if error && stories.length === 0}
      <p class="note" role="alert">{error}</p>
    {:else if stories.length === 0}
      <p class="note">No tasks in this project yet.</p>
    {:else}
      <div class="kind">{doneSummary(stories)}</div>
      <div class="tl" role="listbox" aria-label="Tasks" data-testid="task-view-list">
        {#each stories as story (story.id)}
          {@const mark = taskMark(story, sessions)}
          <button
            type="button"
            class="ti"
            role="option"
            aria-selected={story.id === selectedId}
            aria-current={story.id === selectedId ? "true" : undefined}
            data-mark={mark}
            data-testid="task-view-item"
            onclick={() => pick(story.id)}
          >
            <i class={mark} aria-label={mark}></i>
            <span class="ti-t">{story.title}</span>
            <span class="id">{story.id}</span>
          </button>
        {/each}
      </div>

      {#if selected}
        <div class="td" data-testid="task-view-detail">
          <h3>{selected.id} · {selected.title}</h3>
          {#if selected.description}
            <p>{selected.description}</p>
          {/if}
          <div class="chips">
            {#if selectedMark === "live"}
              <span class="chip live"
                ><i class="ldot" aria-hidden="true"></i>{bot ?? "bot"} · live</span
              >
            {:else if selectedMark === "done"}
              <span class="chip">Done</span>
            {/if}
            {#if branch}<span class="chip mono">{branch}</span>{/if}
            {#if selected.files && selected.files.length > 0}
              <span class="chip"
                >{selected.files.length}
                {selected.files.length === 1 ? "file" : "files"}</span
              >
            {/if}
          </div>
          <div class="kind">Acceptance</div>
          {#if selected.acceptanceCriteria.length > 0}
            <div class="ac" data-testid="task-view-acceptance">
              {#each selected.acceptanceCriteria as criterion, index (index)}
                <div class:ok={selected.passes}>{criterion}</div>
              {/each}
            </div>
          {:else}
            <p class="note">No acceptance criteria written.</p>
          {/if}
          <dl class="kv">
            <dt>Owner</dt>
            <dd>{owner ?? "Unassigned"}</dd>
            <dt>Bot</dt>
            <dd>{bot ?? "None"}</dd>
            <dt>Depends on</dt>
            <dd>{selected.dependsOn.length > 0 ? selected.dependsOn.join(", ") : "Nothing"}</dd>
            {#if selected.labels.length > 0}
              <dt>Labels</dt>
              <dd>{selected.labels.join(" · ")}</dd>
            {/if}
            <dt>Branch</dt>
            <dd class="mono">{branch ?? "Not set"}</dd>
          </dl>
          <div class="actions">
            <RailButton icon="external" variant="primary"
              onclick={() => onopenproject(selected?.id ?? null)}>Open task</RailButton>
            {#if !selected.passes && onmarkdone && project.prdPath}
              <RailButton icon="check"
                data-testid="task-view-mark-done"
                onclick={() => selected && onmarkdone?.(selected)}>Mark done</RailButton>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</aside>

<style>
  /* Hit area (AUDIT-2-10..13): every control here has at least a 28x28 px
     clickable box. The ::after pad grows only the axes under 28 px, so the
     drawn size and layout stay as they are. Kept first so a later
     position rule (e.g. absolute) still wins. */
  .icon-btn, .ti { position: relative; }
  .icon-btn::after,
  .ti::after {
    content: "";
    position: absolute;
    inset: min(0px, calc(50% - 14px));
  }
  .tpane {
    width: 360px;
    flex: none;
    display: grid;
    grid-template-rows: 52px minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    border-left: 1px solid var(--v4-rowline);
    background: var(--v4-secondary-sidebar);
    color: var(--v4-text-1);
  }

  .ph {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--v4-rowline);
    font-size: 13px;
    font-weight: 500;
    min-width: 0;
  }

  .ph-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grow {
    flex: 1;
  }

  .icon-btn {
    width: 26px;
    height: 26px;
    flex: none;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    cursor: default;
  }

  .icon-btn:hover,
  .ti:hover {
    background: var(--v4-control-faint);
  }

  .pb {
    overflow: auto;
    overscroll-behavior: contain;
    contain: content;
    padding: 14px 16px 24px;
  }

  .kind {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--v4-text-2);
    margin: 12px 0 6px;
  }

  .kind:first-child {
    margin-top: 0;
  }

  .now {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0 8px;
  }

  .now-title {
    font-size: 13px;
    color: var(--v4-text-3);
  }

  .now.is-live .now-title {
    color: var(--v4-text-1);
  }

  .tl {
    display: flex;
    flex-direction: column;
  }

  .ti {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 5px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font: inherit;
    font-size: 13px;
    text-align: left;
    color: var(--v4-text-2);
    white-space: nowrap;
    cursor: default;
  }

  .ti[aria-selected="true"] {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .ti-t {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .id,
  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .id {
    color: var(--v4-text-3);
  }

  .ti i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-idle);
    justify-self: center;
  }

  .ti i.done {
    background: var(--v4-text-3);
  }

  .ti i.live,
  .ldot {
    background: var(--v4-ok);
    animation: dot-pulse 1.8s ease-in-out infinite;
  }

  .ldot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 6px;
  }

  .td {
    margin: 8px 0 4px;
    padding: 10px 0 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .td h3 {
    font-size: 13px;
    font-weight: 500;
    margin: 0 0 4px;
  }

  .td p,
  .note {
    font-size: 13px;
    color: var(--v4-text-2);
    margin: 0 0 8px;
    line-height: 1.45;
  }

  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid var(--v4-control-border);
    border-radius: 999px;
    font-size: 13px;
    color: var(--v4-text-2);
  }

  .ac {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ac div {
    display: flex;
    gap: 8px;
    font-size: 13px;
    color: var(--v4-text-2);
    align-items: flex-start;
  }

  .ac div::before {
    content: "";
    width: 12px;
    height: 12px;
    flex: none;
    margin-top: 2px;
    border: 1px solid var(--v4-control-border);
    border-radius: 3px;
  }

  .ac div.ok::before {
    background: var(--v4-text-3);
    border-color: transparent;
  }

  .kv {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 4px 8px;
    margin: 8px 0 0;
    font-size: 13px;
  }

  .kv dt {
    color: var(--v4-text-3);
  }

  .kv dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 12px;
  }



  .sk-row {
    height: 12px;
    margin: 9px 6px;
    border-radius: 6px;
    background: var(--v4-control-faint);
  }

  .sk-row.short {
    width: 55%;
  }

  @keyframes dot-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ti i.live,
    .ldot {
      animation: none;
    }
  }
</style>
