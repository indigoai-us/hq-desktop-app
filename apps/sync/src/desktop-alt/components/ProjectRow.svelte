<script lang="ts">
  /**
   * ProjectRow — a single project rendered as a movable portfolio / board card.
   *
   * DESKTOP-004: portfolio cards show real name, description, linked goal, owner,
   * task progress, and state context. Active cards may also show a live-run block
   * built only from real session/store fields (phase, elapsed, workers, progress,
   * last signal) — never synthesized telemetry. Subagent count is omitted when
   * the session contract does not expose it.
   *
   * Also used by ProjectListView (US-007 Board grid): company pill + status tag
   * remain when portfolio extras are not supplied.
   */
  import {
    projectDisplayName,
    projectListStatus,
    projectProgress,
    PROJECT_LIST_STATUS_LABEL,
    type Project,
    type ProjectLiveRunView,
  } from '../lib/projects-model';
  import { relativeActivity } from '../lib/sessions';

  interface Props {
    project: Project;
    /** Whether to show the company pill (hidden when grouped by company). */
    showCompany?: boolean;
    /** Linked goal title when known; omit when unlinked. */
    goalLabel?: string | null;
    /** Owner / lead label when known. */
    ownerLabel?: string | null;
    /**
     * Live run view for Active cards. Only pass when a real live signal exists.
     * When null/undefined, the quiet state-context line is used instead.
     */
    liveRun?: ProjectLiveRunView | null;
    /** Calm non-live state context (e.g. "Started · no active worker"). */
    stateContext?: string | null;
    /** Compact relative "now" for last-signal labels (injected for tests). */
    now?: number;
    onselect?: (project: Project) => void;
    /** Optional goal-link affordance for unlinked portfolio cards. */
    onlinkgoal?: (project: Project) => void;
    linkBusy?: boolean;
  }

  let {
    project,
    showCompany = true,
    goalLabel = null,
    ownerLabel = null,
    liveRun = null,
    stateContext = null,
    now = Date.now(),
    onselect,
    onlinkgoal,
    linkBusy = false,
  }: Props = $props();

  const status = $derived(projectListStatus(project));
  const isLive = $derived(status === 'live' || liveRun !== null);
  const progress = $derived(projectProgress(project.storiesComplete, project.storiesTotal));
  const hasProgress = $derived(progress.total > 0);
  const showPortfolioMeta = $derived(
    goalLabel !== null || ownerLabel !== null || stateContext !== null || liveRun !== null,
  );

  function activate() {
    onselect?.(project);
  }

  function linkGoal(event: MouseEvent) {
    event.stopPropagation();
    onlinkgoal?.(project);
  }
</script>

<button
  type="button"
  class="project-card"
  class:is-live={isLive}
  class:has-live-run={liveRun !== null}
  data-status={status}
  data-testid="project-row"
  aria-label={`Project ${projectDisplayName(project)}`}
  onclick={activate}
