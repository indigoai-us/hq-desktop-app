<script lang="ts">
  /**
   * StoryList — horizontal-row list view of a project's tasks (DESKTOP-005).
   *
   * Shares the same four operational columns as StoryKanban (Not started ·
   * In progress · Active · Complete). Presentational only — emits onselect(story).
   */
  import {
    classifyTasks,
    TASK_COLUMN_LABEL,
    type PortfolioSessionRef,
    type Story,
    type TaskColumn,
  } from '../lib/projects-model';
  import LabelChip from './LabelChip.svelte';

  interface Props {
    /** The stories to render (US-004 Story shape). */
    stories: Story[];
    /** Live sessions for Active column placement. */
    sessions?: readonly PortfolioSessionRef[];
    /** Compact relative "now" (reserved for future live list meta). */
    now?: number;
    /** Fired when a row is activated by click or keyboard. */
    onselect?: (story: Story) => void;
  }

  let { stories, sessions = [], now: _now = Date.now(), onselect }: Props = $props();

  const classified = $derived(classifyTasks(stories ?? [], sessions));

  function priorityLabel(priority: number | undefined): string | null {
    return typeof priority === 'number' ? `P${priority}` : null;
  }

  function acCount(story: Story): { complete: number; total: number } {
    const total = story.acceptanceCriteria?.length ?? 0;
    return { complete: story.passes ? total : 0, total };
  }

  function activate(story: Story): void {
    onselect?.(story);
  }

  function handleKeydown(event: KeyboardEvent, story: Story): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect?.(story);
    }
  }

  function columnOf(column: TaskColumn): string {
    return TASK_COLUMN_LABEL[column];
  }
</script>

<div class="story-list" aria-label="Tasks" data-testid="story-list">
  {#if classified.length === 0}
    <div class="empty-state">
      <p>No tasks</p>
      <span>This project has no tasks yet.</span>
    </div>
  {:else}
    {#each classified as item (item.story.id)}
      {@const labels = item.story.labels ?? []}
      {@const visibleLabels = labels.slice(0, 3)}
      {@const overflow = labels.length - visibleLabels.length}
      {@const ac = acCount(item.story)}
      {@const prio = priorityLabel(item.story.priority)}
      <button
        type="button"
        class="story-row"
        class:is-complete={item.story.passes}
        class:is-active={item.column === 'active'}
        aria-label={`Story ${item.story.id}: ${item.story.title}`}
        onclick={() => activate(item.story)}
        onkeydown={(event) => handleKeydown(event, item.story)}
      >
        <span class="state-dot" data-column={item.column}></span>
        <span class="story-id">{item.story.id}</span>
        <div class="story-main">
          <span class="story-title" title={item.story.title}>{item.story.title}</span>
          {#if labels.length > 0}
            <div class="row-labels">
              {#each visibleLabels as label (label)}
                <LabelChip {label} />
              {/each}
              {#if overflow > 0}
                <span class="label-overflow" title={`${overflow} more`}>+{overflow}</span>
              {/if}
            </div>
          {/if}
        </div>
        <span class="state-badge" data-column={item.column}>{columnOf(item.column)}</span>
        {#if prio}
          <span class="priority-badge" data-priority={prio}>{prio}</span>
        {/if}
        {#if ac.total > 0}
          <span class="ac-count">{ac.complete}/{ac.total}</span>
        {/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .story-list {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-1);
    min-width: 0;
  }

  .story-row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-3);
    width: 100%;
    min-width: 0;
    padding: var(--v4-space-2) var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    text-align: left;
    cursor: pointer;
    transition:
      background 150ms ease,
      border-color 150ms ease;
  }

  .story-row:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }

  .story-row:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .story-row.is-complete {
    opacity: 0.6;
  }

  .story-row.is-active {
    border-color: color-mix(in srgb, var(--v4-ok) 32%, var(--v4-hairline));
  }

  .state-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-text-3);
  }

  .state-dot[data-column='in-progress'] {
    background: var(--v4-warn);
  }

  .state-dot[data-column='active'] {
    background: var(--v4-ok);
  }

  .state-dot[data-column='complete'] {
    background: var(--v4-text-2);
  }

  .story-id {
    flex: 0 0 auto;
    width: 72px;
    overflow: hidden;
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--type-secondary, var(--text-base));
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .story-main {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .story-title {
    flex: 0 1 auto;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-labels {
    display: flex;
    flex: 0 1 auto;
    gap: var(--v4-space-1);
    min-width: 0;
    overflow: hidden;
  }

  .state-badge,
  .priority-badge,
  .label-overflow {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    padding: 1px 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: var(--type-metadata, var(--text-base));
    font-weight: 600;
    line-height: 16px;
  }

  .state-badge[data-column='in-progress'] {
    color: var(--v4-warn);
  }

  .state-badge[data-column='active'] {
    color: var(--v4-ok);
  }

  .state-badge[data-column='complete'] {
    color: var(--v4-text-3);
  }

  .priority-badge {
    font-variant-numeric: tabular-nums;
  }

  .priority-badge[data-priority='P1'] {
    border-color: var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-error);
  }
  .priority-badge[data-priority='P2'] {
    border-color: var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-warn);
  }
  .priority-badge[data-priority='P3'] {
    border-color: var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
  }

  .ac-count {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-base));
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .empty-state {
    padding: var(--v4-space-6);
    border: 1px dashed var(--v4-control-border);
    border-radius: 0;
    background: transparent;
    text-align: center;
  }

  .empty-state p {
    margin: 0 0 var(--v4-space-1);
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .empty-state span {
    color: var(--v4-text-2);
    font-size: var(--type-secondary, var(--text-base));
  }

  @media (prefers-reduced-motion: reduce) {
    .story-row {
      transition: none;
    }
  }
</style>
