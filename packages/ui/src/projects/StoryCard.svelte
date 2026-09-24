<script lang="ts">
  import type { Story, StoryLiveRunView } from "./projects-model.js";
  import { relativeActivity } from "../common/relative-activity.js";
  import LabelChip from "../common/LabelChip.svelte";
  import IdentityMark from "../chat/messaging/IdentityMark.svelte";
  import { identityAvatarSrc } from "./project-view.js";

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
    typeof story.priority === "number" ? `P${story.priority}` : null,
  );
  const modelHint = $derived(story.model_hint ?? null);
  const assignee = $derived(story.assignee ?? null);
  const assigneeLabel = $derived(assignee?.displayName ?? "Unassigned");

  function activate(): void {
    onselect?.(story);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
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
  aria-label={`Story ${story.id}: ${story.title}. Assignee ${assigneeLabel}`}
  title={liveRun === null && stateContext ? stateContext : undefined}
  onclick={activate}
  onkeydown={handleKeydown}
>
  <div class="card-top">
    <span class="story-id">{story.id}</span>
    <div class="badges">
      {#if modelHint}
        <span class="model-badge" title={`Model hint: ${modelHint}`}
          >{modelHint}</span
        >
      {/if}
      {#if priorityLabel}
        <span class="priority-badge" data-priority={priorityLabel}
          >{priorityLabel}</span
        >
      {/if}
    </div>
  </div>

  <h4 class="story-title" title={story.title}>{story.title}</h4>

  {#if labels.length > 0}
    <div class="labels">
      {#each visibleLabels as label (label)}
        <LabelChip {label} />
      {/each}
      {#if overflowCount > 0}
        <span class="label-overflow" title={`${overflowCount} more`}
          >+{overflowCount}</span
        >
      {/if}
    </div>
  {/if}

  {#if liveRun}
    <div
      class="live-run"
      data-testid="story-live-run"
      title={liveRun.subagents !== null
        ? `${liveRun.subagents} ${liveRun.subagents === 1 ? "subagent" : "subagents"}`
        : undefined}
    >
      <span class="live-dot" aria-hidden="true"></span>
      <span class="live-run-text">
        {liveRun.phase ?? "Live"}
        {#if liveRun.elapsed}
          · <span class="live-run-time">{liveRun.elapsed}</span>
        {/if}
        · {liveRun.workers}
        {liveRun.workers === 1 ? "worker" : "workers"}
        {#if liveRun.lastSignalAt}
          · {relativeActivity(liveRun.lastSignalAt, now)}
        {/if}
      </span>
    </div>
    {#if liveRun.progressPercent !== null}
      <div class="live-run-track" aria-hidden="true">
        <span style={`--fill: ${Math.max(0, Math.min(1, liveRun.progressPercent / 100))}`}></span>
      </div>
    {/if}
  {/if}

  <div class="card-foot">
    <div
      class="assignee-row"
      class:is-unassigned={!assignee}
      data-testid="story-assignee"
    >
      {#if assignee}
        <IdentityMark
          size="small"
          kind={assignee.kind}
          label={assignee.displayName}
          avatarUrl={identityAvatarSrc(assignee)}
          agentUid={assignee.kind === "agent" ? assignee.uid : null}
        />
      {/if}
      <span class="assignee-name">{assigneeLabel}</span>
    </div>

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
  </div>
</button>

<style>
  /* A one-track grid (minmax(0, 1fr)) forces every row to shrink to the card
     width; overflow: clip means nothing ever paints outside the card. */
  .story-card {
    flex: none;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: clip;
    padding: 12px;
    border: 1px solid var(--v4-hairline);
    /* Movable work objects may be rounded; board columns stay naked. */
    border-radius: 8px;
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
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

  .story-card > * {
    min-width: 0;
    max-width: 100%;
  }

  .story-card:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }

  .story-card.is-complete .story-title {
    color: var(--v4-text-2);
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
    min-height: 18px;
  }

  .story-id {
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
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
    height: 18px;
    padding: 0 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-3);
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
  }

  .priority-badge {
    font-variant-numeric: tabular-nums;
  }

  .priority-badge[data-priority="P1"] {
    border-color: color-mix(in srgb, var(--v4-error) 40%, transparent);
    background: color-mix(in srgb, var(--v4-error) 10%, transparent);
    color: var(--v4-error);
  }
  .priority-badge[data-priority="P2"] {
    color: var(--v4-text-2);
  }

  .story-title {
    display: -webkit-box;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    /* A single long identifier still wraps inside the clamp. */
    overflow-wrap: anywhere;
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
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
  }

  .card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    margin-top: 4px;
  }

  .assignee-row {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .assignee-name {
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .assignee-row.is-unassigned .assignee-name {
    color: var(--v4-text-3);
  }

  .live-run {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--v4-text-3);
    font-size: 12px;
    line-height: 16px;
  }

  .live-run-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-run-time {
    font-variant-numeric: tabular-nums;
  }

  .live-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }

  .live-run-track {
    height: 3px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .live-run-track span {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
  }

  .ac-progress {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
  }

  .progress-track {
    width: 36px;
    height: 3px;
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
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  @media (prefers-reduced-motion: reduce) {
    .story-card,
    .progress-fill {
      transition: none;
    }
  }
</style>
