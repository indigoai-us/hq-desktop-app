<script lang="ts">
  /**
   * Marketplace page (OWNER-R33; was the Library overlay, US-017).
   *
   * Route kind 'library' renders this page in the shell's normal body, under
   * the top bar. The left list is Browse, Installed and Submit; Browse is the
   * default. Skills and Workers live in each company's Brain panes, and the
   * personal and core ones in the Files tree. Browse reuses the shared v1
   * panel so web and desktop hit the same listings API.
   */
  import type { PlatformAdapter } from "@hq/platform";
  import MarketplacePanel from "../marketplace/MarketplacePanel.svelte";
  import InstalledPacksPanel from "../marketplace/InstalledPacksPanel.svelte";
  import SubmitPanel from "../marketplace/SubmitPanel.svelte";
  import type { PackagesEvents } from "./packages-events.js";
  import {
    type LibraryTab,
    buildLibraryNavRows,
    libraryOverlayCapabilities,
    overlayTabToLibraryTab,
    resolveOverlayTab,
    type LibraryOverlayTab,
  } from "./library-overlay-model.js";
  import PageHeader from "../shell/PageHeader.svelte";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    /** Platform seam: `marketplace.*` and (desktop-only)
     *  `packages.listPackages` for the INSTALLED badge. */
    adapter: PlatformAdapter;
    /** Routed tab. Legacy `skills` / `workers` resolve to Browse. */
    tab?: LibraryTab;
    /** Parent navigation when the left-list tab changes. */
    onnavigatetab?: (tab: LibraryTab) => void;
    /** Optional desktop package-operation stream for the Installed panel. */
    packagesEvents?: PackagesEvents | null;
  }

  let {
    adapter,
    tab = "marketplace",
    onnavigatetab,
    packagesEvents = null,
  }: Props = $props();

  let currentTab = $state(tab);
  $effect(() => {
    currentTab = tab;
  });
  const hostCapabilities = $derived(libraryOverlayCapabilities(adapter.capabilities));
  const showMarketplace = $derived(hostCapabilities.marketplace);
  const activeTab = $derived(
    resolveOverlayTab(currentTab, { marketplace: showMarketplace }),
  );
  const navRows = $derived(buildLibraryNavRows({ marketplace: showMarketplace }));

  function selectTab(next: LibraryOverlayTab): void {
    if (next === activeTab) return;
    currentTab = overlayTabToLibraryTab(next);
    onnavigatetab?.(currentTab);
  }
</script>

<section
  class="marketplace-page chat-shell"
  aria-label="Marketplace"
  data-testid="library-overlay"
>
  <PageHeader
    title="Marketplace"
    subtitle={showMarketplace
      ? "Packs from creators, and what you have installed"
      : "Packs from creators"}
    titleTestId="library-overlay-title"
  />

  <div class="lo-body">
    <nav
      class="lo-nav"
      aria-label="Marketplace sections"
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
          </span>
          <span class="lo-nav-label">{row.label}</span>
          {#if row.count != null}
            <span class="lo-nav-count">{row.count}</span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="lo-main">
      {#if activeTab === "installed"}
        <div class="lo-panel" data-testid="library-installed-panel">
          <InstalledPacksPanel {adapter} {packagesEvents} />
        </div>
      {:else if activeTab === "submit"}
        <div class="lo-panel lo-market" data-testid="library-submit-panel">
          <SubmitPanel {adapter} />
        </div>
      {:else}
        <div class="lo-panel lo-market" data-testid="library-marketplace-panel">
          <MarketplacePanel {adapter} />
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  /* OWNER-R33: an in-flow page under the top bar, like Files and Settings.
     It used to be an absolute z-index:40 layer over the whole shell, which
     out-stacked the top bar (z-index:30) and buried its Launch and Core
     menus, the notification panel and the account menu. No z-index here. */
  .marketplace-page {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--v4-bg, var(--desktop-bg, #0c0c0c));
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
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
