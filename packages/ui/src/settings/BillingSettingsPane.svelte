<script lang="ts">
  /**
   * OWNER-R21: Billing inside the one Settings list. Payment method and
   * invoices live in Stripe; Manage payment asks hq-pro to mint a Stripe
   * customer-portal session for the chosen company and opens it in the system
   * browser. The portal URL always comes from the API, never a constant (the
   * old hard-coded portal link 404'd for every user). Invoices are read inside
   * that portal; the desktop shows no invoice rows of its own.
   */
  import type { CompanyApi } from "@hq/platform";
  import RailButton from "../common/button/RailButton.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import {
    billingPortalHint,
    openBillingPortal,
    type BillingPortalOutcome,
  } from "../account/billing-portal.js";

  interface BillingCompany {
    uid: string;
    label: string;
    role: string | null;
  }

  let {
    openExternal,
    company = null,
    companies = [],
    selectedCompanyUid = null,
  }: {
    openExternal?: (url: string) => void;
    company?: Pick<CompanyApi, "createBillingPortalSession"> | null;
    /** The caller's companies with their real role (null when unknown). */
    companies?: ReadonlyArray<BillingCompany>;
    /** The company selected in the shell, preferred when present. */
    selectedCompanyUid?: string | null;
  } = $props();

  const isOwner = (row: BillingCompany): boolean => (row.role ?? "").toLowerCase() === "owner";

  let chosenUid = $state<string | null>(null);
  let pending = $state(false);
  let outcome = $state<BillingPortalOutcome | null>(null);

  const defaultUid = $derived(
    companies.find((row) => row.uid === selectedCompanyUid)?.uid ??
      companies.find(isOwner)?.uid ??
      companies[0]?.uid ??
      null,
  );
  const target = $derived(
    companies.find((row) => row.uid === (chosenUid ?? defaultUid)) ?? null,
  );
  // A known non-owner role stops at an owner handoff instead of calling the
  // owner-gated route. An unknown role may try; hq-pro decides.
  const knownNonOwner = $derived(target !== null && target.role !== null && !isOwner(target));
  const hint = $derived(
    target && knownNonOwner
      ? billingPortalHint({ kind: "owner-only" }, target.label)
      : target
        ? billingPortalHint(outcome, target.label)
        : null,
  );

  function choose(uid: string): void {
    if (pending) return;
    chosenUid = uid;
    outcome = null;
  }

  async function managePayment(): Promise<void> {
    if (pending || !target || knownNonOwner || !company || !openExternal) return;
    pending = true;
    outcome = null;
    try {
      outcome = await openBillingPortal({
        companyUid: target.uid,
        createSession: (uid) => company.createBillingPortalSession(uid),
        openExternal,
      });
    } finally {
      pending = false;
    }
  }
</script>

<div class="proto-stack" data-testid="settings-billing-pane">
  <div class="set-row">
    <div>
      <div class="sn">Payment and invoices</div>
      <div class="sd">
        {#if target}
          The card, receipts and invoices for {target.label} are kept in Stripe.
        {:else}
          Payment is managed per company. Join or create a company to manage billing.
        {/if}
      </div>
      {#if hint}
        <div class="sd hint" data-testid="manage-payment-hint" role="status">{hint}</div>
      {/if}
    </div>
    {#if target && !knownNonOwner}
      <RailButton
        icon="external"
        type="button"
        data-testid="manage-payment"
        disabled={pending || !company || !openExternal}
        aria-busy={pending}
        onclick={() => void managePayment()}
      >{pending ? "Opening Stripe…" : outcome && outcome.kind !== "opened" ? "Try again" : "Manage payment"}</RailButton>
    {/if}
  </div>
  {#if companies.length > 1}
    <div class="set-row">
      <div>
        <div class="sn">Company</div>
        <div class="sd">Manage payment opens Stripe for this company.</div>
      </div>
      <div class="picker" role="radiogroup" aria-label="Company to manage">
        {#each companies as row (row.uid)}
          <button
            type="button"
            class="chip"
            class:on={target?.uid === row.uid}
            role="radio"
            aria-checked={target?.uid === row.uid}
            data-testid="billing-company"
            disabled={pending}
            onclick={() => choose(row.uid)}
          ><CompanyLabel name={row.label} companyUid={row.uid} size={14} /></button>
        {/each}
      </div>
    </div>
  {/if}
  <div class="set-row">
    <div>
      <div class="sn">Company plans</div>
      <div class="sd">Each company's plan and seats are under that company's Billing in the company panel.</div>
    </div>
  </div>
</div>

<style>
  /* Same row shape as the other Settings panes (ShellSettings' scoped
     .set-row does not reach into this component). */
  .set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding: 14px 16px;
  }

  .set-row > div:first-child {
    flex: 1;
    min-width: 0;
  }

  .sn {
    font-weight: 500;
    font-size: 13px;
    color: var(--t1);
  }

  .sd {
    margin-top: 2px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.45;
  }

  .hint {
    color: var(--t3, var(--t2));
  }

  .picker {
    margin-left: auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  .chip {
    padding: 5px 10px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: none;
    color: var(--t2);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .chip.on {
    color: var(--t1);
    border-color: var(--t2);
  }
</style>
