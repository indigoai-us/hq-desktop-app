<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { dismissable } from "../../common/dismissable.js";
  import ReadLoader from "../../common/ReadLoader.svelte";
  /**
   * Browse packs sheet (US-036). Installed rows paint from the Core popover
   * cache on the first frame. The marketplace catalog refreshes after.
   */
  import type { MarketplaceApi } from "@hq/platform";
  import { loadMarketplaceListings, type MarketplaceListing } from "../../marketplace/marketplace.js";
  import type { CorePopoverPack } from "../core-popover-model.js";
  import { packDisplayName } from "../pack-display-name.js";

  interface Props {
    installed: readonly CorePopoverPack[];
    marketplace?: MarketplaceApi | null;
    onopenLibrary?: () => void;
    onclose?: () => void;
  }

  let { installed, marketplace = null, onopenLibrary, onclose }: Props = $props();

  let query = $state("");
  let tab = $state<"all" | "installed" | "updates">("all");
  let catalog = $state<MarketplaceListing[]>([]);
  let catalogState = $state<"idle" | "loading" | "ready" | "error">("idle");
  let busyId = $state<string | null>(null);

  const installedNames = $derived(new Set(installed.map((p) => p.name.toLowerCase())));

  const visibleInstalled = $derived(
    installed.filter((p) => {
      if (tab === "updates" && !p.isNew) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || packDisplayName(p).toLowerCase().includes(q);
    }),
  );

  const visibleCatalog = $derived(
    tab === "installed" || tab === "updates"
      ? []
      : catalog.filter((row) => {
          if (installedNames.has(row.slug.toLowerCase()) || installedNames.has(row.name.toLowerCase())) {
            return false;
          }
          const q = query.trim().toLowerCase();
          if (!q) return true;
          return row.name.toLowerCase().includes(q) || row.slug.toLowerCase().includes(q);
        }),
  );

  $effect(() => {
    const api = marketplace;
    const q = query;
    if (!api?.listListings) return;
    let alive = true;
    catalogState = "loading";
    void loadMarketplaceListings(api, q).then((res) => {
      if (!alive) return;
      if (res.ok) {
        catalog = res.value;
        catalogState = "ready";
      } else {
        catalogState = "error";
      }
    });
    return () => {
      alive = false;
    };
  });

  async function install(listing: MarketplaceListing): Promise<void> {
    if (!marketplace?.installPack || busyId) return;
    busyId = listing.id;
    try {
      await marketplace.installPack(listing as unknown as Record<string, unknown>);
    } finally {
      busyId = null;
    }
  }

  function mark(name: string): string {
    const letters = name.replace(/[^a-zA-Z]/g, "");
    return (letters.slice(0, 2) || "pk").toLowerCase();
  }
</script>

