<script lang="ts">
  /**
   * LibraryList — Foundry/"ops console" card grid of library items (workers +
   * skills), shared by the root Library page and the per-company panel.
   * Presentational only: applies the text filter and emits onselect(item).
   *
   * Visual language (V4 flat tint): borderless card-tint tiles with the shared
   * card radius, 13px sentence-case labels, and neutral status pills — scope
   * (core / personal / company), worker type + team, or skill pack + tool count.
   */
  import {
    filterLibraryItems,
    libraryItemKey,
    type LibraryItem,
  } from '../lib/library';

  interface Props {
    /** The unified worker+skill items to render. */
    items: LibraryItem[];
    /** Free-text filter (name / description / type / scope / pack). */
    query?: string;
    /** Fired when a card is activated by click or keyboard. */
    onselect?: (item: LibraryItem) => void;
  }

  let { items, query = '', onselect }: Props = $props();

  const RENDER_BATCH = 48;
  let visibleLimit = $state(RENDER_BATCH);
  const filtered = $derived(filterLibraryItems(items ?? [], query));
  const visible = $derived(filtered.slice(0, visibleLimit));
  const remaining = $derived(Math.max(0, filtered.length - visible.length));

  // Library can contain hundreds of skills and workers. Reset to one bounded
  // render window whenever the source collection or query changes; this keeps
  // search and tab switches responsive without hiding the total or discarding
  // any item.
  $effect(() => {
    items;
    query;
    visibleLimit = RENDER_BATCH;
  });

  /** Scope chip text + accent class. */
  function scope(item: LibraryItem): { label: string; cls: string } {
    if (item.kind === 'worker') {
      return item.worker.scope === 'company'
        ? { label: item.worker.company ?? 'company', cls: 'scope-company' }
        : { label: 'core', cls: 'scope-core' };
    }
    if (item.skill.scope === 'company') {
      return { label: item.skill.company ?? 'company', cls: 'scope-company' };
    }
    if (item.skill.scope === 'personal') return { label: 'personal', cls: 'scope-personal' };
    return { label: 'core', cls: 'scope-core' };
  }

  function activate(item: LibraryItem): void {
    onselect?.(item);
  }

  function handleKeydown(event: KeyboardEvent, item: LibraryItem): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect?.(item);
    }
  }
</script>

{#if visible.length === 0}
  <div class="empty-state">
    <p>No matches</p>
    <span>
      {#if (items?.length ?? 0) === 0}
        Nothing here yet.
      {:else}
        Try a different search.
      {/if}
    </span>
  </div>
{:else}
  <div class="library-grid" aria-label="Library items">
    {#each visible as item (libraryItemKey(item))}
      {@const sc = scope(item)}
      <button
        type="button"
        class="lib-card"
        class:is-worker={item.kind === 'worker'}
        class:is-skill={item.kind === 'skill'}
        aria-label={`${item.kind === 'worker' ? 'Worker' : 'Skill'} ${item.kind === 'worker' ? item.worker.name : item.skill.name}`}
        onclick={() => activate(item)}
        onkeydown={(event) => handleKeydown(event, item)}
      >
        <div class="card-head">
          <span class="kind-tag">
            <span class="kind-dot" aria-hidden="true"></span>
            {item.kind === 'worker' ? 'Worker' : 'Skill'}
          </span>
          <span class="pill scope {sc.cls}">{sc.label}</span>
        </div>

        {#if item.kind === 'worker'}
          <h3 class="card-name" title={item.worker.name}>{item.worker.name}</h3>
          <div class="pill-row">
            {#if item.worker.type}
              <span class="pill meta">{item.worker.type}</span>
            {/if}
            {#if item.worker.team}
              <span class="pill meta ghost">{item.worker.team}</span>
            {/if}
          </div>
          {#if item.worker.description}
            <p class="card-desc">{item.worker.description}</p>
          {/if}
        {:else}
          <h3 class="card-name" title={item.skill.name}>{item.skill.name}</h3>
          <div class="pill-row">
            {#if item.skill.pack}
              <span class="pill meta pack">{item.skill.pack}</span>
            {/if}
            {#if item.skill.allowedTools.length > 0}
              <span class="pill meta ghost">{item.skill.allowedTools.length} tools</span>
            {/if}
          </div>
          {#if item.skill.description}
            <p class="card-desc">{item.skill.description}</p>
          {/if}
        {/if}
      </button>
    {/each}
  </div>
  {#if remaining > 0}
    <div class="collection-footer">
      <span>{visible.length} of {filtered.length}</span>
      <button
        type="button"
        onclick={() => (visibleLimit = Math.min(filtered.length, visibleLimit + RENDER_BATCH))}
        aria-label={`Show ${Math.min(RENDER_BATCH, remaining)} more library items`}
      >
        Show {Math.min(RENDER_BATCH, remaining)} more
      </button>
    </div>
  {/if}
{/if}

<style>
  .library-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
    align-items: start;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
  }

  /* Flat tint cards — no hairline shell, no accent bar, no shadow. */
  .lib-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-width: 0;
    padding: 16px 20px 14px;
    overflow: hidden;
    border: none;
    border-radius: var(--v4-radius-card);
    background: var(--v4-card-tint);
    box-shadow: none;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  @media (hover: hover) and (pointer: fine) {
    .lib-card:hover {
      background: var(--v4-active-row);
    }
  }

  .lib-card:focus-visible {
    outline: 1px solid var(--v4-focus-ring);
    outline-offset: 2px;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .kind-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 13px);
    font-weight: 400;
    line-height: 1.25;
  }

  .kind-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-text-3);
  }
  .lib-card.is-worker .kind-dot {
    background: var(--v4-text-2);
  }
  .lib-card.is-skill .kind-dot {
    background: var(--v4-text-1);
  }

  .card-name {
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 13px);
    font-weight: 600;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    min-width: 0;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    overflow: hidden;
    height: 22px;
    padding: 0 8px;
    border: 1px solid color-mix(in srgb, var(--v4-text-1) 7%, transparent);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-inset);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill.scope {
    flex: 0 0 auto;
  }

  /* Meta pills (type / pack / counts) stay neutral so scope dominates. */
  .pill.meta.ghost {
    background: transparent;
  }

  .card-desc {
    margin: 2px 0 0;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 13px);
    line-height: 1.35;
    /* Clamp to two lines so tiles stay uniform. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .empty-state {
    padding: var(--v4-space-6);
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    text-align: center;
  }

  .empty-state p {
    margin: 0 0 var(--v4-space-1);
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .empty-state span {
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 13px);
  }

  .collection-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--v4-space-3);
    padding: var(--v4-space-4) 0 var(--v4-space-2);
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 13px);
    font-variant-numeric: tabular-nums;
  }

  .collection-footer button {
    padding: 0;
    border: 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .collection-footer button:hover {
    border-bottom-color: var(--v4-text-2);
  }

  .collection-footer button:focus-visible {
    outline: 1px solid var(--v4-focus-ring);
    outline-offset: 4px;
  }

  @media (prefers-reduced-motion: reduce) {
    .lib-card {
      transition: none;
    }
    .lib-card:hover {
      transform: none;
    }
  }
</style>