>
  <span class="accent" data-status={status} class:live-run={liveRun !== null} aria-hidden="true"></span>

  <div class="card-head">
    {#if ownerLabel}
      <span class="owner-chip" title={ownerLabel}>{ownerLabel}</span>
    {:else}
      <span class="status-tag" data-status={status}>
        <span class="status-dot" class:is-live={isLive} data-status={status} aria-hidden="true"></span>
        {PROJECT_LIST_STATUS_LABEL[status]}
      </span>
    {/if}
    {#if showCompany && project.company && !showPortfolioMeta}
      <span class="pill company" title={project.company}>{project.company}</span>
    {/if}
  </div>

  <div class="title-stack">
    <h3 class="card-name" title={projectDisplayName(project)}>{projectDisplayName(project)}</h3>
    {#if project.description}
      <p class="card-desc">{project.description}</p>
    {/if}
  </div>

  {#if showPortfolioMeta}
    <div class="card-context">
      <span class="context-goal" title={goalLabel ?? 'No linked goal'}>
        {goalLabel ?? 'No linked goal'}
      </span>
      {#if hasProgress}
        <span class="context-tasks">{progress.complete} / {progress.total} tasks</span>
      {/if}
    </div>
  {/if}

  {#if hasProgress}
    <div class="card-progress">
      <div class="progress-track" aria-hidden="true">
        <div
          class="progress-fill"
          data-status={status}
          class:live-run={liveRun !== null}
          style={`width: ${progress.percent}%;`}
        ></div>
      </div>
      {#if !showPortfolioMeta}
        <span class="progress-count">{progress.complete}/{progress.total}</span>
        <span class="progress-percent">{progress.percent}%</span>
      {/if}
    </div>
  {/if}

  {#if liveRun}
    <div class="live-run" data-testid="project-live-run">
      <div class="live-run-head">
        <span class="live-run-phase">
          <span class="live-dot" aria-hidden="true"></span>
          {liveRun.phase ?? 'Live'}
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

  {#if onlinkgoal && !goalLabel}
    <span class="link-row">
      <span
        role="button"
        tabindex="0"
        class="link-nudge"
        class:is-busy={linkBusy}
        onclick={linkGoal}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onlinkgoal?.(project);
          }
        }}
      >
        {linkBusy ? 'Opening…' : 'Link goal'}
      </span>
    </span>
  {/if}
</button>

<style>
  .project-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    width: 100%;
    min-width: 0;
    padding: var(--space-3, 10px) var(--space-3, 10px) var(--space-3, 10px)
      calc(var(--space-3, 10px) + 4px);
    overflow: hidden;
    border: 1px solid var(--border, var(--v4-hairline));
    /* Movable work objects may be rounded; columns stay naked. */
    border-radius: 6px;
    background: var(--row-active, var(--v4-raised));
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      transform 140ms ease;
  }

  .project-card:hover {
    border-color: var(--border-strong, var(--v4-control-border));
    background: var(--row-hover, var(--v4-active-row));
    transform: translateY(-1px);
  }

  .project-card:active {
    transform: translateY(0);
  }

  .project-card:focus-visible {
    outline: 2px solid var(--blue, var(--v4-control-border));
    outline-offset: 2px;
  }

  .project-card.has-live-run {
    border-color: color-mix(in srgb, var(--blue, var(--v4-ok)) 32%, var(--border, var(--v4-hairline)));
  }

  .accent {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: 3px;
    background: var(--muted-3, var(--v4-idle));
    opacity: 0.55;
    transition: opacity 140ms ease;
  }
  .accent[data-status='live'],
  .accent.live-run {
    background: var(--emerald, var(--v4-ok));
  }
  .accent[data-status='in-progress'] {
    background: var(--blue, var(--v4-ok));
  }
  .accent[data-status='complete'] {
    background: var(--muted-2, var(--v4-text-2));
  }
  .project-card:hover .accent {
    opacity: 1;
  }
  .project-card.is-live .accent {
    opacity: 1;
    animation: accent-pulse 1.8s ease-in-out infinite;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 8px);
    min-width: 0;
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .status-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--muted-2, var(--v4-text-2));
    font-family: var(--font-mono);
    font-size: var(--type-metadata, var(--text-micro, 10px));
    font-weight: 600;
    letter-spacing: 0.09em;
    line-height: 15px;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .status-tag[data-status='live'] {
    color: var(--emerald, var(--v4-ok));
  }

  .owner-chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    overflow: hidden;
    padding: 1px 7px;
    border: 1px solid var(--border, var(--v4-hairline));
    border-radius: var(--v4-radius-pill, 999px);
    background: var(--row-hover, var(--v4-control-faint));
    color: var(--muted-2, var(--v4-text-2));
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--muted-3, var(--v4-idle));
  }
  .status-dot[data-status='in-progress'] {
    background: var(--blue, var(--v4-ok));
  }
  .status-dot[data-status='complete'] {
    background: var(--muted-2, var(--v4-text-2));
  }
  .status-dot.is-live {
    background: var(--emerald, var(--v4-ok));
    animation: dot-pulse 1.8s ease-in-out infinite;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    max-width: 50%;
    overflow: hidden;
    padding: 1px 7px;
    border: 1px solid color-mix(in srgb, var(--blue, var(--v4-ok)) 38%, transparent);
    border-radius: 3px;
    background: var(--row-hover, var(--v4-control-faint));
    color: var(--blue, var(--v4-text-2));
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    letter-spacing: 0.05em;
    line-height: 15px;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .card-name {
    margin: 0;
    overflow: hidden;
    color: var(--fg, var(--v4-text-1));
    font-size: var(--type-body, var(--text-base, 12px));
    font-weight: 600;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-desc {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    color: var(--muted, var(--v4-text-3));
    font-size: var(--type-secondary, var(--text-sm, 11px));
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .card-context {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    color: var(--muted-2, var(--v4-text-3));
    font-size: var(--type-metadata, 10px);
    line-height: 1.3;
  }

  .context-goal,
  .context-tasks {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-tasks {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }

  .card-progress {
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
  }

  .progress-track {
    flex: 1 1 auto;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--row-hover, var(--v4-control-faint));
  }

  .progress-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--muted-2, var(--v4-text-2));
    transition: width 300ms ease;
  }
  .progress-fill[data-status='live'],
  .progress-fill.live-run {
    background: var(--emerald, var(--v4-ok));
  }
  .progress-fill[data-status='in-progress'] {
    background: var(--blue, var(--v4-ok));
  }

  .progress-count {
    flex: 0 0 auto;
    color: var(--muted-2, var(--v4-text-2));
    font-size: var(--type-secondary, 11px);
    font-variant-numeric: tabular-nums;
    line-height: 16px;
  }

  .progress-percent {
    flex: 0 0 auto;
    min-width: 30px;
    color: var(--muted-3, var(--v4-text-3));
    font-size: var(--type-secondary, 11px);
    font-variant-numeric: tabular-nums;
    line-height: 16px;
    text-align: right;
  }

  .quiet-run-state {
    color: var(--muted-3, var(--v4-text-3));
    font-size: var(--type-metadata, 10px);
    line-height: 1.3;
  }

  .live-run {
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid color-mix(in srgb, var(--blue, var(--v4-ok)) 22%, var(--border, var(--v4-hairline)));
    border-radius: 6px;
    background: color-mix(in srgb, var(--blue, var(--v4-ok)) 6%, transparent);
  }

  .live-run-head,
  .live-run-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .live-run-phase {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--fg, var(--v4-text-1));
    font-size: var(--type-secondary, 11px);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--emerald, var(--v4-ok));
    animation: dot-pulse 1.8s ease-in-out infinite;
  }

  .live-run-time {
    flex: 0 0 auto;
    color: var(--muted-2, var(--v4-text-2));
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    font-variant-numeric: tabular-nums;
  }

  .live-run-track {
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--row-hover, var(--v4-control-faint));
  }

  .live-run-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--emerald, var(--v4-ok));
  }

  .live-run-foot {
    color: var(--muted-3, var(--v4-text-3));
    font-size: var(--type-metadata, 10px);
    line-height: 1.3;
  }

  .link-row {
    display: flex;
  }

  .link-nudge {
    color: var(--muted-2, var(--v4-text-2));
    font-size: var(--type-secondary, 11px);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .link-nudge.is-busy {
    opacity: 0.52;
    pointer-events: none;
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

  @keyframes accent-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .project-card,
    .progress-fill,
    .accent {
      transition: none;
    }

    .project-card:hover,
    .project-card:active {
      transform: none;
    }

    .status-dot.is-live,
    .project-card.is-live .accent,
    .live-dot {
      animation: none;
    }
  }
</style>
