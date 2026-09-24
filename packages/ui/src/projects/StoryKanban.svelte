<script lang="ts">
  /**
   * StoryKanban — project task board with Board/List toggle (DESKTOP-005).
   *
   * Defaults to four operational columns: Not started · In progress · Active ·
   * Complete. Active requires a live session signal matched to the task; when
   * that signal ends, unfinished work returns to In progress. Board columns are
   * naked (no rounded wells); only task cards / live monitors are rounded.
   *
   * Presentational only: takes `stories` (+ optional sessions / loading /
   * onselect). Data loading lives in a parent.
   */
  import {
    classifyTasks,
    groupByTaskColumn,
    storyLiveRunView,
    taskStateContext,
    TASK_COLUMNS,
    TASK_COLUMN_CAPTION,
    TASK_COLUMN_LABEL,
    type PortfolioSessionRef,
    type Story,
    type TaskColumn,
  } from "./projects-model.js";
  import StoryCard from "./StoryCard.svelte";
  import StoryList from "./StoryList.svelte";

  interface Props {
    /** The stories to render (US-004 Story shape). */
    stories: Story[];
    /**
     * Live agent sessions used for Active placement. Only real running /
     * awaiting_input signals matched to a story id place a card in Active.
     */
    sessions?: readonly PortfolioSessionRef[];
    /** When true, render the loading skeleton instead of content. */
    loading?: boolean;
    /** Compact relative "now" for live elapsed / last-signal labels. */
    now?: number;
    /** Fired when a story card or row is activated. */
    onselect?: (story: Story) => void;
    /**
     * Board / List mode. Bindable so a parent can host the toggle in its own
     * toolbar (ProjectDetailView puts it on the tabs row).
     */
    viewMode?: "board" | "list";
    /** Render the built-in Board/List toggle. Off when the parent hosts it. */
    showToolbar?: boolean;
  }

  let {
    stories,
    sessions = [],
    loading = false,
    now = Date.now(),
    onselect,
    viewMode = $bindable("board"),
    showToolbar = true,
  }: Props = $props();

  // Per-column collapse state, keyed by TaskColumn. Collapsed hides the body.
  let collapsed = $state<Record<TaskColumn, boolean>>({
    "not-started": false,
    "in-progress": false,
    active: false,
    complete: false,
  });

  const classified = $derived(classifyTasks(stories ?? [], sessions));
  const grouped = $derived(groupByTaskColumn(classified));

  function toggleColumn(column: TaskColumn): void {
    collapsed[column] = !collapsed[column];
  }
</script>

<section
  class="story-kanban"
  aria-label="Task board"
  data-testid="story-kanban"
