<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  /**
   * ProjectRow — a single project rendered as a movable portfolio / board card.
   *
   * DESKTOP-004: portfolio cards show real name, description, linked goal,
   * task progress and the responsible person. The card stays calm: the column
   * already says the state, so there is no status eyebrow, no source path and
   * no run sentence. Active cards may show one short live-run line built only
   * from real session/store fields (phase, elapsed, workers, last signal) —
   * never synthesized telemetry.
   *
   * Also used by ProjectListView (US-007 Board grid): a quiet status label and
   * company pill remain when portfolio extras are not supplied.
   */
  import {
    projectDisplayName,
    projectListStatus,
    projectProgress,
    PROJECT_LIST_STATUS_LABEL,
    type Project,
    type ProjectLiveRunView,
  } from "./projects-model.js";
  import {
    mergeProvenance,
    normalizeProvenance,
    provenanceView,
  } from "../common/provenance.js";
  import { relativeActivity } from "../common/relative-activity.js";
  import BoardFaces from "./BoardFaces.svelte";
  import ProjectRepoChips from "./ProjectRepoChips.svelte";
  import { boardFaces, faceInitials, facesCaption } from "./board-faces.js";
  import { projectUpdatedAt, storiesLabel, updatedLabel } from "./project-card.js";
  import type { PortfolioColumn } from "./projects-model.js";

  interface Props {
    project: Project;
    /** Whether to show the company pill (hidden when grouped by company). */
    showCompany?: boolean;
    /** Linked goal title when known; omit when unlinked. */
    goalLabel?: string | null;
    /** Genuine owner label from a legacy portfolio caller, when known. */
    ownerLabel?: string | null;
    /** The cloud attribution lookup failed; local provenance remains authoritative. */
    provenanceUnavailable?: boolean;
    /**
     * Live run view for Active cards. Only pass when a real live signal exists.
     */
    liveRun?: ProjectLiveRunView | null;
    /**
     * Calm non-live state context (e.g. "Started · no active worker"). The
     * column already carries the state, so this is only offered as a tooltip.
     */
    stateContext?: string | null;
    /** Why an Active card is active, e.g. "active · Corey, 4 min ago". */
    activityLabel?: string | null;
    /** Compact relative "now" for last-signal labels (injected for tests). */
    now?: number;
    onselect?: (project: Project) => void;
    /** Optional goal-link affordance for unlinked portfolio cards. */
    onlinkgoal?: (project: Project) => void;
    linkBusy?: boolean;
    /** Board column the card sits in; colors the state dot like the header. */
    column?: PortfolioColumn | null;
  }

  let {
    project,
    column = null,
    showCompany = true,
    goalLabel = null,
    ownerLabel = null,
    provenanceUnavailable = false,
    liveRun = null,
    stateContext = null,
    activityLabel = null,
    now = Date.now(),
    onselect,
    onlinkgoal,
    linkBusy = false,
  }: Props = $props();

  const status = $derived(projectListStatus(project));
  const isLive = $derived(status === "live" || liveRun !== null);
  const progress = $derived(
    projectProgress(project.storiesComplete, project.storiesTotal),
  );
  const hasProgress = $derived(progress.total > 0);
  const showPortfolioMeta = $derived(
    goalLabel !== null || stateContext !== null || liveRun !== null,
  );
  const cardProvenance = $derived(
    mergeProvenance(
      project.provenance,
      normalizeProvenance(ownerLabel ? { owner: ownerLabel } : null),
    ),
  );
  const provenance = $derived(
    provenanceView(cardProvenance, "project", provenanceUnavailable),
  );
  /** Owner first, then assignee, then creator — up to three distinct people. */
  const people = $derived(
    provenance.people
      .map((p) => p.label)
      .filter((label, index, all) => label.trim() !== "" && all.indexOf(label) === index)
      .slice(0, 3),
  );
  const stories = $derived(storiesLabel(progress.complete, progress.total));
  const updatedAt = $derived(projectUpdatedAt(project));
  const updated = $derived(updatedLabel(updatedAt, now));
  const hasRepos = $derived((project.repos?.length ?? 0) > 0 || Boolean(project.branchName));
  /** Active cards: humans (circles) then live bots (rounded squares). */
  const liveFaces = $derived(
    liveRun
      ? boardFaces(
          provenance.people.map((p) => p.label),
          liveRun.bots ?? Array.from({ length: liveRun.workers }, () => "bot"),
        )
      : [],
  );

  function activate() {
    onselect?.(project);
  }

  function linkGoal(event: MouseEvent) {
    event.stopPropagation();
    onlinkgoal?.(project);
  }
</script>

<article
  class="project-card"
  class:has-live-run={liveRun !== null}
  data-status={status}
  data-column={column ?? undefined}
  data-testid="project-row"
