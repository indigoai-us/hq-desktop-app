<script lang="ts">
  /**
   * Library full-screen overlay (US-017).
   *
   * Takeover surface for route.kind === 'library': left nav (Skills N /
   * Workers N / Marketplace). Marketplace reuses the shared v1
   * MarketplacePanel (browse + detail + install) so web and desktop
   * hit the same hq-pro listings API.
   */
  import type { PlatformAdapter } from "@hq/platform";
  import {
    loadLibraryRoot,
    type LibraryItem,
    type LibraryItems,
  } from "./library.js";
  import LibraryDetailPanel from "./LibraryDetailPanel.svelte";
  import {
    subscribeLibraryRefresh,
    type LibraryRefreshHost,
    type UnlistenFn,
  } from "./library-refresh.js";
  import MarketplacePanel from "../marketplace/MarketplacePanel.svelte";
  import InstalledPacksPanel from "../marketplace/InstalledPacksPanel.svelte";
  import type { PackagesEvents } from "./packages-events.js";
  import {
    type LibraryTab,
    buildLibraryNavRows,
    filterSkillCards,
    filterWorkerCards,
    overlayTabToLibraryTab,
    resolveOverlayTab,
    toSkillCards,
    toWorkerCards,
    type LibraryOverlayTab,
  } from "./library-overlay-model.js";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    /** Platform seam: `library.*`, `marketplace.*`, and (desktop-only)
     *  `packages.listPackages` for the INSTALLED badge. */
    adapter: PlatformAdapter;
    /** Optional host refresh signals (window focus / sync-complete). */
    refreshHost?: LibraryRefreshHost | null;
    /** Routed library tab — mapped onto overlay Skills/Workers/Marketplace. */
    tab?: LibraryTab;
    onback?: () => void;
    /** Parent navigation when left-nav tab changes. */
    onnavigatetab?: (tab: LibraryTab) => void;
    /** Optional desktop package-operation stream for the Installed panel. */
    packagesEvents?: PackagesEvents | null;
  }

  let {
    adapter,
    refreshHost = null,
    tab = "skills",
    onback,
    onnavigatetab,
    packagesEvents = null,
  }: Props = $props();

  let currentTab = $state(tab);
  $effect(() => {
    currentTab = tab;
  });
  const showWorkers = $derived(false);
  const showMarketplace = $derived(adapter.kind !== "web");
  const activeTab = $derived(
    resolveOverlayTab(currentTab, {
      workers: showWorkers,
      marketplace: showMarketplace,
    }),
  );

  let items = $state<LibraryItems>({ workers: [], skills: [] });
  let libraryLoading = $state(true);
  let libraryError = $state<string | null>(null);
  let refreshNonce = $state(0);

  let query = $state("");
  let selected = $state<LibraryItem | null>(null);

  const navRows = $derived(
    buildLibraryNavRows(items, {
      workers: showWorkers,
      marketplace: showMarketplace,
    }),
  );
  const skillCards = $derived(
    filterSkillCards(toSkillCards(items.skills), query),
  );
  const workerCards = $derived(
    filterWorkerCards(toWorkerCards(items.workers), query),
  );

  function selectTab(next: LibraryOverlayTab): void {
    if (next === activeTab) return;
    query = "";
    selected = null;
    currentTab = overlayTabToLibraryTab(next);
    onnavigatetab?.(currentTab);
  }

  function selectSkill(path: string): void {
    const skill = items.skills.find((row) => row.path === path);
    selected = skill ? { kind: "skill", skill } : null;
  }

  function selectWorker(path: string): void {
    const worker = items.workers.find((row) => row.path === path);
    selected = worker ? { kind: "worker", worker } : null;
  }

  function closeDetail(): void {
    selected = null;
  }

  async function loadLibrary(): Promise<void> {
    libraryLoading = true;
    libraryError = null;
    const res = await loadLibraryRoot(adapter.library);
    if (res.ok) {
      items = res.value;
    } else {
      if (res.reason !== "unavailable") {
        console.error("library-overlay: loadLibraryRoot failed", res.message);
      }
      libraryError =
        res.reason === "unavailable"
          ? "Skills are not available here yet."
          : "Could not load skills.";
      items = { workers: [], skills: [] };
    }
    libraryLoading = false;
  }

  $effect(() => {
    refreshNonce;
    void loadLibrary();
  });

  $effect(() => {
    const host = refreshHost;
    if (!host) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void subscribeLibraryRefresh(host, () => {
      refreshNonce += 1;
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
</script>

<section
  class="library-overlay chat-shell"
  aria-label="Library"
  data-testid="library-overlay"
>
  <header class="lo-header">
    <button
      type="button"
      class="lo-back"
      data-testid="library-back"
      aria-label="Back"
      onclick={() => onback?.()}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M10 3.5 5.5 8 10 12.5"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      Back
    </button>
    <h1 class="lo-title" data-testid="library-overlay-title">Library</h1>
    <span class="lo-sub"
      >{showMarketplace
        ? "skills available to you, and packs"
        : "skills available to you"}</span
    >
  </header>

  <div class="lo-body">
    <nav
      class="lo-nav"
      aria-label="Library sections"
      data-testid="library-overlay-nav"
    >
      {#each navRows as row (row.id)}
        <button
          type="button"
          class="lo-nav-row"
          class:active={activeTab === row.id}
          data-testid={`library-nav-${row.id}`}
          aria-current={activeTab === row.id ? "page" : undefined}
          onclick={() => selectTab(row.id)}
        >
          <span class="lo-nav-ic" aria-hidden="true">
            {#if row.id === "skills"}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
                <path
                  d="M9 1.5V5.5H13"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </svg>
            {:else if row.id === "workers"}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="8"
                  cy="5.25"
                  r="2.25"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <path
                  d="M3.5 13c.4-2.3 2.1-3.5 4.5-3.5s4.1 1.2 4.5 3.5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 5.5 8 2.5 13 5.5v5L8 13.5 3 10.5v-5Z"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
                <path
                  d="M8 2.5v11M3 5.5l5 3 5-3"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </svg>
            {/if}
          </span>
          <span class="lo-nav-label">{row.label}</span>
          {#if row.count != null}
            <span class="lo-nav-count">{row.count}</span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="lo-main">
      {#if activeTab !== "marketplace"}
        <div class="lo-search-row">
          <div class="lo-search-wrap">
            <span class="lo-search-ic" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="7"
                  cy="7"
                  r="4.25"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <path
                  d="M10.4 10.4 13.5 13.5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <input
              type="search"
              class="lo-search"
              data-testid="library-overlay-search"
              placeholder="Search library — files, skills, workers…"
              aria-label="Filter library"
              bind:value={query}
            />
          </div>
        </div>
      {/if}

      {#if activeTab === "skills"}
        <div class="lo-panel" data-testid="library-skills-panel">
          {#if libraryLoading && items.skills.length === 0}
            <div
              class="lo-status"
              data-testid="library-overlay-loading"
              role="status"
            >
              Loading skills…
            </div>
          {:else if libraryError && items.skills.length === 0}
            <div
              class="lo-status"
              data-testid="library-overlay-error"
              role="alert"
            >
              {libraryError}
            </div>
          {:else if skillCards.length === 0}
            <div
              class="lo-status"
              data-testid="library-skills-empty"
              role="status"
            >
              {query.trim()
                ? "No skills match that search."
                : "No skills shared with you yet."}
            </div>
          {:else}
            <div class="lo-cards" data-testid="library-skills-grid">
              {#each skillCards as card (card.key)}
                <button
                  type="button"
                  class="lo-card"
                  data-testid="library-skill-card"
                  aria-label={`Open ${card.name} skill`}
                  onclick={() => selectSkill(card.path)}
                >
                  <span class="lo-card-ic" aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M9 1.5V5.5H13"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                  <div class="lo-card-title">{card.name}</div>
                  <div class="lo-card-slug">{card.slug}</div>
                  <span class="lo-card-tag">{card.tag}</span>
                  {#if card.description}
                    <p class="lo-card-desc">{card.description}</p>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === "workers"}
        <div class="lo-panel" data-testid="library-workers-panel">
          {#if libraryLoading && items.workers.length === 0}
            <div
              class="lo-status"
              data-testid="library-overlay-loading"
              role="status"
            >
              Loading workers…
            </div>
          {:else if libraryError && items.workers.length === 0}
            <div
              class="lo-status"
              data-testid="library-overlay-error"
              role="alert"
            >
              {libraryError}
            </div>
          {:else if workerCards.length === 0}
            <div
              class="lo-status"
              data-testid="library-workers-empty"
              role="status"
            >
              {query.trim()
                ? "No workers match that search."
                : "No workers in your HQ yet."}
            </div>
          {:else}
            <div class="lo-cards" data-testid="library-workers-grid">
              {#each workerCards as card (card.key)}
                <button
                  type="button"
                  class="lo-card"
                  data-testid="library-worker-card"
                  aria-label={`Open ${card.name} worker`}
                  onclick={() => selectWorker(card.path)}
                >
                  <span class="lo-card-ic" aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <circle
                        cx="8"
                        cy="5.25"
                        r="2.25"
                        stroke="currentColor"
                        stroke-width="1.3"
                      />
                      <path
                        d="M3.5 13c.4-2.3 2.1-3.5 4.5-3.5s4.1 1.2 4.5 3.5"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                      />
                    </svg>
                  </span>
                  <div class="lo-card-title">{card.name}</div>
                  <div class="lo-card-slug">{card.type}</div>
                  {#if card.team}
                    <span class="lo-card-tag">{card.team}</span>
                  {/if}
                  {#if card.description}
                    <p class="lo-card-desc">{card.description}</p>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === "installed"}
        <div class="lo-panel" data-testid="library-installed-panel">
          <InstalledPacksPanel {adapter} {packagesEvents} />
        </div>
      {:else}
        <div class="lo-panel lo-market" data-testid="library-marketplace-panel">
          <MarketplacePanel {adapter} />
        </div>
      {/if}
    </div>
  </div>

  <LibraryDetailPanel
    library={adapter.library}
    item={selected}
    onclose={closeDetail}
  />
</section>

<style>
  .library-overlay {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--v4-bg, var(--desktop-bg, #0c0c0c));
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  .lo-header {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 0 auto;
    padding: 0 20px;
    height: 52px;
    flex: 0 0 52px;
    border-bottom: 1px solid var(--line);
  }

  .lo-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--line2, var(--v4-control-border));
    border-radius: 8px;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    cursor: pointer;
  }
  .lo-back:hover {
    background: var(--hover);
    color: var(--t1);
  }
  .lo-back:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .lo-title {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
  }

  .lo-sub {
    min-width: 0;
    overflow: hidden;
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lo-body {
    display: grid;
    grid-template-columns: 210px minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
  }

  .lo-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 16px 20px;
    border-right: 1px solid var(--line);
    overflow: auto;
  }

  .lo-nav-ic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--t3);
  }
  .lo-nav-row.active .lo-nav-ic {
    color: var(--t2);
  }

  .lo-nav-row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .lo-nav-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lo-nav-count {
    margin-left: auto;
    color: var(--t3);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 10px;
  }
  .lo-nav-row:hover {
    background: var(--hover);
  }
  .lo-nav-row.active {
    background: var(--sel);
    color: var(--t1);
    font-weight: 500;
  }
  .lo-nav-row:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 1px;
  }

  .lo-main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    padding: 16px 20px 20px;
    overflow: auto;
  }

  .lo-search-row {
    flex: 0 0 auto;
    padding: 0 0 4px;
  }

  .lo-search-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: none;
    padding: 7px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    transition: border-color 0.12s;
  }
  .lo-search-wrap:hover {
    border-color: var(--line2);
  }
  .lo-search-wrap:focus-within {
    border-color: var(--border-active);
  }

  .lo-search-ic {
    display: inline-flex;
    color: var(--t3);
  }

  .lo-search {
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--t1);
    font: 400 12px var(--font-ui);
  }
  .lo-search::placeholder {
    color: var(--t3);
  }
  .lo-search:focus {
    outline: none;
  }

  .lo-panel {
    min-width: 0;
  }

  .lo-market {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 0 2px 24px;
  }

  .lo-status {
    padding: 16px 0;
    color: var(--t3);
    font-size: 13px;
    line-height: 18px;
  }
  .lo-install-error {
    color: var(--warn-ink);
  }

  .lo-cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-content: start;
  }

  .lo-card {
    appearance: none;
    -webkit-appearance: none;
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .lo-card:hover {
    background: var(--btn-bg);
    border-color: var(--line2);
  }

  .lo-card:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 1px;
  }

  .lo-card-ic {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--t2);
  }

  .lo-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .lo-card-title {
    min-width: 0;
    flex: 1 1 auto;
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lo-card-slug {
    display: none;
  }

  .lo-card-tag {
    margin-left: auto;
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--t3);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.04em;
    line-height: 14px;
    text-transform: uppercase;
  }

  .lo-card-desc {
    display: none;
  }

  .lo-card-meta {
    color: var(--t3);
    font-size: 10px;
    line-height: 14px;
  }

  .lo-badge {
    flex: 0 0 auto;
    padding: 2px 8px;
    border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--ok) 10%, transparent);
    color: var(--ok-ink);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 14px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .lo-badge.update {
    border-color: color-mix(in srgb, var(--warn) 35%, transparent);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    color: var(--warn-ink);
  }

  .lo-get {
    flex: 0 0 auto;
    padding: 3px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.12s;
  }
  .lo-get:hover:not(:disabled) {
    border-color: var(--line2);
  }
  .lo-get:active:not(:disabled) {
    border-color: var(--border-active);
  }
  .lo-get:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .lo-get:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  @media (max-width: 720px) {
    .lo-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .lo-nav {
      flex-direction: row;
      flex-wrap: wrap;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
  }
</style>
