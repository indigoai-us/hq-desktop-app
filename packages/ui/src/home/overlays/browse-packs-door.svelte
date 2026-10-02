<script lang="ts">
  /** First-frame door. Skeleton paints before the browse-packs chunk loads. */
  import { onMount } from "svelte";
  import type { Component } from "svelte";
  import type { MarketplaceApi } from "@hq/platform";
  import type { CorePopoverPack } from "../core-popover-model.js";

  interface Props {
    installed: readonly CorePopoverPack[];
    marketplace?: MarketplaceApi | null;
    onopenLibrary?: () => void;
    onclose?: () => void;
  }

  let { installed, marketplace = null, onopenLibrary, onclose }: Props = $props();
  let Sheet: Component<Props> | null = $state(null);

  onMount(() => {
    let alive = true;
    void import("./browse-packs-sheet.svelte").then((mod) => {
      if (alive) Sheet = mod.default as Component<Props>;
    });
    return () => {
      alive = false;
    };
  });
</script>

{#if Sheet}
  <Sheet {installed} {marketplace} {onopenLibrary} {onclose} />
{:else}
  <div class="bp-scrim" role="presentation"></div>
  <div class="bp-sheet" role="dialog" aria-label="Browse packs" aria-busy="true" data-testid="browse-packs-sheet">
    <header>Browse packs</header>
    <div class="shimmer"></div>
    <div class="shimmer"></div>
  </div>
{/if}

<style>
  .bp-scrim { position: fixed; inset: 0; z-index: 10020; background: rgba(0, 0, 0, 0.45); }
  .bp-sheet {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    z-index: 10021; width: min(560px, calc(100vw - 32px)); padding: 16px;
    background: var(--v4-popover); border: 1px solid var(--v4-hairline); border-radius: 8px;
    color: var(--v4-text-1); display: flex; flex-direction: column; gap: 8px;
  }
  header { font-size: 15px; font-weight: 600; }
  .shimmer { height: 36px; border-radius: 6px; background: var(--v4-control-faint, var(--v4-hover)); }
</style>
