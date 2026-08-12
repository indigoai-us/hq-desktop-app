<script lang="ts">
  /**
   * Project-channel Board tab (US-006).
   *
   * Three columns (IN PROGRESS / REVIEW / DONE) from PRD stories + agent
   * sessions, with a story detail side panel. Polls local project/prd/sessions
   * on {@link BOARD_POLL_MS} until realtime (US-015).
   */
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import type { Channel } from '../../lib/channels';
  import { loadLocalProjects, loadLocalProjectPrd } from '../lib/local-projects';
  import type { Project } from '../lib/projects-model';
  import type { MissionControlSnapshot } from '../lib/sessions';
  import {
    BOARD_FIXTURE_PRD,
    BOARD_FIXTURE_PROJECT,
    BOARD_FIXTURE_SESSIONS,
    BOARD_FIXTURE_SIGNALS,
    BOARD_FIXTURE_STORIES,
    BOARD_POLL_MS,
    buildStoryActivity,
    buildStoryPanelModel,
    deriveBoardColumns,
    type BoardActivityMessageInput,
    type BoardCard,
    type BoardColumn,
    type BoardProjectInput,
    type BoardSessionInput,
    type BoardStoryInput,
    type BoardStorySignal,
    type StoryActivityItem,
    type StoryPanelModel,
  } from './board-model';
  import './chat-tokens.css';

  interface BoardMessage {
    eventId: string;
    createdAt: string;
    body?: string | null;
    messageKind?: string | null;
    systemEvent?: Record<string, unknown> | null;
    details?: string | null;
  }

  interface Props {
    channel: Channel;
    /** Channel messages — system events feed the story activity list. */
    messages?: readonly BoardMessage[];
    /** Switch the project channel back to the Chat tab. */
    onOpenInChannel?: () => void;
    /** Optional “View changes” action (repo path / no-op for now). */
    onViewChanges?: (storyId: string) => void;
  }

  let {
    channel,
    messages = [],
    onOpenInChannel,
    onViewChanges,
  }: Props = $props();

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let project = $state<BoardProjectInput | null>(null);
  let stories = $state<BoardStoryInput[]>([]);
  let sessions = $state<BoardSessionInput[]>([]);
  let storySignals = $state<Record<string, BoardStorySignal> | null>(null);
  let branchName = $state<string | null>(null);
  let prdName = $state<string | null>(null);
  let selectedStoryId = $state<string | null>(null);
  let usingFixtures = $state(false);

  const columns = $derived(
    deriveBoardColumns(stories, sessions, storySignals, project),
  );

  const selectedStory = $derived(
    selectedStoryId
      ? (stories.find((s) => s.id === selectedStoryId) ?? null)
      : null,
  );

  const panelModel = $derived.by((): StoryPanelModel | null => {
    if (!selectedStory) return null;
    const key = selectedStory.id;
    const signal =
      storySignals?.[key] ??
      storySignals?.[key.toUpperCase()] ??
      null;
    return buildStoryPanelModel(
      selectedStory,
      project,
      {
        name: prdName ?? project?.title ?? project?.name ?? undefined,
        branchName,
      },
      sessions,
      signal,
    );
  });

  const activity = $derived.by((): StoryActivityItem[] => {
    if (!selectedStoryId) return [];
    const inputs: BoardActivityMessageInput[] = (messages ?? []).map((m) => ({
      eventId: m.eventId,
      createdAt: m.createdAt,
      body: m.body,
      messageKind: m.messageKind,
      systemEvent: m.systemEvent,
      details: m.details,
    }));
    return buildStoryActivity(inputs, selectedStoryId);
  });

  async function refreshBoard(): Promise<void> {
    const projectId = channel.projectId?.trim() || channel.name?.trim() || '';
    const channelTitle = (channel.name ?? '').replace(/^#+/, '').trim();
    try {
      let projects: Project[] = [];
      try {
        projects = await loadLocalProjects();
      } catch (err) {
        console.error('board-tab: loadLocalProjects failed', err);
      }

      const matched =
        projects.find(
          (p) =>
            p.id === projectId ||
            p.id === channel.projectId ||
            (p.title || p.name || '').toLowerCase() === channelTitle.toLowerCase(),
        ) ?? null;

      const nextProject: BoardProjectInput | null = matched
        ? {
            id: matched.id,
            title: matched.title,
            name: matched.name,
            company: matched.company,
            prdPath: matched.prdPath,
          }
        : projectId
          ? {
              id: projectId,
              title: channelTitle || projectId,
              name: channelTitle || projectId,
              company: channel.companyName ?? '',
              prdPath: '',
            }
          : null;

      let nextStories: BoardStoryInput[] = [];
      let nextBranch: string | null = null;
      let nextPrdName: string | null = null;

      if (matched?.prdPath) {
        try {
          const prd = await loadLocalProjectPrd(matched.prdPath);
          nextPrdName = prd.name ?? null;
          nextBranch = prd.branchName ?? null;
          nextStories = (prd.userStories ?? []).map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            acceptanceCriteria: s.acceptanceCriteria ?? [],
            passes: s.passes ?? false,
          }));
        } catch (err) {
          console.error('board-tab: loadLocalProjectPrd failed', err);
        }
      }

      let nextSessions: BoardSessionInput[] = [];
      try {
        const snap = await invoke<MissionControlSnapshot>('list_agent_sessions');
        nextSessions = (snap?.sessions ?? []).map((s) => ({
          project: s.project,
          company: s.company,
          cwd: s.cwd,
          status: s.status,
          tool: s.tool,
          model: s.model,
          source: s.source,
          startedAt: s.startedAt,
        }));
      } catch (err) {
        console.error('board-tab: list_agent_sessions failed', err);
      }

      // When the project has no PRD stories, fall back to D-12 visual fixtures.
      if (nextStories.length === 0) {
        project = nextProject ?? BOARD_FIXTURE_PROJECT;
        stories = BOARD_FIXTURE_STORIES;
        sessions = BOARD_FIXTURE_SESSIONS;
        storySignals = BOARD_FIXTURE_SIGNALS;
        branchName = nextBranch ?? BOARD_FIXTURE_PRD.branchName ?? null;
        prdName = nextPrdName ?? BOARD_FIXTURE_PRD.name ?? null;
        usingFixtures = true;
      } else {
        project = nextProject;
        stories = nextStories;
        sessions = nextSessions;
        storySignals = null;
        branchName = nextBranch;
        prdName = nextPrdName;
        usingFixtures = false;
      }
      loadError = null;
    } catch (err) {
      console.error('board-tab: refresh failed', err);
      // Still paint fixtures so the board is reviewable offline.
      project = BOARD_FIXTURE_PROJECT;
      stories = BOARD_FIXTURE_STORIES;
      sessions = BOARD_FIXTURE_SESSIONS;
      storySignals = BOARD_FIXTURE_SIGNALS;
      branchName = BOARD_FIXTURE_PRD.branchName ?? null;
      prdName = BOARD_FIXTURE_PRD.name ?? null;
      usingFixtures = true;
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refreshBoard();
    const timer = setInterval(() => {
      void refreshBoard();
    }, BOARD_POLL_MS);
    return () => clearInterval(timer);
  });

  function openCard(card: BoardCard): void {
    selectedStoryId = card.storyId;
  }

  function closePanel(): void {
    selectedStoryId = null;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && selectedStoryId) {
      event.stopPropagation();
      closePanel();
    }
  }

  function handleOpenInChannel(): void {
    onOpenInChannel?.();
  }

  function handleViewChanges(): void {
    if (selectedStoryId) onViewChanges?.(selectedStoryId);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="board-tab chat-shell"
  data-testid="project-tab-board"
  role="region"
  aria-label="Project board"
>
  {#if loading && stories.length === 0}
    <div class="board-empty" role="status">Loading board…</div>
  {:else if loadError && stories.length === 0}
    <div class="board-empty" role="alert">{loadError}</div>
  {:else if stories.length === 0}
    <div class="board-empty" role="status">No stories in this project yet.</div>
  {:else}
    <div class="board-layout" class:has-panel={panelModel != null}>
      <div class="board-scroll">
        <div class="board-grid" data-testid="board-columns">
          {#each columns as column (column.id)}
            {@render boardColumn(column)}
          {/each}
        </div>
      </div>

      {#if panelModel}
        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
        <div
          class="story-panel"
          data-testid="board-story-panel"
          role="dialog"
          aria-modal="false"
          aria-label={`Story ${panelModel.id}: ${panelModel.title}`}
          tabindex="-1"
        >
          <header class="panel-header">
            <div class="panel-header-text">
              <span class="panel-story-id">{panelModel.id}</span>
              <h2 class="panel-title">{panelModel.title}</h2>
              <span class="panel-status-badge">{panelModel.statusBadge}</span>
            </div>
            <button
              type="button"
              class="panel-close"
              data-testid="board-story-panel-close"
              aria-label="Close story details"
              onclick={closePanel}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <div class="panel-body">
            {#if panelModel.description}
              <section class="panel-section">
                <h3 class="panel-section-label">Description</h3>
                <p class="panel-description">{panelModel.description}</p>
              </section>
            {/if}

            <section class="panel-section" aria-label="Fields">
              <dl class="panel-fields">
                <div class="field-row">
                  <dt>STATUS</dt>
                  <dd>{panelModel.fields.status}</dd>
                </div>
                <div class="field-row">
                  <dt>ASSIGNEE</dt>
                  <dd>{panelModel.fields.assignee}</dd>
                </div>
                <div class="field-row">
                  <dt>PROJECT</dt>
                  <dd>{panelModel.fields.project}</dd>
                </div>
                <div class="field-row">
                  <dt>BRANCH</dt>
                  <dd>{panelModel.fields.branch}</dd>
                </div>
              </dl>
            </section>

            <section class="panel-section" aria-label="Acceptance criteria">
              <div class="panel-section-row">
                <h3 class="panel-section-label">ACCEPTANCE CRITERIA</h3>
                <span class="ac-count" data-testid="board-ac-count"
                  >{panelModel.acCountLabel}</span
                >
              </div>
              {#if panelModel.acceptanceCriteria.length === 0}
                <p class="panel-muted">No acceptance criteria</p>
              {:else}
                <ul class="ac-list">
                  {#each panelModel.acceptanceCriteria as item, i (i)}
                    <li class="ac-item" class:done={item.done}>
                      <input
                        type="checkbox"
                        class="ac-check"
                        checked={item.done}
                        disabled
                        tabindex="-1"
                        aria-label={item.text}
                      />
                      <span class="ac-text">{item.text}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>

            <section class="panel-section" aria-label="Activity">
              <h3 class="panel-section-label">ACTIVITY</h3>
              {#if activity.length === 0}
                <p class="panel-muted">No activity for this story yet</p>
              {:else}
                <ul class="activity-list" data-testid="board-story-activity">
                  {#each activity as item (item.id)}
                    <li class="activity-item">
                      <time class="activity-at" datetime={item.at}>{item.at}</time>
                      <span class="activity-text">{item.text}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          </div>

          <footer class="panel-footer">
            <button
              type="button"
              class="panel-btn"
              data-testid="board-open-in-channel"
              onclick={handleOpenInChannel}
            >
              Open in channel
            </button>
            <button
              type="button"
              class="panel-btn panel-btn-secondary"
              data-testid="board-view-changes"
              onclick={handleViewChanges}
            >
              View changes
            </button>
          </footer>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#snippet boardColumn(column: BoardColumn)}
  <div
    class="board-column"
    data-testid={`board-column-${column.id}`}
    aria-labelledby={`board-col-${column.id}`}
  >
    <div class="column-header">
      <span class="column-title" id={`board-col-${column.id}`}>{column.title}</span>
      <span class="column-count">{column.cards.length}</span>
    </div>
    <div class="column-body">
      {#if column.cards.length === 0}
        <div class="column-empty">
          <span>No stories</span>
        </div>
      {:else}
        {#each column.cards as card (card.storyId)}
          <button
            type="button"
            class="board-card"
            class:selected={selectedStoryId === card.storyId}
            data-testid="board-card"
            data-story-id={card.storyId}
            onclick={() => openCard(card)}
          >
            <span class="card-label">{card.label}</span>
            <span class="card-status">{card.statusLine}</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/snippet}

<style>
  .board-tab {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    height: 100%;
    background: transparent;
    font: 400 13px/1.45 var(--font-ui);
    color: var(--t1);
  }

  .board-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 20px;
    color: var(--t3);
    font-size: 13px;
  }

  .board-layout {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .board-scroll {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 20px;
  }

  .board-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(200px, 1fr));
    gap: 14px;
    min-width: 540px;
    height: 100%;
  }

  .board-column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: 0;
    background: transparent;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .column-title {
    color: var(--t2);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .column-count {
    display: inline-flex;
    align-items: center;
    color: var(--t3);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    line-height: 16px;
  }

  .column-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    margin-top: 10px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .column-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .column-empty span {
    color: var(--t3);
    font-size: 13px;
  }

  .board-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .board-card:hover {
    background: var(--btn-bg);
    border-color: var(--line2);
  }

  .board-card.selected {
    background: var(--btn-bg);
    border-color: var(--line2);
  }

  .board-card:focus-visible {
    outline: 2px solid var(--v4-control-border, var(--border));
    outline-offset: 2px;
  }

  .card-label {
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
  }

  .card-status {
    color: var(--t2);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.3;
  }

  /* Story detail side panel */
  .story-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 340px;
    width: 340px;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--side-bg);
    border-radius: 0;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 16px 20px 0;
  }

  .panel-header-text {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .panel-story-id {
    color: var(--t3);
    font-size: 11px;
    font-weight: 400;
  }

  .panel-title {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
  }

  .panel-status-badge {
    align-self: flex-start;
    margin-top: 2px;
    padding: 2px 8px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t2);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .panel-close {
    appearance: none;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }

  .panel-close:hover {
    color: var(--t1);
    background: var(--hover);
  }

  .panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 20px 20px;
  }

  .panel-section {
    margin-bottom: 18px;
  }

  .panel-section-label {
    margin: 0 0 6px;
    color: var(--t2);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .panel-section-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .panel-section-row .panel-section-label {
    margin-bottom: 0;
  }

  .ac-count {
    color: var(--t3);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .panel-description {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
    line-height: 20px;
    white-space: pre-wrap;
  }

  .panel-fields {
    margin: 0;
  }

  .field-row {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    gap: 0.5rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }

  .field-row dt {
    color: var(--t3);
    font-size: 9px;
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .field-row dd {
    margin: 0;
    color: var(--t1);
    font-size: 12px;
    word-break: break-word;
  }

  .ac-list,
  .activity-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .ac-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.35rem 0;
  }

  .ac-check {
    margin-top: 0.15rem;
    flex: 0 0 auto;
    accent-color: var(--ok-ink);
  }

  .ac-text {
    color: var(--t2);
    font-size: 13px;
    line-height: 20px;
  }

  .ac-item.done .ac-text {
    text-decoration: line-through;
    color: var(--t3);
  }

  .panel-muted {
    margin: 0;
    color: var(--t3);
    font-size: 13px;
  }

  .activity-item {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 3px 0;
    border-bottom: none;
  }

  .activity-at {
    color: var(--t3);
    font-size: 10px;
  }

  .activity-text {
    color: var(--t3);
    font-size: 11px;
    line-height: 1.35;
  }

  .panel-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 20px 20px;
  }

  .panel-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 3px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t1);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .panel-btn:hover {
    border-color: var(--line2);
  }

  .panel-btn:active {
    border-color: var(--border-active);
  }

  .panel-btn-secondary {
    background: transparent;
    color: var(--t2);
    border-color: var(--line2);
  }

  .panel-btn-secondary:hover {
    background: var(--hover);
    color: var(--t1);
    border-color: var(--line2);
  }

  .panel-btn:focus-visible {
    outline: 2px solid var(--v4-control-border, var(--border));
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .board-card {
      transition: none;
    }
  }
</style>
