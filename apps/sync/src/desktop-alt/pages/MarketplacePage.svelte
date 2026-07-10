<script lang="ts">
  /**
   * MarketplacePage — Marketplace as a top-level desktop destination (US-007,
   * ⌘4). Promoted out of the Library tabs; the self-contained MarketplacePanel
   * owns fetching, install states, README preview, and YOUR LISTINGS.
   */
  import MarketplacePanel from '../panels/MarketplacePanel.svelte';
</script>

<section class="marketplace-page" aria-labelledby="marketplace-page-title">
  <header class="page-header">
    <h1 id="marketplace-page-title">Marketplace</h1>
    <p>Discover and install skills and workers</p>
  </header>

  <MarketplacePanel />
</section>

<style>
  .marketplace-page {
    display: grid;
    gap: var(--v4-space-5);
    font-family: var(--font-sans);
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
