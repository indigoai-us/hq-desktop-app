<script lang="ts">
  import Dropdown from "../../common/LazyDropdown.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  /**
   * Company-level custom domain options for owners and admins (US-007): one
   * deployment on the company's own domain, priced per deployment, or the
   * company's own base domain on every deployment. The desktop has no
   * base-domain flow yet, so that option says so and names its price.
   * Prices come from `GET /v1/pricing` `usage.domains`.
   */
  import { DOMAIN_PRICE_FALLBACK, formatUsd, type DomainPrices } from "./custom-domain.js";

  interface Props {
    deployments: { id: string; name: string; url: string }[];
    loadPrices?: (() => Promise<DomainPrices | null>) | null;
    onpick: (id: string) => void;
    onclose: () => void;
  }

  let { deployments, loadPrices = null, onpick, onclose }: Props = $props();

  let prices = $state<DomainPrices>(DOMAIN_PRICE_FALLBACK);
  let picked = $state("");
  const choice = $derived(picked || deployments[0]?.id || "");

  $effect(() => {
    const load = loadPrices;
    if (!load) return;
    let live = true;
    void load()
      .then((next) => {
        if (live && next) prices = next;
      })
      .catch((err: unknown) => console.warn("[custom-domain] pricing read failed", err));
    return () => {
      live = false;
    };
  });
</script>

<div class="sb" data-testid="custom-domain-options">
  <section class="opt" data-testid="custom-domain-option-standard">
    <div class="head"><span class="name">One deployment on your domain</span><span class="price">{formatUsd(prices.standardUsd)}/month each</span></div>
    <p class="why">Serve a single deployment at a domain you own, such as app.example.com.</p>
    {#if deployments.length > 0}
      <div class="pick">
        <div class="dd"><Dropdown block testid="custom-domain-deployment" label="Deployment" value={choice} onchange={(v) => (picked = v)} options={deployments.map((d) => ({ value: d.id, label: d.name }))} /></div>
        <RailButton icon="arrow-right" variant="primary" data-testid="custom-domain-continue" disabled={!choice} onclick={() => choice && onpick(choice)}>Continue</RailButton>
      </div>
    {:else}
      <p class="why">Deploy something first, then add a domain to it.</p>
    {/if}
  </section>
  <section class="opt" data-testid="custom-domain-option-premium">
    <div class="head"><span class="name">Every deployment on your domain</span><span class="price">{formatUsd(prices.premiumUsd)}/month</span></div>
    <p class="why">Your company's own base domain for all deployments, such as anything.apps.example.com, without HQ branding.</p>
    <p class="soon" data-testid="custom-domain-premium-soon">Coming soon to the desktop app. Ask HQ support to set it up for you today.</p>
  </section>
</div>
<footer class="sf">
  <span class="grow"></span>
  <RailButton icon="x" onclick={onclose}>Close</RailButton>
</footer>

<style>
  /* Deploy access sheet metrics (DeployAccessForm.svelte); 13px only. */
  .sb { overflow: auto; }
  .opt { display: flex; flex-direction: column; gap: 6px; padding: 12px 20px; border-bottom: 1px solid var(--panel-border, var(--v4-rowline)); }
  .head { display: flex; align-items: baseline; gap: 10px; }
  .name { font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .price { margin-left: auto; color: var(--t2, var(--v4-text-2)); }
  .why, .soon { margin: 0; color: var(--t3, var(--v4-text-3)); }
  .soon { color: var(--t2, var(--v4-text-2)); }
  .pick { display: flex; align-items: center; gap: 8px; }
  .dd { flex: 1; min-width: 0; }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--panel-border, var(--v4-hairline)); }
  .grow { flex: 1; }
</style>
