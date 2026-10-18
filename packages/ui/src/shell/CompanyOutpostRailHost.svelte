<script lang="ts">
  /**
   * Company rail mount for Company Outpost.
   * The price, when the catalog has one, comes from the same pricing read
   * the rest of the app uses. A missing price hides the hint.
   */
  import type { AdapterResult, Json } from "@hq/platform";
  import ReadLoader from "../common/ReadLoader.svelte";
  import CompanyOutpostPage from "../company-outpost/CompanyOutpostPage.svelte";
  import { createCompanyOutpostClient, type CompanyOutpostApi } from "../company-outpost/company-outpost-client.js";
  import { canManageRole, formatOutpostPrice, type CompanyOutpostRole } from "../company-outpost/company-outpost-model.js";

  interface Props {
    companyUid: string;
    companyLabel?: string;
    role: CompanyOutpostRole;
    api?: CompanyOutpostApi | null;
    readPricing?: (() => Promise<AdapterResult<Json>>) | null;
    onOpenBilling?: () => void;
  }

  let { companyUid, companyLabel = "", role, api = null, readPricing = null, onOpenBilling }: Props = $props();

  let priceHint = $state<string | null>(null);
  let priced = $state(false);
  let attempt = $state(0);

  function monthlyFromPricing(value: unknown): number | null {
    if (!value || typeof value !== "object") return null;
    const addOns = (value as { addOns?: { outpost?: { monthlyUsd?: unknown } } }).addOns;
    const monthly = addOns?.outpost?.monthlyUsd;
    return typeof monthly === "number" && Number.isFinite(monthly) ? monthly : null;
  }

  // Pricing is optional. A hang shows the shared loader. A failure or a throw
  // still opens the list, with no price hint.
  $effect(() => {
    const read = readPricing;
    const label = companyLabel || "the company";
    const nonce = attempt;
    let live = true;
    void (async () => {
      let nextHint: string | null = null;
      try {
        if (read) {
          const result = await read();
          if (!live) return;
          if (result.ok) {
            const monthly = monthlyFromPricing(result.value);
            if (monthly != null) nextHint = formatOutpostPrice(monthly, label);
          }
        }
      } catch {
        nextHint = null;
      }
      if (!live || nonce !== attempt) return;
      priceHint = nextHint;
      priced = true;
    })();
    return () => {
      live = false;
    };
  });

  const client = $derived(
    createCompanyOutpostClient({
      companyUid,
      canManage: canManageRole(role),
      api,
      priceHint,
    }),
  );
</script>

<div class="host" data-testid="company-outpost-host">
  {#if priced}
    <CompanyOutpostPage {companyUid} {role} {client} {onOpenBilling} />
  {:else}
    <ReadLoader testid="company-outpost-pricing-loading" onretry={() => (attempt += 1)} />
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
</style>
