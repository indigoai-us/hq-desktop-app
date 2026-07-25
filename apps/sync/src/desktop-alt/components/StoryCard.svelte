<script lang="ts">
  import type { Story, StoryLiveRunView } from '../lib/projects-model';
  import { relativeActivity } from '../lib/sessions';
  import LabelChip from './LabelChip.svelte';

  /**
   * StoryCard — a single project task as a movable work object (DESKTOP-005).
   *
   * Active cards may show a live-run block built only from real session/story
   * fields (phase, elapsed, workers, progress, last signal) — never synthesized
   * telemetry. Subagent count is omitted when the session contract does not
   * expose it. Missing fields are omitted or labeled unavailable.
   *
   * Normal running / awaiting-input phases are calm status — no alert thresholds.
   */
  type StoryWithModelHint = Story & { model_hint?: string | null };

  interface Props {
    /** The story to render (US-004 Story shape). */
    story: StoryWithModelHint;
    /**
     * Live run view for Active cards. Only pass when a real live signal exists.
     * When null/undefined, the quiet state-context line is used instead.
     */
    liveRun?: StoryLiveRunView | null;
    /** Calm non-live state context (e.g. "Started · no active worker"). */
    stateContext?: string | null;
    /** Compact relative "now" for last-signal labels (injected for tests). */
    now?: number;
    /** Fired when the card is activated by click or keyboard. */
    onselect?: (story: Story) => void;
  }

  let {
    story,
    liveRun = null,
    stateContext = null,
    now = Date.now(),
    onselect,
  }: Props = $props();

  const labels = $derived(story.labels ?? []);
  const visibleLabels = $derived(labels.slice(0, 2));
  const overflowCount = $derived(labels.length - visibleLabels.length);

  const acTotal = $derived(story.acceptanceCriteria?.length ?? 0);
  // AC progress: the Story type carries no per-AC done flags, only a story-level
  // `passes`. Completed stories read full (acTotal/acTotal) and everything else 0.
  const acComplete = $derived(story.passes ? acTotal : 0);
  const acPercent = $derived(acTotal > 0 ? (acComplete / acTotal) * 100 : 0);

  const priorityLabel = $derived(
    typeof story.priority === 'number' ? `P${story.priority}` : null,
  );
  const modelHint = $derived(story.model_hint ?? null);

  function activate(): void {
    onselect?.(story);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect?.(story);
    }
  }
</script>

<button
  type="button"
  class="story-card"
  class:is-complete={story.passes}
  class:has-live-run={liveRun !== null}
  data-priority={priorityLabel}
  data-testid="story-card"
  aria-label={`Story ${story.id}: ${story.title}`}
  onclick={activate}
  onkeydown={handleKeydown}
>
  <div class="card-top">
    <span class="story-id">{story.id}</span>
    <div class="badges">
      {#if modelHint}
        <span class="model-badge" title={`Model hint: ${modelHint}`}>{modelHint}</span>
      {/if}
      {#if priorityLabel}
        <span class="priority-badge" data-priority={priorityLabel}>{priorityLabel}</span>
      {/if}
    </div>
  </div>

  <div class="title-stack">
    <h4 class="story-title" title={story.title}>{story.title}</h4>
  </div>

  {#if labels.length > 0}
    <div class="labels">
      {#each visibleLabels as label (label)}
        <LabelChip {label} />
      {/each}
      {#if overflowCount > 0}
        <span class="label-overflow" title={`${overflowCount} more`}>+{overflowCount}</span>
      {/if}
    </div>
  {/if}

  {#if liveRun}
    <div class="live-run" data-testid="story-live-run">
      <div class="live-run-head">
        <span class="live-run-phase">
          <span class="live-dot" aria-hidden="true"></span>
          {#if liveRun.phase}
            {liveRun.phase}
          {/if}
        </span>
        {#if liveRun.elapsed}
          <span class="live-run-time">{liveRun.elapsed}</span>
        {/if}
      </div>
      {#if liveRun.progressPercent !== null}
        <div class="live-run-track" aria-hidden="true">
          <span style={`width: ${liveRun.progressPercent}%`}></span>
        </div>
      {/if}
      <div class="live-run-foot">
        <span>
          {liveRun.workers}
          {liveRun.workers === 1 ? 'worker' : 'workers'}
          {#if liveRun.subagents !== null}
            · {liveRun.subagents}
            {liveRun.subagents === 1 ? 'subagent' : 'subagents'}
          {:else}
            · subagents unavailable
          {/if}
        </span>
        <span>
          {#if liveRun.lastSignalAt}
            {relativeActivity(liveRun.lastSignalAt, now)}
          {:else}
            signal unavailable
          {/if}
        </span>
      </div>
    </div>
  {:else if stateContext}
    <span class="quiet-run-state">{stateContext}</span>
  {/if}

  {#if acTotal > 0 && liveRun === null}
    <div class="ac-progress">
      <div
        class="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={acTotal}
        aria-valuenow={acComplete}
        aria-label="Acceptance criteria complete"
      >
        <div
          class="progress-fill"
          style={`--progress-scale: ${Math.max(0, Math.min(1, acPercent / 100))}`}
        ></div>
      </div>
      <span class="ac-count">{acComplete}/{acTotal}</span>
    </div>
  {/if}
</button>

<style>
  .story-card {
    display: grid;
    gap: var(--v4-space-2);
    width: 100%;
    min-width: 0;
    padding: var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    /* Movable work objects may be rounded; board columns stay naked. */
    border-radius: 6px;
    background: var(--v4-raised);
    box-shadow: var(--v4-shadow-card);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    text-align: left;
    cursor: pointer;
    transition:
      background 150ms ease,
      border-color 150ms ease;
  }

  .story-card:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }

  .story-card:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .story-card.is-complete {
    opacity: 0.6;
  }

  .story-card.has-live-run {
    border-color: color-mix(in srgb, var(--v4-ok) 32%, var(--v4-hairline));
  }

  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .story-id {
    overflow: hidden;
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--type-secondary, var(--text-base));
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badges {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--v4-space-1);
  }

  .model-badge,
  .priority-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    line-height: 14px;
    text-transform: uppercase;
  }

  .priority-badge {
    font-variant-numeric: tabular-nums;
    text-transform: none;
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

  .title-stack {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .story-title {
    display: -webkit-box;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
    line-height: 18px;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-1);
    min-width: 0;
  }

  .label-overflow {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-base));
    font-weight: 600;
    line-height: 16px;
  }

  .quiet-run-state {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-base));
    line-height: 1.3;
  }

  .live-run {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    padding: var(--v4-space-2);
    border: 1px solid color-mix(in srgb, var(--v4-ok) 28%, var(--v4-hairline));
    border-radius: 6px;
    background: color-mix(in srgb, var(--v4-ok) 8%, var(--v4-raised));
  }

  .live-run-head,
  .live-run-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .live-run-phase {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-secondary, var(--text-base));
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }

  .live-run-time,
  .live-run-foot {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-variant-numeric: tabular-nums;
  }

  .live-run-foot span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-run-track {
    height: 4px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .live-run-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
  }

  .ac-progress {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .progress-track {
    flex: 1;
    height: 5px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .progress-fill {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
    transform: scaleX(var(--progress-scale, 0));
    transform-origin: left center;
    transition: transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .ac-count {
    flex-shrink: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-base));
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  @media (prefers-reduced-motion: reduce) {
    .story-card,
    .progress-fill {
      transition: none;
    }
  }
</style>
