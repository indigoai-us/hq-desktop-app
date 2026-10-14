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
    border-radius: 50%;
    overflow: hidden;
  }
  .mono,
  .blogo :global(.company-label-initials) {
    display: grid;
    place-items: center;
    width: var(--s);
    height: var(--s);
    box-sizing: border-box;
    border-radius: 50%;
    font-family: var(--b-ui, system-ui);
    font-size: calc(var(--s) * 0.42);
    font-weight: 500;
    letter-spacing: 0.02em;
    /* A quiet glass circle in the surrounding ink (white on a coloured card, dark on a hover card), not a loud swatch. */
    color: inherit;
    opacity: 0.9;
    background: color-mix(in srgb, currentColor 16%, transparent);
    box-shadow: none;
  }
</style>
