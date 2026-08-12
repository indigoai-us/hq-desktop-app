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
  class="library-overlay"
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
    color: var(--v4-text-1);
    font-family: var(--font-sans);
  }

  .lo-header {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 0 auto;
    padding: 12px 16px;
    border-bottom: 1px solid var(--v4-rowline);
  }

  .lo-back {
    padding: 4px 0;
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, 11px);
    font-weight: 500;
    line-height: 16px;
    cursor: pointer;
  }
  .lo-back:hover {
    color: var(--v4-text-1);
  }
  .lo-back:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .lo-title {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-detail, 18px);
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .lo-body {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
  }

  .lo-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 10px;
    border-right: 1px solid var(--v4-rowline);
    overflow: auto;
  }

  .lo-nav-row {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 16px;
    text-align: left;
    cursor: pointer;
  }
  .lo-nav-row:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }
  .lo-nav-row.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
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
    padding: 12px 16px 20px;
    overflow: auto;
  }

  .lo-search-row {
    flex: 0 0 auto;
  }

  .lo-search {
    width: 100%;
    max-width: 420px;
    padding: 7px 10px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-field);
    background: var(--v4-inset);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, 12px);
    line-height: 18px;
  }
  .lo-search::placeholder {
    color: var(--v4-text-3);
  }
  .lo-search:focus {
    outline: none;
    border-color: var(--v4-text-3);
  }

  .lo-panel {
    min-width: 0;
  }

  .lo-status {
    padding: 16px 0;
    color: var(--v4-text-3);
    font-size: var(--type-body, 12px);
    line-height: 18px;
  }
  .lo-install-error {
    color: var(--v4-error);
  }

  .lo-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }

  .lo-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--v4-rowline);
    border-radius: var(--v4-radius-button);
    background: transparent;
  }

  .lo-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .lo-card-title {
    min-width: 0;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 16px;
  }

  .lo-card-slug {
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
  }

  .lo-card-tag {
    align-self: flex-start;
    padding: 1px 7px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 14px;
    text-transform: uppercase;
  }

  .lo-card-desc {
    margin: 0;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .lo-card-meta {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
  }

  .lo-badge {
    flex: 0 0 auto;
    padding: 2px 7px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-2);
    font-size: var(--type-metadata, 10px);
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 14px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .lo-badge.update {
    color: var(--v4-text-1);
  }

  .lo-get {
    flex: 0 0 auto;
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--type-secondary, 11px);
    font-weight: 500;
    line-height: 14px;
    cursor: pointer;
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
      border-bottom: 1px solid var(--v4-rowline);
    }
  }
</style>
