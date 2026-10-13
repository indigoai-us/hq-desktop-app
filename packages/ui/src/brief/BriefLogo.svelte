<script lang="ts">
  /**
   * A company's logo for brief chips: its icon (iconUrl, or the shared icon
   * registry by uid, slug or name), else a two-letter monogram on a colored
   * tile. Never smaller than the size asked for.
   */
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import type { BriefCompanyLogo } from "./brief-context.svelte.js";
  import { companyDisplayName, monogram, monogramHue } from "./brief-origin.js";

  let { company, fallback = null, size = 20 }: { company: BriefCompanyLogo | null; fallback?: string | null; size?: number } = $props();
  const name = $derived(company?.label ?? fallback ?? "");
</script>

<span class="blogo" style:--s="{size}px" style:--h={monogramHue(name)} data-testid="brief-logo">
  {#if company}
    <CompanyLabel name={company.label} iconUrl={company.iconUrl} companyUid={company.uid} {size} iconOnly />
  {:else}
    <span class="mono" role="img" aria-label={companyDisplayName(name)} data-testid="brief-logo-monogram">{monogram(name)}</span>
  {/if}
</span>

<style>
  .blogo {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--s);
    height: var(--s);
    border-radius: 6px;
    overflow: hidden;
  }
  .mono,
  .blogo :global(.company-label-initials) {
    display: grid;
    place-items: center;
    width: var(--s);
    height: var(--s);
    border-radius: 6px;
    font-family: var(--b-ui, system-ui);
    font-size: calc(var(--s) * 0.45);
    font-weight: 500;
    letter-spacing: 0;
    color: #fff;
    background: linear-gradient(145deg, hsl(var(--h) 60% 56%), hsl(var(--h) 55% 36%));
    box-shadow: none;
  }
</style>
