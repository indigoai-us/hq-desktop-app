<script lang="ts">
  /**
   * The Ideas board (US-009) — everything captured for the active company in a
   * masonry grid, scannable by shape, filtered by one search field and a chip
   * row. Loading / error / empty / populated are the four surfaces.
   */
  import { onMount } from 'svelte';
  import IdeaCard from './IdeaCard.svelte';
  import IdeaDetail from './IdeaDetail.svelte';
  import {
    buildSearchIndex,
    cardKind,
    FILTER_CHIPS,
    searchCaptures,
    type IdeaChip,
  } from './ideaSearch';
  import { createIdeaCapturesStore, type IdeaCapture } from '../../stores/ideaCaptures';
  import {
    loadIdeasSettings,
    localOnlyBadge,
    type IdeasSettingsState,
    type LocalOnlyBadge,
  } from '../../lib/ideas/ideas-settings';

  interface Props {
    /** Active company slug — the board is always company-scoped. */
    slug?: string;
    /** Injected in tests; defaults to a board-owned store instance. */
    store?: ReturnType<typeof createIdeaCapturesStore>;
  }

  const { slug = '', store = createIdeaCapturesStore() }: Props = $props();

  let query = $state('');
  let chip = $state<IdeaChip>('all');
  let openId = $state<string | null>(null);
  let companies = $state<string[]>([]);
  /**
   * US-012 AC3: the persistent "local only" badge. `null` whenever captures are
   * syncing, or whenever the settings read failed — a board that cannot confirm
   * the posture must not assert one, and silently omitting the badge is the
   * safe direction (it never claims privacy the code has not delivered).
   */
  let ideasSettings = $state<IdeasSettingsState | null>(null);

  const localOnly = $derived<LocalOnlyBadge | null>(localOnlyBadge(ideasSettings));

  const index = $derived(buildSearchIndex(store.records));
  const visible = $derived(searchCaptures(index, query, chip));

  /** macOS shows the chord as a glyph; every other platform spells it. */
  const chordLabel =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent ?? '')
      ? '⌥⇧C'
      : 'Alt+Shift+C';

  const openRecord = $derived(openId ? visible.find((r) => r.id === openId) ?? store.records.find((r) => r.id === openId) : undefined);
  const openIndex = $derived(openRecord ? visible.findIndex((r) => r.id === openRecord.id) : -1);

  onMount(() => {
    void store.load();
    void store.subscribeToUpdates();
    void store.listCompanies().then((list) => {
      companies = list;
    });
    // `await` inside a try, not `.then`: a host that does not implement
    // `ideas_get_settings` can return undefined rather than a promise, and a
    // board that throws on a *badge* lookup would take the whole grid down.
    void (async () => {
      try {
        ideasSettings = (await loadIdeasSettings()) ?? null;
      } catch {
        ideasSettings = null;
      }
    })();
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
    void store.setKind(record.id, cardKind(record), 'extracted');
  }

  function dismiss(record: IdeaCapture): void {
    void store.setKind(record.id, 'image', 'plain');
  }

  function openDetail(record: IdeaCapture): void {
    openId = record.id;
  }

  function closeDetail(): void {
    openId = null;
  }

  function stepDetail(delta: number): void {
    if (visible.length === 0) return;
    const next = openIndex < 0 ? 0 : (openIndex + delta + visible.length) % visible.length;
    openId = visible[next]?.id ?? null;
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
    {#if localOnly}
      <span
        class="ideas-local-only"
        data-testid="ideas-board-local-only"
        title={localOnly.title}
      >
        {localOnly.label}
      </span>
    {/if}
  </div>

  {#if store.state === 'loading' || store.state === 'idle'}
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
    <div class="ideas-grid-container">
      <div class="ideas-masonry" data-testid="ideas-masonry">
        {#each visible as record (record.id)}
          <IdeaCard
            {record}
            thumbnail={store.thumbnails[record.id] ?? null}
            onaccept={accept}
            ondismiss={dismiss}
            onopen={openDetail}
          />
        {/each}
      </div>
    </div>
    {#if visible.length === 0}
      <p class="ideas-noresults" data-testid="ideas-noresults">Nothing matches that yet.</p>
    {/if}
  {/if}
  {#if openRecord}
    <IdeaDetail
      record={openRecord}
      imageSrc={store.thumbnails[openRecord.id] ?? null}
      {companies}
      {store}
      onclose={closeDetail}
      onprev={() => stepDetail(-1)}
      onnext={() => stepDetail(1)}
    />
  {/if}
</section>

<style>
  .ideas-board {
    padding: 16px;
    background: var(--bg);
    font-family: var(--font-sans);
    color: var(--fg);
  }

  /* Unpadded so the container queries below measure the grid's own width
     rather than the board's padded box. */
  .ideas-grid-container {
    container-type: inline-size;
  }

  .board-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }

  .ideas-local-only {
    flex: 0 0 auto;
    padding: 2px 7px;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: help;
    color: light-dark(#8a5200, #f0b429);
    border: 1px solid light-dark(rgba(138, 82, 0, 0.35), rgba(240, 180, 41, 0.35));
    background: light-dark(rgba(240, 180, 41, 0.12), rgba(240, 180, 41, 0.14));
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
    box-shadow: 0 0 0 2px var(--v4-focus-ring, var(--accent));
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

  .ideas-chip:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--v4-focus-ring, var(--accent));
  }

  .ideas-chip:active { opacity: 0.62; }

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
    transition: opacity 150ms ease-out;
  }

  .ideas-retry:hover { opacity: 0.78; }
  .ideas-retry:active { opacity: 0.62; }

  .ideas-retry:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--v4-focus-ring, var(--accent));
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
    .ideas-retry { transition: none; }
  }
</style>
