<script lang="ts">
  /**
   * Ideas tab — everything captured for the active company in a masonry grid,
   * scannable by shape, filtered by one search field and a chip row. Loading /
   * error / empty / no-match are the four surfaces.
   *
   * Like AtlasTab, this tab does NOT use the server-driven `getCompanyTab`
   * sections model: captures are local files on this machine, read through the
   * adapter's `ideas` group.
   */
  import type { IdeaCapture, PlatformAdapter } from "@hq/platform";
  import IdeaCard from "./IdeaCard.svelte";
  import IdeaDetail from "./IdeaDetail.svelte";
  import {
    buildSearchIndex,
    cardKind,
    FILTER_CHIPS,
    searchCaptures,
    type IdeaChip,
  } from "./ideaSearch.js";
  import {
    createIdeaCapturesStore,
    type IdeaCapturesStore,
  } from "./idea-captures.svelte.js";
  import { localOnlyBadge } from "./ideas-badges.js";

  interface Props {
    adapter: PlatformAdapter;
    /** Active company slug — the board is always company-scoped. */
    slug?: string;
    /** Injected in tests; defaults to a board-owned store instance. */
    store?: IdeaCapturesStore;
  }

  let {
    adapter,
    slug = "",
    store = createIdeaCapturesStore(adapter),
  }: Props = $props();

  let query = $state("");
  let chip = $state<IdeaChip>("all");
  let openId = $state<string | null>(null);
  let booted = $state(false);

  const localOnly = $derived(localOnlyBadge(store.settings));
  const index = $derived(buildSearchIndex(store.records));
  const visible = $derived(searchCaptures(index, query, chip));

  /** macOS shows the chord as a glyph; every other platform spells it. */
  const chordLabel =
    typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent ?? "")
      ? "⌥⇧C"
      : "Alt+Shift+C";

  const openRecord = $derived(
    openId
      ? (visible.find((r) => r.id === openId) ??
        store.records.find((r) => r.id === openId))
      : undefined,
  );
  const openIndex = $derived(
    openRecord ? visible.findIndex((r) => r.id === openRecord.id) : -1,
  );

  $effect(() => {
    if (booted) return;
    booted = true;
    void store.load();
    // Side data never blocks or blanks the grid: an unknown sync posture just
    // means no badge, and an unreadable company list just means no move target.
    void store.loadSideData();
  });

  // Thumbnails are fetched lazily per record; the store caches by id so a
  // re-render (search keystroke, chip change) never refetches.
  $effect(() => {
    for (const record of visible) {
      if (store.thumbnails[record.id] === undefined) void store.thumbnail(record);
    }
  });

  function accept(record: IdeaCapture): void {
    void store.setKind(record.id, cardKind(record), "extracted");
  }

  function dismiss(record: IdeaCapture): void {
    void store.setKind(record.id, "image", "plain");
  }

  function stepDetail(delta: number): void {
    if (visible.length === 0) return;
    const next =
      openIndex < 0 ? 0 : (openIndex + delta + visible.length) % visible.length;
    openId = visible[next]?.id ?? null;
  }
</script>

<section
  class="ideas-tab"
  data-testid="company-tab-ideas"
  data-slug={slug}
>
  <div class="ideas-board" data-testid="ideas-board">
    <div class="ideas-top">
      <input
        class="ideas-search"
        data-testid="ideas-search"
        type="search"
        placeholder="Search everything"
        aria-label="Search captures"
        bind:value={query}
      />
      <div class="ideas-chips">
        {#each FILTER_CHIPS as item (item.id)}
          <button
            type="button"
            class="ideas-chip"
            class:active={chip === item.id}
            data-chip={item.id}
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

    {#if store.state === "loading" || store.state === "idle"}
      <div class="ideas-note" data-testid="ideas-loading">Loading captures…</div>
    {:else if store.state === "error"}
      <div class="ideas-error" data-testid="ideas-error">
        <p class="ideas-error-text">Could not load your captures.</p>
        {#if store.error}<p class="ideas-note">{store.error}</p>{/if}
        <button type="button" class="ideas-retry" onclick={() => store.load()}>
          Retry
        </button>
      </div>
    {:else if store.records.length === 0}
      <div class="ideas-empty" data-testid="ideas-empty">
        <p class="ideas-empty-chord">{chordLabel}</p>
        <p class="ideas-empty-text">
          Press {chordLabel} anywhere to capture whatever is on screen — it lands
          here.
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
              onopen={(r) => (openId = r.id)}
            />
          {/each}
        </div>
      </div>
      {#if visible.length === 0}
        <p class="ideas-note" data-testid="ideas-noresults">
          Nothing matches that yet.
        </p>
      {/if}
    {/if}
  </div>

  {#if openRecord}
    <IdeaDetail
      record={openRecord}
      imageSrc={store.thumbnails[openRecord.id] ?? null}
      companies={store.companies}
      {store}
      onclose={() => (openId = null)}
      onprev={() => stepDetail(-1)}
      onnext={() => stepDetail(1)}
    />
  {/if}
</section>

<style>
  .ideas-tab {
    position: relative;
    display: flex;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .ideas-board {
    flex: 1 1 auto;
    min-width: 0;
    padding: 16px 20px 24px;
    overflow: auto;
    color: var(--t1);
  }

  /* Unpadded so the container queries below measure the grid's own width
     rather than the board's padded box. */
  .ideas-grid-container {
    container-type: inline-size;
  }

  .ideas-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }

  .ideas-search {
    flex: 1 1 220px;
    min-width: 160px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
  }

  .ideas-search::placeholder {
    color: var(--t3);
  }

  .ideas-search:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: 2px;
  }

  .ideas-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .ideas-chip {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--t1) 10%, transparent);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .ideas-chip:hover {
    color: var(--t1);
  }

  .ideas-chip:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: 2px;
  }

  /* Selection is a background highlight — never a left accent bar. */
  .ideas-chip.active {
    color: var(--t1);
    background: var(--sel, color-mix(in srgb, var(--t1) 10%, transparent));
    border-color: color-mix(in srgb, var(--t1) 18%, transparent);
  }

  .ideas-local-only {
    flex: 0 0 auto;
    padding: 3px 8px;
    border-radius: 6px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: help;
    color: var(--warn, #d29922);
    border: 1px solid color-mix(in srgb, var(--warn, #d29922) 35%, transparent);
  }

  /* AC1: 4 columns at >=1100px, 3 at >=800px, 2 below. Container queries so the
     board reacts to its own width inside the desktop shell, not the window. */
  .ideas-masonry {
    column-count: 2;
    column-gap: 10px;
  }

  @container (min-width: 800px) {
    .ideas-masonry {
      column-count: 3;
    }
  }

  @container (min-width: 1100px) {
    .ideas-masonry {
      column-count: 4;
    }
  }

  .ideas-note {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .ideas-error,
  .ideas-empty {
    border: 1px solid color-mix(in srgb, var(--t1) 10%, transparent);
    border-radius: 6px;
    padding: 16px;
  }

  .ideas-empty {
    padding: 28px 16px;
    text-align: center;
  }

  .ideas-error-text {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--t1);
  }

  .ideas-retry {
    margin-top: 10px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 14%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .ideas-retry:hover {
    background: var(--sel, color-mix(in srgb, var(--t1) 8%, transparent));
  }

  .ideas-retry:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: 2px;
  }

  .ideas-empty-chord {
    margin: 0 0 8px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 20px;
    letter-spacing: 0.06em;
    color: var(--t1);
  }

  .ideas-empty-text {
    margin: 0;
    font-size: 13px;
    color: var(--t2);
  }
</style>
