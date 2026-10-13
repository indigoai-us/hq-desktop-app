<script lang="ts">
  /**
   * Preview of the Marketplace tab (?view=marketplace) with one listing whose
   * detail panel opens on load, so the "View public page" / "Copy link" row
   * can be checked. In-page listings only (no network).
   */
  import { onMount } from 'svelte';
  import { ok, type PlatformAdapter } from '@hq/platform';
  import MarketplacePanel from '../../../packages/ui/src/marketplace/MarketplacePanel.svelte';

  const listing = {
    id: 'listing-bfcm',
    type: 'skill',
    name: 'hq-pack-bfcm-retention',
    slug: 'bfcm-retention',
    version: '1.0.0',
    author: { handle: 'boringecom', displayName: 'Boring Ecom' },
    summary: 'Retention flows for Black Friday and Cyber Monday buyers.',
    contributes: '1 skill',
    createdAt: '2026-10-01T00:00:00Z',
  };

  const adapter = {
    kind: 'web',
    capabilities: {},
    isAvailable: () => false,
    marketplace: {
      listListings: async () => ok({ listings: [listing] }),
      getListing: async () => ok({ ...listing, downloadUrl: '' }),
    },
  } as unknown as PlatformAdapter;

  onMount(() => {
    const open = () => {
      const card = document.querySelector<HTMLElement>('[data-testid="marketplace-card"]');
      if (card) card.click();
      else setTimeout(open, 50);
    };
    open();
  });
</script>

<div class="marketplace-preview" data-window="desktop-alt">
  <MarketplacePanel {adapter} />
</div>

<style>
  .marketplace-preview {
    position: fixed;
    inset: 0;
    overflow: auto;
    background: var(--v4-canvas, #111);
  }
</style>