>
  <button
    type="button"
    class="project-open"
    aria-label={`Project ${projectDisplayName(project)}`}
    onclick={activate}
  >
    <h3 class="card-name" title={projectDisplayName(project)}>
      {projectDisplayName(project)}
    </h3>
    {#if project.description}
      <p class="card-desc" title={project.description}>{project.description}</p>
    {/if}

    {#if hasRepos}
      <ProjectRepoChips repos={project.repos ?? []} branch={project.branchName ?? null} />
    {/if}

    {#if goalLabel || (showCompany && project.company && !showPortfolioMeta)}
      <div class="card-chips">
        {#if goalLabel}
          <span class="chip goal-chip" title={`Goal: ${goalLabel}`}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
            </svg>
            <span class="chip-text">{goalLabel}</span>
          </span>
        {/if}
        {#if showCompany && project.company && !showPortfolioMeta}
          <span class="chip company" title={project.company}
            ><span class="chip-text"
              ><CompanyLabel name={project.company} companyUid={project.company} /></span
            ></span
          >
        {/if}
      </div>
    {/if}

    {#if liveRun}
      <div class="live-row">
        <span
          class="chip live"
          data-testid="project-live-run"
          title={liveRun.lastSignalAt
            ? `Last signal ${relativeActivity(liveRun.lastSignalAt, now)}`
            : undefined}
        >
          <span class="live-dot" aria-hidden="true"></span>
          <span class="live-run-text"
            >{liveRun.phase ?? "Live"}{#if liveRun.elapsed}&nbsp;·&nbsp;<span class="live-run-time"
                >{liveRun.elapsed}</span
              >{/if}</span
          >
        </span>
      </div>
      {#if liveFaces.length > 0}
        <div class="live-row faces-row" data-testid="project-live-faces">
          <BoardFaces faces={liveFaces} />
          <span class="faces-caption">{facesCaption(liveFaces)}</span>
        </div>
      {/if}
    {/if}

    <div class="card-foot" title={stateContext ?? undefined}>
      {#if hasProgress}
        <div class="card-progress">
          <div class="progress-track" aria-hidden="true">
            <div
              class="progress-fill"
              data-status={status}
              class:live-run-fill={liveRun !== null}
              style={`--fill: ${progress.percent / 100};`}
            ></div>
          </div>
          <span
            class="progress-count"
            data-testid="project-stories"
            aria-label={`${progress.complete} of ${progress.total} tasks complete`}
            >{stories}</span
          >
        </div>
      {:else}
        <span class="foot-quiet">No tasks yet</span>
      {/if}

      {#if !showPortfolioMeta}
        <span class="status-label" data-status={status}>
          {#if isLive}<span class="status-dot is-live" aria-hidden="true"></span>{/if}
          {PROJECT_LIST_STATUS_LABEL[status]}
        </span>
      {/if}

      {#if people.length > 0 && liveFaces.length === 0}
        <span
          class="person"
          data-testid="project-card-provenance"
          aria-label={provenance.ariaLabel}
          title={provenance.ariaLabel}
        >
          {#each people as label (label)}
            <span class="avatar" aria-hidden="true">{faceInitials(label)}</span>
          {/each}
        </span>
      {/if}
    </div>

    {#if activityLabel || updated}
      <p class="card-meta" data-testid="project-card-meta">
        {#if activityLabel && !liveRun}
          <span class="card-activity" data-testid="project-activity"
            >{activityLabel}</span
          >
        {:else if updated}
          <span data-testid="project-updated">{updated}</span>
        {/if}
      </p>
    {/if}
  </button>

  {#if onlinkgoal && !goalLabel}
    <button
      type="button"
      class="link-nudge"
      class:is-busy={linkBusy}
      disabled={linkBusy}
      aria-busy={linkBusy}
      aria-label={linkBusy ? "Opening goal link" : "Link goal"}
      title={linkBusy ? "Opening…" : "Link goal"}
      onclick={linkGoal}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M6.8 9.2 9.2 6.8M7.4 4.6l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9M8.6 11.4l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    </button>
  {/if}
</article>

<style>
  /* Hit area (AUDIT-2-10..13): every control here has at least a 28x28 px
     clickable box. The ::after pad grows only the axes under 28 px, so the
     drawn size and layout stay as they are. Kept first so a later
     position rule (e.g. absolute) still wins. */
  .project-open, .link-nudge { position: relative; }
  .project-open::after,
  .link-nudge::after {
    content: "";
    position: absolute;
    inset: min(0px, calc(50% - 14px));
  }
  .project-card {
    position: relative;
    /* Cards sit in flex columns; never let the column squeeze them. */
    flex: none;
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    /* Nothing inside a card may ever paint outside it. clip (not hidden)
       does not create a scroll container. */
    overflow: clip;
    border: 1px solid var(--v4-hairline);
    /* Movable work objects may be rounded; columns stay naked. */
    border-radius: 8px;
    background: var(--v4-raised);
    color: inherit;
    font: inherit;
    text-align: left;
    transition:
      background 140ms ease,
      border-color 140ms ease;
  }

  .project-card.has-live-run {
    border-color: color-mix(in srgb, var(--v4-ok) 32%, var(--v4-hairline));
  }

  /* A one-track grid (minmax(0, 1fr)) forces every row to shrink to the card
     width, so long titles ellipsize instead of widening the button. */
  .project-open {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    padding: 16px;
    border: 0;
    border-radius: inherit;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  @media (hover: hover) and (pointer: fine) {
    .project-card:hover {
      border-color: var(--v4-control-border);
      background: var(--v4-active-row);
    }
  }

  .project-open > * {
    min-width: 0;
    max-width: 100%;
  }

  /* Inset focus rings: the card clips anything drawn outside it. */
  .project-open:focus-visible,
  .link-nudge:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .card-name {
    margin: 0;
    /* Leave room for the hover link button in the top-right corner. */
    padding-right: 24px;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.4;
    /* Two lines, so projects with similar names can be told apart. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }

  /* One muted line under the title; the full text is in the tooltip. */
  .card-desc {
    min-width: 0;
    margin: -4px 0 0;
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: 13px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    min-width: 0;
    height: 20px;
    padding: 0 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: 13px;
    line-height: 1;
  }

  .chip svg {
    flex: 0 0 auto;
    width: 11px;
    height: 11px;
    color: var(--v4-text-3);
  }

  .chip-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px solid var(--v4-rowline);
  }

  .card-progress {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .progress-track {
    flex: 1 1 auto;
    min-width: 16px;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--v4-control-faint);
  }

  .progress-fill {
    width: 100%;
    height: 100%;
    border-radius: 999px;
    background: var(--v4-text-2);
    /* Fill ratio via --fill (0..1) + scaleX so the transition runs on the
       compositor; the track clips + rounds the visible bar. */
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
    transition: transform 300ms ease;
  }
  /* Green is reserved for live work; a finished bar reads in full text. */
  /* Only a real live run paints the bar green; a "live" PRD status without a
     live session is not live work. */
  .progress-fill.live-run-fill {
    background: var(--v4-ok);
  }
  .progress-fill[data-status="complete"]:not(.live-run-fill) {
    background: var(--v4-text-1);
  }

  .progress-count,
  .foot-quiet {
    flex: 0 0 auto;
    color: var(--v4-text-2);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    line-height: 16px;
  }

  .foot-quiet {
    flex: 1 1 auto;
  }

  .status-label {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 5px;
    color: var(--v4-text-3);
    font-size: 13px;
    white-space: nowrap;
  }

  .status-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--v4-idle, var(--v4-text-3));
  }
  .status-dot[data-status="in-progress"] {
    background: var(--v4-text-2);
  }
  .status-dot[data-status="complete"] {
    background: var(--v4-text-1);
  }
  .status-dot.is-live {
    background: var(--v4-ok);
    animation: dot-pulse 1.8s ease-in-out infinite;
  }

  .person {
    display: inline-flex;
    flex: 0 0 auto;
    margin-left: auto;
  }

  .avatar {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: var(--v4-raised);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
    color: var(--v4-text-2);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    letter-spacing: 0;
    line-height: 1;
  }

  /* Owner leads; contributors tuck behind with a ring in the card color. */
  .avatar + .avatar {
    margin-left: -2px;
    box-shadow:
      0 0 0 2px var(--v4-raised),
      inset 0 0 0 1px var(--v4-hairline);
  }

  .live-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--v4-text-3);
    font-size: 13px;
    line-height: 16px;
  }

  /* Live chip: phase and elapsed time. Green is reserved for live. */
  .chip.live {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 20px;
    padding: 0 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--v4-ok) 12%, transparent);
    color: var(--v4-text-1);
    font-size: 13px;
  }

  .faces-caption {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    border-radius: 999px;
    background: var(--v4-ok);
    animation: dot-pulse 1.8s ease-in-out infinite;
  }

  /* Quiet goal-link affordance: appears on hover / keyboard focus only. */
  .link-nudge {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-raised);
    color: var(--v4-text-2);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 120ms ease,
      background 120ms ease,
      color 120ms ease;
  }

  .link-nudge svg {
    width: 14px;
    height: 14px;
  }

  .project-card:hover .link-nudge,
  .project-card:focus-within .link-nudge,
  .link-nudge.is-busy {
    opacity: 1;
  }

  .link-nudge:hover {
    border-color: var(--v4-hairline);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .link-nudge.is-busy {
    cursor: progress;
    opacity: 0.52;
  }

  @media (hover: none) {
    .link-nudge {
      opacity: 1;
    }
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
    .project-card,
    .progress-fill,
    .link-nudge {
      transition: none;
    }

    .status-dot.is-live,
    .live-dot {
      animation: none;
    }
  }
  /* Quiet last line: when the project last changed, or why it is Active. */
  .card-meta {
    display: flex;
    align-items: center;
    min-width: 0;
    margin: 0;
    margin-top: -2px;
    color: var(--v4-text-3);
    font-size: 13px;
    line-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-meta > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-activity {
    color: var(--v4-text-3);
  }

</style>
