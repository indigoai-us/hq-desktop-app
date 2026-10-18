<script lang="ts">
  /**
   * Company logo + repo or org, on every item, so sources are easy to tell
   * apart. `product` mode (decision rows) shows a clear 20 px company logo
   * and the product name ("Desktop app"); the name is never cut, and the row
   * hides it (keeping the logo) when it is too narrow.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { useBrief } from "./brief-context.svelte.js";
  import { productName, repoShort } from "./brief-origin.js";
  import type { BriefOrigin } from "./brief-types.js";

  let { origin, product = false }: { origin: BriefOrigin; product?: boolean } = $props();
  const brief = useBrief();
  const company = $derived(brief.company(origin.companyUid));
  const repo = $derived(repoShort(origin.repo));
  const label = $derived(product ? productName(origin.repo, origin.product) : repo);
</script>

{#if company || label}
  <span class="org" class:product data-testid="brief-origin">
    {#if company || (product && origin.companyUid)}
      <span class="lgo" class:big={product}><BriefLogo {company} fallback={origin.companyUid} size={product ? 20 : 16} /></span>
    {/if}
    {#if label}<b data-testid="brief-origin-label">{label}</b>{/if}
  </span>
{/if}

<style>
  .org.product .lgo {
    width: 20px;
    height: 20px;
    background: none;
    box-shadow: none;
  }
  .org.product b {
    max-width: none;
    overflow: visible;
    font-family: var(--b-ui, system-ui);
    font-size: 11px;
    letter-spacing: 0;
  }
</style>