<div class="bp-scrim" role="presentation" onclick={onclose}></div>
<div class="bp-sheet" role="dialog" aria-label="Browse packs" data-testid="browse-packs-sheet" use:dismissable={{ onclose }}>
  <header class="bp-h">
    Browse packs
    <button type="button" class="icon" aria-label="Close" data-testid="browse-packs-close" onclick={onclose}>✕</button>
  </header>
  <div class="bp-tb">
    <input class="search" type="search" placeholder="Search packs" aria-label="Search packs" bind:value={query} />
    <div class="grow"></div>
    <div class="tabs">
      <button type="button" class="tab" aria-pressed={tab === "all"} onclick={() => (tab = "all")}>All</button>
      <button type="button" class="tab" aria-pressed={tab === "installed"} onclick={() => (tab = "installed")}>Installed · {installed.length}</button>
      <button type="button" class="tab" aria-pressed={tab === "updates"} onclick={() => (tab = "updates")}>Updates</button>
    </div>
  </div>
  <div class="bp-b">
    <div class="sec">Installed on this machine</div>
    {#if visibleInstalled.length === 0}
      <p class="empty">No installed packs in this view.</p>
    {:else}
      {#each visibleInstalled as pack (pack.name)}
        <div class="bp-row" data-testid="browse-packs-installed">
          <span class="ic">{mark(pack.name)}</span>
          <div>
            <div class="nm">{packDisplayName(pack)}{#if pack.isNew} <span class="pl">new</span>{/if}</div>
          </div>
          <span class="vr">{pack.version ? `v${pack.version}` : ""}</span>
          <span class="ok">Installed</span>
        </div>
      {/each}
    {/if}
    {#if tab === "all"}
      <div class="sec">Available</div>
      {#if catalogState === "loading" && visibleCatalog.length === 0}
        <ReadLoader testid="browse-packs-loading" />
      {:else if catalogState === "error"}
        <p class="empty">Catalog could not refresh. Installed packs above are from this machine.</p>
      {:else if visibleCatalog.length === 0}
        <p class="empty">No other packs to show.</p>
      {:else}
        {#each visibleCatalog as listing (listing.id)}
          <div class="bp-row" data-testid="browse-packs-available">
            <span class="ic">{mark(listing.slug || listing.name)}</span>
            <div>
              <div class="nm">{listing.name}</div>
              {#if listing.summary}<div class="ds">{listing.summary}</div>{/if}
            </div>
            <span class="vr">{listing.version ? `v${listing.version}` : ""}</span>
            <button
              type="button"
              class="btn"
              data-testid="browse-packs-install"
              disabled={busyId === listing.id}
              onclick={() => void install(listing)}
            ><RailIcon name="download" />{busyId === listing.id ? "Installing…" : "Install"}</button>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
  <footer class="bp-f">
    <span class="hint">Packs install into core and survive an HQ update.</span>
    <button type="button" class="btn" data-testid="browse-packs-library" onclick={() => { onopenLibrary?.(); onclose?.(); }}>Marketplace</button>
    <button type="button" class="btn" onclick={onclose}><RailIcon name="check" />Done</button>
  </footer>
</div>

<style>
  .bp-scrim { position: fixed; inset: 0; z-index: 10020; background: rgba(0, 0, 0, 0.45); }
  .bp-sheet {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    z-index: 10021; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--overlay-bg, var(--v4-popover)); border: 1px solid var(--v4-hairline); border-radius: 8px;
    box-shadow: var(--v4-shadow-popover, 0 16px 48px rgba(0, 0, 0, 0.28));
    color: var(--v4-text-1); font-size: 13px;
  }
  .bp-h {
    height: 52px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 16px;
    border-bottom: 1px solid var(--v4-hairline); font-size: 15px; font-weight: 600;
  }
  .icon { margin-left: auto; appearance: none; border: 0; background: transparent; color: var(--v4-text-3); cursor: pointer; }
  .bp-tb { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--v4-rowline); }
  .search {
    width: 220px; height: 26px; border-radius: 6px; padding: 0 8px; font: inherit; font-size: 12px;
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    background: var(--v4-control-bg, transparent); color: var(--v4-text-1);
  }
  .grow { flex: 1; }
  .tabs { display: flex; gap: 4px; }
  .tab {
    appearance: none; border: 0; background: transparent; color: var(--v4-text-2);
    font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  }
  .tab[aria-pressed="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .bp-b { flex: 1; min-height: 0; overflow: auto; }
  .sec {
    padding: 12px 16px 4px; font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--v4-text-3);
  }
  .bp-row {
    display: grid; grid-template-columns: 28px minmax(0, 1fr) auto auto; gap: 12px; align-items: center;
    padding: 9px 16px; border-bottom: 1px solid var(--v4-rowline);
  }
  .bp-row:hover { background: var(--v4-hover); }
  .ic {
    width: 28px; height: 28px; border-radius: 7px; background: var(--v4-control-bg);
    display: grid; place-items: center; font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px; color: var(--v4-text-2);
  }
  .nm { font-weight: 500; display: flex; gap: 6px; align-items: center; }
  .pl {
    font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.06em;
    text-transform: uppercase; padding: 1px 6px; border-radius: 999px;
    background: var(--v4-control-faint); color: var(--v4-text-2); font-weight: 400;
  }
  .ds { font-size: 12px; color: var(--v4-text-3); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vr { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--v4-text-3); }
  .ok { font-size: 12px; color: var(--v4-text-3); }
  .empty { padding: 8px 16px 12px; color: var(--v4-text-3); font-size: 12px; }
  .bp-f { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--v4-hairline); }
  .hint { flex: 1; font-size: 12px; color: var(--v4-text-3); }
  .btn {
    appearance: none; border: 1px solid var(--v4-control-border, var(--v4-hairline));
    background: var(--v4-control-bg, transparent); color: var(--v4-text-1);
    border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; }
</style>
