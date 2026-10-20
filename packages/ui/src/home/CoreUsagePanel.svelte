<script lang="ts">
  /**
   * "Usage this month" in the Core menu, under the sync row.
   *
   * Company name and plan, this month's usage against the included
   * allowance, one row per plain-language meter group, and the billing
   * buttons. All numbers come from hq-pro (core-usage-model.ts); this file
   * renders and routes clicks. Owner-gated reads: a non-owner sees a quiet
   * note, a failed read says usage is unavailable (never $0).
   */
  import { untrack } from "svelte";
  import type { AdapterResult } from "@hq/platform";
  import RailIcon from "../common/button/RailIcon.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import {
    approvedCheckoutUrl,
    billingPortalHint,
    openBillingPortal,
    type BillingPortalOutcome,
  } from "../account/billing-portal.js";
  import {
    COMPARE_PLANS_URL,
    cachedCoreUsage,
    canReadBilling,
    formatUsd,
    readCoreUsage,
    rememberCoreUsage,
    type CoreUsageView,
  } from "./core-usage-model.js";

  interface BillingSource {
    getBillingSummary?(companyUid: string): Promise<AdapterResult<unknown>>;
    getUsageStatement?(companyUid: string): Promise<AdapterResult<unknown>>;
    createBillingPortalSession(companyUid: string): Promise<AdapterResult<{ url: string }>>;
    createBillingCheckoutSession?(companyUid: string): Promise<AdapterResult<{ url: string }>>;
  }

  interface Props {
    /** The adapter's company slice. */
    source: BillingSource;
    /** Null when the company has no cloud account: nothing is metered. */
    companyUid: string | null;
    companyName: string;
    /** The caller's role in the company, when the roster knows it. */
    role?: string | null;
    /** Open an external link in the system browser. */
    onopenurl?: (url: string) => void;
  }

  let { source, companyUid, companyName, role = null, onopenurl }: Props = $props();

  let view = $state<CoreUsageView>({ kind: "loading", companyName: "" });
  let pending = $state(false);
  let outcome = $state<BillingPortalOutcome | null>(null);
  /** Bumped to re-read after the person returns from Stripe. */
  let refreshNonce = $state(0);

  $effect(() => {
    void refreshNonce;
    const uid = companyUid;
    const name = companyName;
    const api = source;
    outcome = null;
    if (!uid) {
      view = { kind: "no-usage", companyName: name };
      return;
    }
    // The reads are owner-gated: a known non-owner gets the note at once
    // instead of a loading line and a 403.
    if (!canReadBilling(role)) {
      view = { kind: "owner-only", companyName: name };
      return;
    }
    const shown = untrack(() => view);
    view = cachedCoreUsage(uid) ?? (shown.kind === "ready" && shown.companyName === name ? shown : { kind: "loading", companyName: name });
    let cancelled = false;
    void readCoreUsage(api as never, uid, name).then((next) => {
      if (cancelled) return;
      // Keep the last good numbers on screen when a refresh fails.
      if (next.kind === "unavailable" && view.kind === "ready") return;
      view = next;
      rememberCoreUsage(uid, next);
    });
    return () => {
      cancelled = true;
    };
  });

  const paid = $derived(view.kind === "ready" && view.paid);
  const billingLabel = $derived(paid ? "Manage billing" : "Set up billing");
  const hint = $derived(billingPortalHint(outcome, companyName));
  const canBill = $derived(
    Boolean(onopenurl) && (paid || typeof source.createBillingCheckoutSession === "function"),
  );

  /**
   * Stripe's success page returns to the browser, not here. When the window
   * gets focus back after a billing page opened, read the billing state again
   * so a card just added flips the button to Manage billing.
   */
  function refreshOnReturn(): void {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      refreshNonce += 1;
    };
    window.addEventListener("focus", onFocus);
  }

  async function openBilling(): Promise<void> {
    const uid = companyUid;
    if (pending || !onopenurl || !uid) return;
    pending = true;
    outcome = null;
    try {
      outcome = paid
        ? await openBillingPortal({
            companyUid: uid,
            createSession: (id) => source.createBillingPortalSession(id),
            openExternal: onopenurl,
          })
        : await openBillingPortal({
            companyUid: uid,
            createSession: (id) => source.createBillingCheckoutSession!(id),
            openExternal: onopenurl,
            approveUrl: approvedCheckoutUrl,
          });
      if (outcome.kind === "opened") refreshOnReturn();
    } finally {
      pending = false;
    }
  }
</script>

<section
  class="core-usage"
  data-testid="core-usage"
  data-state={view.kind}
  aria-label="Usage this month"
