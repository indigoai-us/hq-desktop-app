<script lang="ts">
  /**
   * BoardTab — the project channel's Board view, ported faithfully from the
   * hq-sync desktop `desktop-alt/chat/BoardTab.svelte` MARKUP + CSS.
   *
   * ZERO NETWORK / platform-pure: the board is INJECTED as fixture data
   * (`columns` + `stories`). There is no Tauri invoke, no board polling, no
   * fetch — the host owns the data. Selecting a card opens the task side-panel
   * from the injected `stories` lookup. Empty stage columns stay visible;
   * the column filter defaults to To do / Doing / Done.
   */
  import {
    BOARD_STAGE_ORDER,
    BOARD_STAGE_TITLES,
    DEFAULT_VISIBLE_BOARD_STAGES,
    resolveBoardColumns,
    toggleBoardStage,
    type BoardColumnModel,
    type BoardStageId,
    type BoardStoryPanelModel,
  } from "./channelTabModels";

  interface Props {
    columns: BoardColumnModel[];
    stories: Record<string, BoardStoryPanelModel>;
    /** Bubbled "Open in channel" — the host flips back to the Chat tab. */
    onOpenInChannel?: () => void;
  }

  let { columns, stories, onOpenInChannel }: Props = $props();

  let selectedStoryId = $state<string | null>(null);
  let visibleStages = $state<BoardStageId[]>([...DEFAULT_VISIBLE_BOARD_STAGES]);

  const visibleColumns = $derived(resolveBoardColumns(columns, visibleStages));

  const panelModel = $derived<BoardStoryPanelModel | null>(
    selectedStoryId ? (stories[selectedStoryId] ?? null) : null,
  );
  const activity = $derived(panelModel?.activity ?? []);

  function isStageOn(id: BoardStageId): boolean {
    return visibleStages.includes(id);
  }

  function toggleStage(id: BoardStageId): void {
    const next = toggleBoardStage(visibleStages, id);
    visibleStages = next;
    const nextColumns = resolveBoardColumns(columns, next);
    if (
      selectedStoryId &&
      !nextColumns.some((column) =>
        column.cards.some((card) => card.storyId === selectedStoryId),
      )
    ) {
      selectedStoryId = null;
    }
  }

  function openCard(storyId: string): void {
    selectedStoryId = storyId;
  }

  function closePanel(): void {
    selectedStoryId = null;
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && selectedStoryId) {
      e.preventDefault();
      closePanel();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="board-tab chat-shell"
  data-testid="project-tab-board"
  role="region"
  aria-label="Project board"
>
  <div class="board-toolbar">
    <span class="board-filter-label" id="board-column-filter-label"
      >Columns</span
    >
    <div
      class="board-filter-pills"
      data-testid="board-column-filter"
      role="group"
      aria-labelledby="board-column-filter-label"
    >
      {#each BOARD_STAGE_ORDER as stage (stage)}
        <button
          type="button"
          class="board-filter-pill"
          class:on={isStageOn(stage)}
          aria-pressed={isStageOn(stage)}
          data-testid={`board-filter-${stage}`}
          onclick={() => toggleStage(stage)}
        >
          {BOARD_STAGE_TITLES[stage]}
        </button>
      {/each}
    </div>
  </div>

  {#if visibleColumns.length === 0}
    <div class="board-empty" role="status">Select at least one column.</div>
  {:else}
    <div class="board-layout" class:has-panel={panelModel != null}>
      <div class="board-scroll">
        <div
          class="board-grid"
          data-testid="board-columns"
          style:--board-col-count={visibleColumns.length}
        >
          {#each visibleColumns as column (column.id)}
            <div
              class="board-column"
              data-testid={`board-column-${column.id}`}
              aria-labelledby={`board-col-${column.id}`}
            >
              <div class="column-header">
                <span class="column-title" id={`board-col-${column.id}`}
                  >{column.title}</span
                >
                <span class="column-count">{column.cards.length}</span>
              </div>
              <div class="column-body">
                {#if column.cards.length === 0}
                  <div
                    class="column-empty"
                    data-testid={`board-column-empty-${column.id}`}
                  >
                    <span>No tasks</span>
                  </div>
                {:else}
                  {#each column.cards as card (card.storyId)}
                    <button
                      type="button"
                      class="board-card"
                      class:selected={selectedStoryId === card.storyId}
                      data-testid="board-card"
                      data-story-id={card.storyId}
                      onclick={() => openCard(card.storyId)}
                    >
                      <span class="card-label">{card.label}</span>
                      <span
                        class="card-status"
                        class:ok={/DONE|AGENT RUNNING|CI GREEN|GREEN/.test(
                          card.statusLine,
                        )}
                        class:warn={/WAITING|BLOCKED|WARN/.test(
                          card.statusLine,
                        )}>{card.statusLine}</span
                      >
                    </button>
                  {/each}
                {/if}
              </div>
            </div>
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
          aria-label={`Task: ${panelModel.title}`}
          tabindex="-1"
        >
          <header class="panel-header">
            <div class="panel-header-text">
              <h2 class="panel-title">{panelModel.title}</h2>
              <span class="panel-status-badge">{panelModel.statusBadge}</span>
            </div>
            <button
              type="button"
              class="panel-close"
              data-testid="board-story-panel-close"
              aria-label="Close task details"
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
                {#if panelModel.fields.branch}
                  <div class="field-row">
                    <dt>BRANCH</dt>
                    <dd>{panelModel.fields.branch}</dd>
                  </div>
                {/if}
              </dl>
            </section>

            {#if panelModel.acceptanceCriteria.length > 0}
              <section class="panel-section" aria-label="Checklist">
                <div class="panel-section-row">
                  <h3 class="panel-section-label">CHECKLIST</h3>
                  <span class="ac-count" data-testid="board-ac-count"
                    >{panelModel.acCountLabel}</span
                  >
                </div>
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
              </section>
            {/if}

            <section class="panel-section" aria-label="Activity">
              <h3 class="panel-section-label">ACTIVITY</h3>
              {#if activity.length === 0}
                <p class="panel-muted">No activity for this task yet</p>
              {:else}
                <ul class="activity-list" data-testid="board-story-activity">
                  {#each activity as item (item.id)}
                    <li class="activity-item">
                      <time class="activity-at" datetime={item.at}
                        >{item.at}</time
                      >
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
              onclick={() => onOpenInChannel?.()}
            >
              Open in channel
            </button>
            <button
              type="button"
              class="panel-btn panel-btn-secondary"
              data-testid="board-view-changes"
            >
              View changes
            </button>
          </footer>
        </div>
      {/if}
    </div>
  {/if}
</div>

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

  .board-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    padding: 12px 20px 0;
    min-width: 0;
  }

  .board-filter-label {
    color: var(--t3);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    flex: 0 0 auto;
  }

  .board-filter-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .board-filter-pill {
    appearance: none;
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--t3);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s,
      color 0.12s;
  }

  .board-filter-pill:hover {
    color: var(--t1);
    border-color: var(--line2);
    background: var(--hover);
  }

  .board-filter-pill.on {
    color: var(--t1);
    border-color: var(--line2);
    background: var(--btn-bg);
  }

  .board-filter-pill:focus-visible {
    outline: 2px solid var(--v4-control-border, var(--border));
    outline-offset: 2px;
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
    grid-template-columns: repeat(
      var(--board-col-count, 3),
      minmax(200px, 1fr)
    );
    gap: 14px;
    min-width: calc(var(--board-col-count, 3) * 200px);
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
  .column-count::before {
    content: "·";
    margin-right: 6px;
    color: var(--t3);
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
    transition:
      background 0.12s,
      border-color 0.12s;
  }

  .board-card:hover,
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
  .card-status.ok {
    color: var(--ok-ink, #4ade80);
  }
  .card-status.warn {
    color: var(--warn-ink, #fbbf24);
  }

  /* Story detail side panel */
  .story-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 340px;
    width: 340px;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--side-bg, var(--elevated));
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
    transition:
      color 0.12s,
      background 0.12s;
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
