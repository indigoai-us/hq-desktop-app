<script lang="ts">
  /**
   * Library full-screen overlay (US-017).
   *
   * Takeover surface for route.kind === 'library': left nav (Skills N /
   * Workers N / Marketplace), search, card grids, marketplace pack cards with
   * INSTALLED / UPDATE / Get. Composes loadLibraryRoot + marketplace +
   * list_packages only — no new backend endpoints.
   */
  import { invoke } from '@tauri-apps/api/core';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import {
    loadLibraryRoot,
    type LibraryItems,
  } from '../lib/library';
  import { subscribeLibraryRefresh } from '../lib/library-refresh';
  import {
    installMarketplacePack,
    loadMarketplaceListings,
    recordMarketplaceInstall,
    type MarketplaceListing,
  } from '../lib/marketplace';
  import type { PackagesView } from '../../lib/packages';
  import type { LibraryTab } from '../route';
  import {
    buildLibraryNavRows,
    filterSkillCards,
    filterWorkerCards,
    formatNavLabel,
    overlayTabToLibraryTab,
    resolveOverlayTab,
    toMarketplaceCards,
    toSkillCards,
    toWorkerCards,
    type LibraryOverlayTab,
    type MarketplaceBadge,
  } from './library-overlay-model';
  import '../v4/tokens.css';
  import './chat-tokens.css';

  interface Props {
    /** Routed library tab — mapped onto overlay Skills/Workers/Marketplace. */
    tab?: LibraryTab;
    onback?: () => void;
    /** Parent navigation when left-nav tab changes. */
    onnavigatetab?: (tab: LibraryTab) => void;
  }

  let { tab = 'skills', onback, onnavigatetab }: Props = $props();

  const activeTab = $derived(resolveOverlayTab(tab));

  let items = $state<LibraryItems>({ workers: [], skills: [] });
  let libraryLoading = $state(true);
  let libraryError = $state<string | null>(null);
  let refreshNonce = $state(0);

  let listings = $state<MarketplaceListing[]>([]);
  let marketLoading = $state(false);
  let marketError = $state<string | null>(null);
  let marketLoaded = $state(false);

  let installedPacks = $state<
    Array<{ name: string; source?: string | null; updateAvailable?: boolean | null }>
  >([]);
  let installBusySlug = $state<string | null>(null);
  let installError = $state<string | null>(null);

  let query = $state('');

  const navRows = $derived(buildLibraryNavRows(items));
  const skillCards = $derived(filterSkillCards(toSkillCards(items.skills), query));
  const workerCards = $derived(filterWorkerCards(toWorkerCards(items.workers), query));
  const marketCards = $derived(toMarketplaceCards(listings, installedPacks, query));

  function selectTab(next: LibraryOverlayTab): void {
    if (next === activeTab) return;
    query = '';
    onnavigatetab?.(overlayTabToLibraryTab(next));
  }

  async function loadLibrary(): Promise<void> {
    libraryLoading = true;
    libraryError = null;
    try {
      items = await loadLibraryRoot();
    } catch (err) {
      console.error('library-overlay: loadLibraryRoot failed', err);
      libraryError = 'Library unavailable. Try again after a sync.';
      items = { workers: [], skills: [] };
    } finally {
      libraryLoading = false;
    }
  }

  async function loadMarketplace(): Promise<void> {
    marketLoading = true;
    marketError = null;
    try {
      const [rows, packages] = await Promise.all([
        loadMarketplaceListings(),
        invoke<PackagesView>('list_packages').catch((err) => {
          console.error('library-overlay: list_packages failed', err);
          return null;
        }),
      ]);
      listings = rows;
      installedPacks = packages?.packs?.installed ?? [];
      marketLoaded = true;
    } catch (err) {
      console.error('library-overlay: marketplace load failed', err);
      marketError =
        err instanceof Error ? err.message : 'Marketplace unavailable right now.';
      listings = [];
    } finally {
      marketLoading = false;
    }
  }

  $effect(() => {
    refreshNonce;
    void loadLibrary();
  });

  $effect(() => {
    if (activeTab === 'marketplace' && !marketLoaded && !marketLoading) {
      void loadMarketplace();
    }
  });

  $effect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void subscribeLibraryRefresh(() => {
      refreshNonce += 1;
      if (marketLoaded) {
        marketLoaded = false;
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  async function handleGet(slug: string, version: string, listingId: string): Promise<void> {
    if (installBusySlug) return;
    installBusySlug = slug;
    installError = null;
    try {
      await installMarketplacePack(slug, version, { kind: 'personal' });
      void recordMarketplaceInstall(listingId, { kind: 'personal' }).catch(() => {});
      // Re-read installed snapshot so badge flips to INSTALLED.
      marketLoaded = false;
      await loadMarketplace();
    } catch (err) {
      console.error('library-overlay: install failed', err);
      installError = err instanceof Error ? err.message : String(err);
    } finally {
      installBusySlug = null;
    }
  }

  function badgeLabel(badge: MarketplaceBadge): string {
    if (badge === 'installed') return 'INSTALLED';
    if (badge === 'update') return 'UPDATE';
    return 'Get';
  }
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
      ← Back
    </button>
    <h1 class="lo-title" data-testid="library-overlay-title">Library</h1>
  </header>

  <div class="lo-body">
    <nav class="lo-nav" aria-label="Library sections" data-testid="library-overlay-nav">
      {#each navRows as row (row.id)}
        <button
          type="button"
          class="lo-nav-row"
          class:active={activeTab === row.id}
          data-testid={`library-nav-${row.id}`}
          aria-current={activeTab === row.id ? 'page' : undefined}
          onclick={() => selectTab(row.id)}
        >
          <span class="lo-nav-label">{formatNavLabel(row)}</span>
        </button>
      {/each}
    </nav>

    <div class="lo-main">
      <div class="lo-search-row">
        <input
          type="search"
          class="lo-search"
          data-testid="library-overlay-search"
          placeholder={activeTab === 'marketplace'
            ? 'Search packs…'
            : activeTab === 'workers'
              ? 'Search workers…'
              : 'Search skills…'}
          aria-label="Filter library"
          bind:value={query}
        />
      </div>

      {#if activeTab === 'skills'}
        <div class="lo-panel" data-testid="library-skills-panel">
          {#if libraryLoading && items.skills.length === 0}
            <div class="lo-status" data-testid="library-overlay-loading" role="status">
              Loading skills…
            </div>
          {:else if libraryError && items.skills.length === 0}
            <div class="lo-status" data-testid="library-overlay-error" role="alert">
              {libraryError}
            </div>
          {:else if skillCards.length === 0}
            <div class="lo-status" data-testid="library-skills-empty" role="status">
              {query.trim() ? 'No skills match that search.' : 'No skills in your HQ yet.'}
            </div>
          {:else}
            <div class="lo-cards" data-testid="library-skills-grid">
              {#each skillCards as card (card.key)}
                <article class="lo-card" data-testid="library-skill-card">
                  <div class="lo-card-title">{card.name}</div>
                  <div class="lo-card-slug">{card.slug}</div>
                  <span class="lo-card-tag">{card.tag}</span>
                  {#if card.description}
                    <p class="lo-card-desc">{card.description}</p>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === 'workers'}
        <div class="lo-panel" data-testid="library-workers-panel">
          {#if libraryLoading && items.workers.length === 0}
            <div class="lo-status" data-testid="library-overlay-loading" role="status">
              Loading workers…
            </div>
          {:else if libraryError && items.workers.length === 0}
            <div class="lo-status" data-testid="library-overlay-error" role="alert">
              {libraryError}
            </div>
          {:else if workerCards.length === 0}
            <div class="lo-status" data-testid="library-workers-empty" role="status">
              {query.trim() ? 'No workers match that search.' : 'No workers in your HQ yet.'}
            </div>
          {:else}
            <div class="lo-cards" data-testid="library-workers-grid">
              {#each workerCards as card (card.key)}
                <article class="lo-card" data-testid="library-worker-card">
                  <div class="lo-card-title">{card.name}</div>
                  <div class="lo-card-slug">{card.type}</div>
                  {#if card.team}
                    <span class="lo-card-tag">{card.team}</span>
                  {/if}
                  {#if card.description}
                    <p class="lo-card-desc">{card.description}</p>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="lo-panel" data-testid="library-marketplace-panel">
          {#if installError}
            <div class="lo-status lo-install-error" role="alert" data-testid="library-install-error">
              {installError}
            </div>
          {/if}
          {#if marketLoading && listings.length === 0}
            <div class="lo-status" data-testid="library-marketplace-loading" role="status">
              Loading marketplace…
            </div>
          {:else if marketError && listings.length === 0}
            <div class="lo-status" data-testid="library-marketplace-error" role="alert">
              {marketError}
            </div>
          {:else if marketCards.length === 0}
            <div class="lo-status" data-testid="library-marketplace-empty" role="status">
              {query.trim()
                ? 'No packs match that search.'
                : 'No marketplace packs available right now.'}
            </div>
          {:else}
            <div class="lo-cards" data-testid="library-marketplace-grid">
              {#each marketCards as card (card.id)}
                <article class="lo-card lo-pack-card" data-testid="library-marketplace-card">
                  <div class="lo-card-head">
                    <div class="lo-card-title">{card.displayName}</div>
                    {#if card.badge === 'get'}
                      <button
                        type="button"
                        class="lo-get"
                        data-testid="library-pack-get"
                        data-slug={card.slug}
                        disabled={installBusySlug === card.slug}
                        aria-busy={installBusySlug === card.slug}
                        onclick={() => void handleGet(card.slug, card.version, card.id)}
                      >
                        {installBusySlug === card.slug ? 'Installing…' : 'Get'}
                      </button>
                    {:else}
                      <span
                        class="lo-badge"
                        class:update={card.badge === 'update'}
                        data-testid="library-pack-badge"
                        data-badge={card.badge}
                      >
                        {badgeLabel(card.badge)}
                      </span>
                    {/if}
                  </div>
                  <div class="lo-card-slug">{card.slug} · v{card.version}</div>
                  {#if card.summary}
                    <p class="lo-card-desc">{card.summary}</p>
                  {/if}
                  <div class="lo-card-meta">by {card.author}</div>
                </article>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
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
    padding: 4px 0;
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    cursor: pointer;
  }
  .lo-back:hover {
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
  }

  .lo-search {
    width: 100%;
    max-width: 420px;
    padding: 7px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t1);
    font: 400 12px var(--font-ui);
    transition: border-color 0.12s;
  }
  .lo-search::placeholder {
    color: var(--t3);
  }
  .lo-search:hover {
    border-color: var(--line2);
  }
  .lo-search:focus {
    outline: none;
    border-color: var(--border-active);
  }

  .lo-panel {
    min-width: 0;
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
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 14px;
    align-content: start;
  }

  .lo-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--raised);
  }

  .lo-card:hover {
    background: var(--btn-bg);
    border-color: var(--line2);
  }

  .lo-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .lo-card-title {
    min-width: 0;
    color: var(--t1);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
  }

  .lo-card-slug {
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 14px;
  }

  .lo-card-tag {
    align-self: flex-start;
    padding: 2px 8px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t2);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 14px;
    text-transform: uppercase;
  }

  .lo-card-desc {
    margin: 0;
    color: var(--t2);
    font-size: 12px;
    line-height: 17px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
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
