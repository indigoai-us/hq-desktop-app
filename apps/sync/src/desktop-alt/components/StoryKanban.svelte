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
  } from '../lib/projects-model';
  import StoryCard from './StoryCard.svelte';
  import StoryList from './StoryList.svelte';

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
  }

  let {
    stories,
    sessions = [],
    loading = false,
    now = Date.now(),
    onselect,
  }: Props = $props();

  type ViewMode = 'board' | 'list';
  let viewMode = $state<ViewMode>('board');

  // Per-column collapse state, keyed by TaskColumn. Collapsed hides the body.
  let collapsed = $state<Record<TaskColumn, boolean>>({
    'not-started': false,
    'in-progress': false,
    active: false,
    complete: false,
  });

  const classified = $derived(classifyTasks(stories ?? [], sessions));
  const grouped = $derived(groupByTaskColumn(classified));

  function toggleColumn(column: TaskColumn): void {
    collapsed[column] = !collapsed[column];
  }
</script>

<section class="story-kanban" aria-label="Task board" data-testid="story-kanban">
  <div class="board-toolbar">
    <div class="view-toggle" role="group" aria-label="Board view mode">
      <button
        type="button"
        class="toggle-segment"
        class:is-active={viewMode === 'board'}
        aria-pressed={viewMode === 'board'}
        data-testid="view-toggle-board"
        onclick={() => (viewMode = 'board')}
      >
        Board
      </button>
      <button
        type="button"
        class="toggle-segment"
        class:is-active={viewMode === 'list'}
        aria-pressed={viewMode === 'list'}
        data-testid="view-toggle-list"
        onclick={() => (viewMode = 'list')}
      >
        List
      </button>
    </div>
  </div>

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
  {:else if viewMode === 'board'}
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
              onclick={() => toggleColumn(column)}
            >
              {#if column === 'active'}
                <span class="live-dot" aria-hidden="true"></span>
              {:else}
                <span class="status-dot" data-column={column}></span>
              {/if}
              <span class="column-label" id={`task-col-${column}`}>
                {TASK_COLUMN_LABEL[column]}
              </span>
              <span class="count-badge">{columnStories.length}</span>
              <span class="chevron" class:is-open={!collapsed[column]} aria-hidden="true">›</span>
            </button>
            <span class="column-caption">{TASK_COLUMN_CAPTION[column]}</span>

            {#if !collapsed[column]}
              <div class="column-body">
                {#if columnStories.length === 0}
                  <div class="column-empty">
                    <span>No tasks</span>
                  </div>
                {:else}
                  {#each columnStories as item (item.story.id)}
                    {@const liveRun = storyLiveRunView(item.story, sessions, now)}
                    <StoryCard
                      story={item.story}
                      liveRun={column === 'active' ? liveRun : null}
                      stateContext={taskStateContext(column, item.story, stories)}
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
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    min-width: 0;
    height: 100%;
    /* Naked canvas — no board chrome. */
    background: transparent;
  }

  .board-toolbar {
    display: flex;
    flex-shrink: 0;
    justify-content: flex-end;
  }

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
    padding: var(--v4-space-1) var(--v4-space-3);
    border: 0;
    border-radius: calc(var(--v4-radius-button) - 2px);
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease;
  }

  .toggle-segment:hover {
    color: var(--v4-text-1);
  }

  .toggle-segment.is-active {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .toggle-segment:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .board-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    background: transparent;
  }

  .board-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(180px, 1fr));
    gap: var(--v4-space-4);
    min-width: 720px;
    height: 100%;
  }

  .kanban-column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* Naked columns — no rounded wells, no fills. */
    border-radius: 0;
    background: transparent;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    width: 100%;
    padding: var(--v4-space-2) 0;
    border: 0;
    border-bottom: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  .column-header:hover {
    background: var(--v4-active-row);
  }

  .column-header:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .status-dot,
  .live-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-text-3);
  }

  .status-dot[data-column='in-progress'] {
    background: var(--v4-warn);
  }

  .status-dot[data-column='complete'] {
    background: var(--v4-text-2);
  }

  .live-dot {
    background: var(--v4-ok);
  }

  .column-label {
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
  }

  .column-caption {
    margin-top: 2px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.3;
  }

  .count-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-base));
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    line-height: 16px;
  }

  .chevron {
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
    line-height: 1;
    transition: transform 150ms ease;
  }

  .chevron.is-open {
    transform: rotate(90deg);
  }

  .column-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-height: 0;
    margin-top: var(--v4-space-2);
    overflow-y: auto;
    padding-right: var(--v4-space-1);
  }

  .column-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--v4-space-5);
    border: 1px dashed var(--v4-hairline);
    border-radius: 0;
  }

  .column-empty span {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-base));
  }

  .list-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .board-loading {
    display: grid;
    grid-template-columns: repeat(4, minmax(180px, 1fr));
    gap: var(--v4-space-4);
    min-width: 720px;
  }

  .skeleton-column {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
  }

  .skeleton-header {
    height: 28px;
    border-radius: 0;
    background: var(--v4-control-faint);
  }

  .skeleton-card {
    height: 84px;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
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
    .column-header,
    .chevron {
      transition: none;
    }

    .skeleton-header,
    .skeleton-card {
      animation: none;
    }
  }

  /* Keep Board/List + column headers visible; board may horizontal-scroll. */
  @container story-kanban (max-width: 760px) {
    .board-toolbar {
      justify-content: flex-start;
    }

    .board-scroll {
      overflow-x: auto;
      overflow-y: hidden;
    }

    .board-grid,
    .board-loading {
      grid-template-columns: repeat(4, minmax(180px, 1fr));
      min-width: 720px;
      height: 100%;
    }

    .kanban-column {
      min-height: 0;
    }

    .column-body {
      overflow-y: auto;
      padding-right: var(--v4-space-1);
    }
  }
</style>
