<script lang="ts">
  /**
   * The Ideas board (US-009) — everything captured for the active company in a
   * masonry grid, scannable by shape, filtered by one search field and a chip
   * row. Loading / error / empty / populated are the four surfaces.
   */
  import { onMount } from 'svelte';
  import IdeaCard from './IdeaCard.svelte';
  import {
    buildSearchIndex,
    FILTER_CHIPS,
    searchCaptures,
    type IdeaChip,
  } from './ideaSearch';
  import { createIdeaCapturesStore, type IdeaCapture } from '../../stores/ideaCaptures';

  interface Props {
    /** Active company slug — the board is always company-scoped. */
    slug?: string;
    /** Injected in tests; defaults to a board-owned store instance. */
    store?: ReturnType<typeof createIdeaCapturesStore>;
  }

  const { slug = '', store = createIdeaCapturesStore() }: Props = $props();

  let query = $state('');
  let chip = $state<IdeaChip>('all');

  const index = $derived(buildSearchIndex(store.records));
  const visible = $derived(searchCaptures(index, query, chip));

  /** macOS shows the chord as a glyph; every other platform spells it. */
  const chordLabel =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent ?? '')
      ? '⌥⇧C'
      : 'Alt+Shift+C';

  onMount(() => {
    void store.load();
    void store.subscribeToUpdates();
    return () => store.unsubscribe();
  });

  // Thumbnails are fetched lazily per record; the store caches by id so a
  // re-render (search keystroke, chip change) never refetches.
  $effect(() => {
    for (const record of visible) {
      if (store.thumbnails[record.id] === undefined) void store.thumbnail(record);
    }
  });

  function accept(record: IdeaCapture): void {
    void store.setKind(record.id, record.kind, 'extracted');
  }

  function dismiss(record: IdeaCapture): void {
    void store.setKind(record.id, 'image', 'plain');
  }
</script>

<section class="ideas-board" data-testid="ideas-board" data-slug={slug}>
  <div class="board-top">
    <input
      class="ideas-search"
      data-testid="ideas-search"
      type="search"
      placeholder="search everything"
      aria-label="Search captures"
      bind:value={query}
    />
    <div class="ideas-chips">
      {#each FILTER_CHIPS as item (item.id)}
        <button
          type="button"
          class="ideas-chip"
          data-chip={item.id}
          class:active={chip === item.id}
          aria-pressed={chip === item.id}
          onclick={() => (chip = item.id)}
        >
          {item.label}
        </button>
      {/each}
    </div>
  </div>

  {#if store.state === 'loading'}
    <div class="ideas-loading" data-testid="ideas-loading">Loading captures…</div>
  {:else if store.state === 'error'}
    <div class="ideas-error" data-testid="ideas-error">
      <p class="ideas-error-text">Could not load your captures.</p>
      {#if store.error}<p class="ideas-error-detail">{store.error}</p>{/if}
      <button type="button" class="ideas-retry" onclick={() => store.load()}>Retry</button>
    </div>
  {:else if store.records.length === 0}
    <div class="ideas-empty" data-testid="ideas-empty">
      <p class="ideas-empty-chord">{chordLabel}</p>
      <p class="ideas-empty-text">
        Press {chordLabel} anywhere to capture whatever is on screen — it lands here.
      </p>
    </div>
  {:else}
    <div class="ideas-masonry" data-testid="ideas-masonry">
      {#each visible as record (record.id)}
        <IdeaCard
          {record}
          thumbnail={store.thumbnails[record.id] ?? null}
          onaccept={accept}
          ondismiss={dismiss}
        />
      {/each}
    </div>
    {#if visible.length === 0}
      <p class="ideas-noresults" data-testid="ideas-noresults">Nothing matches that yet.</p>
    {/if}
  {/if}
</section>

<style>
  .ideas-board {
    padding: 16px;
    background: var(--bg);
    font-family: var(--font-sans);
    color: var(--fg);
    container-type: inline-size;
  }

  .board-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }

  .ideas-search {
    flex: 1 1 220px;
    min-width: 160px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--fg);
    background: var(--surface-raise);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 9px;
  }

  .ideas-search::placeholder { color: var(--muted-3); }

  .ideas-search:focus-visible {
    outline: none;
    border-color: var(--border-strong);
  }

  .ideas-chips {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }

  .ideas-chip {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
    transition: opacity 150ms ease-out;
  }

  .ideas-chip:hover { opacity: 0.78; }

  .ideas-chip.active {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  /* AC1: 4 columns at >=1100px, 3 at >=800px, 2 below. Container queries so the
     board reacts to its own width inside the desktop shell, not the window. */
  .ideas-masonry {
    column-count: 2;
    column-gap: 10px;
  }

  @container (min-width: 800px) {
    .ideas-masonry { column-count: 3; }
  }

  @container (min-width: 1100px) {
    .ideas-masonry { column-count: 4; }
  }

  .ideas-loading,
  .ideas-noresults {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .ideas-error {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 16px;
    background: var(--surface-raise);
  }

  .ideas-error-text { margin: 0; font-size: 13px; }

  .ideas-error-detail {
    margin: 6px 0 10px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--muted);
  }

  .ideas-retry {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg);
    background: var(--surface-panel);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 4px 9px;
    cursor: pointer;
  }

  .ideas-empty {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 28px 16px;
    text-align: center;
    background: var(--surface-raise);
  }

  .ideas-empty-chord {
    margin: 0 0 8px;
    font-family: var(--font-mono);
    font-size: 15px;
    letter-spacing: 0.08em;
    color: var(--fg);
  }

  .ideas-empty-text {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
  }

  @media (prefers-reduced-motion: reduce) {
    .ideas-chip { transition: none; }
  }
</style>
