<script lang="ts">
  /**
   * StoryList — horizontal-row list view of a project's stories (US-006).
   *
   * Ported from hq-desktop's kanban-board.tsx StoryListRow, restyled to the
   * HQ Sync unified desktop token set (monochrome glass; no hardcoded hex).
   * Each row reads: state dot · ID · title + labels · state badge · priority ·
   * AC count. Presentational only — emits onselect(story); does not load data.
   */
  import {
    classifyStories,
    type Story,
    type StoryState,
  } from '../lib/projects-model';
  import LabelChip from './LabelChip.svelte';

  interface Props {
    /** The stories to render (US-004 Story shape). */
    stories: Story[];
    /** Fired when a row is activated by click or keyboard. */
    onselect?: (story: Story) => void;
  }

  let { stories, onselect }: Props = $props();

  // Reuse US-004's classifier so the list shares the board's state derivation.
  const classified = $derived(classifyStories(stories ?? []));

  const STATE_LABELS: Record<StoryState, string> = {
    pending: 'Pending',
    blocked: 'Blocked',
    'in-progress': 'In Progress',
    complete: 'Complete',
  };

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
</script>

<div class="story-list" aria-label="Stories">
  {#if classified.length === 0}
    <div class="empty-state">
      <p>No stories</p>
      <span>This project has no stories yet.</span>
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
        aria-label={`Story ${item.story.id}: ${item.story.title}`}
        onclick={() => activate(item.story)}
        onkeydown={(event) => handleKeydown(event, item.story)}
      >
        <span class="state-dot" data-state={item.state}></span>
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
        <span class="state-badge" data-state={item.state}>{STATE_LABELS[item.state]}</span>
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
    border-radius: var(--v4-radius-button);
    background: var(--v4-raised);
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

  .state-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-text-3);
  }

  /* Status carried by neutral surface layering + the muted/emerald markers the
     desktop token set permits — no severity palette. */
  .state-dot[data-state='blocked'] {
    background: var(--v4-warn);
  }

  .state-dot[data-state='in-progress'] {
    background: var(--v4-ok);
  }

  .state-dot[data-state='complete'] {
    background: var(--v4-text-2);
  }

  .story-id {
    flex: 0 0 auto;
    width: 56px;
    overflow: hidden;
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--text-base);
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
    font-size: var(--text-base);
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
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 16px;
  }

  .state-badge[data-state='blocked'] {
    color: var(--v4-warn);
  }

  .state-badge[data-state='in-progress'] {
    color: var(--v4-ok);
  }

  .state-badge[data-state='complete'] {
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
    font-size: var(--text-base);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .empty-state {
    padding: var(--v4-space-6);
    border: 1px dashed var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-raised);
    text-align: center;
  }

  .empty-state p {
    margin: 0 0 var(--v4-space-1);
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .empty-state span {
    color: var(--v4-text-2);
    font-size: var(--text-base);
  }

  @media (prefers-reduced-motion: reduce) {
    .story-row {
      transition: none;
    }
  }
</style>
