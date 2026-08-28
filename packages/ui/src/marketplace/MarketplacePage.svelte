<script lang="ts">
  /**
   * MarketplacePage — Marketplace as a top-level desktop destination (US-007,
   * ⌘4). Promoted out of the Library tabs; the self-contained MarketplacePanel
   * owns fetching, install states, README preview, and the published listing grid.
   */
  import type { PlatformAdapter } from "@hq/platform";
  import MarketplacePanel, {
    type MarketplaceInstallEvents,
  } from "./MarketplacePanel.svelte";

  interface Props {
    adapter: PlatformAdapter;
    /** Optional desktop install-progress stream (forwarded to the panel). */
    installEvents?: MarketplaceInstallEvents | null;
  }

  let { adapter, installEvents = null }: Props = $props();
</script>

<section class="marketplace-page" aria-labelledby="marketplace-page-title">
  <header class="page-header">
    <h1 id="marketplace-page-title">Marketplace</h1>
    <p>Discover and install skills and workers</p>
  </header>

  <MarketplacePanel {adapter} {installEvents} />
</section>

<style>
  .marketplace-page {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 16px;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: auto;
    padding: 16px 22px 28px;
    font-family: var(--font-sans);
  }

  .page-header {
    flex: 0 0 auto;
  }

  .page-header h1 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 1.15;
  }

  .page-header p {
    margin: 5px 0 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 1.4;
  }
</style>