>
  <div class="core-usage-head">
    <span class="core-usage-company" data-testid="core-usage-company"><CompanyLabel name={companyName} {companyUid} /></span>
    {#if view.kind === "ready" && view.planLabel}
      <span class="core-usage-plan" data-testid="core-usage-plan">{view.planLabel}</span>
    {/if}
  </div>

  {#if view.kind === "no-usage"}
    <p class="core-usage-note" data-testid="core-usage-none">No usage for this company. It isn't connected to HQ cloud.</p>
  {:else if view.kind === "loading"}
    <p class="core-usage-note" role="status" data-testid="core-usage-loading">Loading usage…</p>
  {:else if view.kind === "owner-only"}
    <p class="core-usage-note" data-testid="core-usage-owner-only">Only a company owner can see usage and billing.</p>
  {:else if view.kind === "unavailable"}
    <p class="core-usage-note" data-testid="core-usage-unavailable">Usage isn't available right now. Try again later.</p>
  {:else if view.usageUnavailable}
    <p class="core-usage-note" data-testid="core-usage-unavailable">This month's usage isn't available yet.</p>
  {:else if view.usage}
    {@const usage = view.usage}
    <span class="core-usage-label">Usage this month</span>
    <div
      class="core-usage-track"
      role="meter"
      aria-label="Included usage used"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(usage.fill * 100)}
      data-testid="core-usage-bar"
    >
      <span class="core-usage-fill" class:over={usage.over} style={`--fill: ${usage.fill};`}></span>
    </div>
    <div class="core-usage-totals">
      <span data-testid="core-usage-used" data-partial={usage.partial ? "true" : undefined}>{usage.usedLine}</span>
      {#if usage.resetLine}
        <span data-testid="core-usage-reset">{usage.resetLine}</span>
      {/if}
    </div>
    {#if usage.rows.length > 0}
      <ul class="core-usage-rows" data-testid="core-usage-rows">
        {#each usage.rows as row (row.id)}
          <li class="core-usage-row" data-testid="core-usage-row" data-group={row.id}>
            <span class="core-usage-row-label">{row.label}</span>
            {#if row.amount.kind === "amount"}
              <span
                class="core-usage-row-amount"
                data-state={row.amount.partial ? "partial" : "measured"}
                title={row.amount.partial ? "Some of this usage is not reported yet" : undefined}
              >{formatUsd(row.amount.cents)}</span>
            {:else}
              <span class="core-usage-row-amount muted" data-state="not-reported">Not reported</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if usage.partial}
      <p class="core-usage-note small" data-testid="core-usage-partial">Some usage isn't reported yet, so this total can still go up.</p>
    {/if}
  {/if}

  {#if view.kind === "ready"}
    <div class="core-usage-actions">
      <button
        type="button"
        class="core-usage-btn primary"
        data-testid="core-usage-billing"
        disabled={pending || !canBill}
        aria-busy={pending}
        onclick={() => void openBilling()}
      ><RailIcon name="credit-card" />{pending ? "Opening Stripe…" : billingLabel}</button>
      <button
        type="button"
        class="core-usage-btn secondary"
        data-testid="core-usage-compare"
        disabled={!onopenurl}
        onclick={() => onopenurl?.(COMPARE_PLANS_URL)}
      ><RailIcon name="arrow-right" />Compare plans</button>
    </div>
    {#if hint}
      <p class="core-usage-note" role="status" data-testid="core-usage-billing-hint">{hint}</p>
    {/if}
  {/if}
</section>

<style>
  .core-usage {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    margin-bottom: 6px;
    border-radius: 10px;
    background: var(--v4-raised, var(--raised));
  }

  .core-usage-head,
  .core-usage-totals,
  .core-usage-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .core-usage-company {
    overflow: hidden;
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .core-usage-plan,
  .core-usage-totals,
  .core-usage-row-label,
  .core-usage-note {
    color: var(--t2);
    font-size: 13px;
  }

  .core-usage-plan {
    flex: none;
  }

  .core-usage-note {
    margin: 0;
    line-height: 1.35;
  }

  .core-usage-note.small {
    color: var(--t3);
    font-size: 12px;
  }

  .core-usage-label {
    margin-top: 4px;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .core-usage-track {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--v4-control-faint, var(--line2));
  }

  /* Fill ratio via --fill (0..1) + scaleX so the transition runs on the
     compositor (the ProjectRow pattern); the track clips and rounds it. */
  .core-usage-fill {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 999px;
    background: var(--warn);
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
    transition: transform 300ms ease;
  }

  /* Past the included usage the bar turns to the error tone. */
  .core-usage-fill.over {
    background: var(--v4-error, var(--red));
  }

  @media (prefers-reduced-motion: reduce) {
    .core-usage-fill {
      transition: none;
    }
  }

  .core-usage-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }

  .core-usage-row-amount {
    flex: none;
    color: var(--t1);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .core-usage-row-amount.muted {
    color: var(--t3);
  }

  .core-usage-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--v4-hairline, var(--line));
  }

  .core-usage-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 5px 12px;
    border: 1px solid transparent;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .core-usage-btn.primary {
    background: var(--t1);
    color: var(--panel-bg, var(--v4-popover));
  }

  .core-usage-btn.primary:hover:not(:disabled) {
    opacity: 0.88;
  }

  .core-usage-btn.secondary {
    border-color: var(--line2);
    background: transparent;
    color: var(--t2);
  }

  .core-usage-btn.secondary:hover:not(:disabled) {
    background: var(--v4-hover, var(--hover));
    color: var(--t1);
  }

  .core-usage-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }
</style>