>
  {#if showToolbar}
  <div class="board-toolbar">
    <div class="view-toggle" role="group" aria-label="Board view mode">
      <button
        type="button"
        class="toggle-segment"
        class:is-active={viewMode === "board"}
        aria-pressed={viewMode === "board"}
        data-testid="view-toggle-board"
        onclick={() => (viewMode = "board")}
      >
        Board
      </button>
      <button
        type="button"
        class="toggle-segment"
        class:is-active={viewMode === "list"}
        aria-pressed={viewMode === "list"}
        data-testid="view-toggle-list"
        onclick={() => (viewMode = "list")}
      >
        List
      </button>
    </div>
  </div>
  {/if}

  {#if loading}
    <div class="board-loading" aria-busy="true" aria-label="Loading tasks">
      {#each TASK_COLUMNS as column (column)}
        <div class="skeleton-column">
          <div class="skeleton-header"></div>
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
        </div>
      {/each}
    </div>
  {:else if viewMode === "board"}
    <div class="board-scroll" data-testid="task-kanban">
      <div class="board-grid">
        {#each TASK_COLUMNS as column (column)}
          {@const columnStories = grouped[column]}
          <div
            class="kanban-column"
            data-testid={`task-column-${column}`}
            aria-labelledby={`task-col-${column}`}
          >
            <button
              type="button"
              class="column-header"
              aria-expanded={!collapsed[column]}
              title={TASK_COLUMN_CAPTION[column]}
              onclick={() => toggleColumn(column)}
            >
              {#if column === "active"}
                <span class="live-dot" aria-hidden="true"></span>
              {:else}
                <span
                  class="status-dot"
                  data-column={column}
                  aria-hidden="true"
                ></span>
              {/if}
              <span class="column-label" id={`task-col-${column}`}>
                {TASK_COLUMN_LABEL[column]}
              </span>
              <span class="count-badge">{columnStories.length}</span>
              <span class="visually-hidden">{TASK_COLUMN_CAPTION[column]}</span>
              <span
                class="chevron"
                class:is-open={!collapsed[column]}
                aria-hidden="true"
              >
                <svg viewBox="0 0 16 16">
                  <path
                    d="m6 4 4 4-4 4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
            </button>

            {#if !collapsed[column]}
              <div class="column-body">
                {#if columnStories.length === 0}
                  <div class="column-empty">
                    <span>No tasks</span>
                  </div>
                {:else}
                  {#each columnStories as item (item.story.id)}
                    {@const liveRun = storyLiveRunView(
                      item.story,
                      sessions,
                      now,
                    )}
                    <StoryCard
                      story={item.story}
                      liveRun={column === "active" ? liveRun : null}
                      stateContext={taskStateContext(
                        column,
                        item.story,
                        stories,
                      )}
                      {now}
                      {onselect}
                    />
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="list-scroll">
      <StoryList {stories} {sessions} {now} {onselect} />
    </div>
  {/if}
</section>

<style>
  .story-kanban {
    container: story-kanban / inline-size;
    /* Page ground laid over an opaque surface for the sticky column headers,
       so cards scrolling underneath never show through. */
    --board-sticky-bg: linear-gradient(var(--v4-ground), var(--v4-ground)),
      var(--v4-surface-solid);
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    min-width: 0;
    /* Keep room on a short board, but otherwise flow with the page: the page
       scroller (not the columns) handles long boards. */
    min-height: min(640px, 75vh);
    /* Naked canvas — no board chrome. */
    background: transparent;
  }

  .board-toolbar {
    display: flex;
    flex-shrink: 0;
    justify-content: flex-end;
  }

  /* Segmented Board / List control. */
  .view-toggle {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
  }

  .toggle-segment {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease;
  }

  .toggle-segment:hover {
    color: var(--v4-text-1);
  }

  .toggle-segment.is-active {
    background: var(--v4-raised);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
    color: var(--v4-text-1);
  }

  .toggle-segment:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 1px;
  }

  /* No overflow here on wide canvases: an overflow value would make this the
     sticky headers' scroll container and stop them sticking to the page. */
  .board-scroll {
    flex: 1 0 auto;
    min-width: 0;
    background: transparent;
  }

  .board-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    align-items: stretch;
    min-width: 0;
  }

  /* overflow-x: clip keeps cards inside the column without creating a scroll
     container, so the sticky header still sticks to the page scroller. */
  .kanban-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-x: clip;
    /* Naked columns — no rounded wells, no fills. */
    border-radius: 0;
    background: transparent;
  }

  .column-header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 36px;
    padding: 0 2px;
    border: 0;
    border-bottom: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: var(--board-sticky-bg, var(--v4-surface-solid));
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .column-header:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .status-dot,
  .live-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-text-3);
  }

  .status-dot[data-column="not-started"] {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--v4-text-3);
  }

  .status-dot[data-column="in-progress"] {
    background: var(--v4-text-2);
  }

  .status-dot[data-column="complete"] {
    background: color-mix(in srgb, var(--v4-ok) 70%, var(--v4-text-3));
  }

  .live-dot {
    background: var(--v4-ok);
  }

  .column-label {
    color: var(--v4-text-1);
    font-size: 13px;
    font-weight: 600;
  }

  .count-badge {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 18px;
    padding: 0 6px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  /* Quiet collapse affordance: faint until the header is hovered/focused. */
  .chevron {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    margin-left: auto;
    color: var(--v4-text-3);
    /* Invisible at rest; collapse stays one click away on hover / focus. */
    opacity: 0;
    transition:
      transform 150ms ease,
      opacity 150ms ease;
  }

  .chevron svg {
    width: 12px;
    height: 12px;
  }

  .column-header:hover .chevron,
  .column-header:focus-visible .chevron,
  .column-header[aria-expanded="false"] .chevron {
    opacity: 1;
  }

  .chevron.is-open {
    transform: rotate(90deg);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .column-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    margin-top: 8px;
    padding-bottom: 12px;
  }

  .column-empty {
    padding: 4px 2px;
  }

  .column-empty span {
    color: var(--v4-text-3);
    font-size: 12px;
  }

  .list-scroll {
    flex: 1 0 auto;
    min-width: 0;
  }

  .board-loading {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .skeleton-column {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
  }

  .skeleton-header {
    height: 36px;
    border-radius: 0;
    background: var(--v4-control-faint);
  }

  .skeleton-card {
    height: 84px;
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-control-faint);
  }

  .skeleton-header,
  .skeleton-card {
    animation: skeleton-pulse 1.3s ease-in-out infinite;
  }

  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle-segment,
    .chevron {
      transition: none;
    }

    .skeleton-header,
    .skeleton-card {
      animation: none;
    }
  }

  /* Four columns share the width down to ~640px of canvas; below that the
     board keeps a minimum width and scrolls sideways on its own (headers stop
     sticking only in that narrow case). */
  @container story-kanban (max-width: 640px) {
    .board-toolbar {
      justify-content: flex-start;
    }

    .board-scroll {
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 6px;
    }

    .board-grid {
      grid-template-columns: repeat(4, minmax(150px, 1fr));
    }
  }
</style>
