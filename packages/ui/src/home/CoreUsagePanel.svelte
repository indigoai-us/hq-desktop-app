<script lang="ts">
  /**
   * "Usage this month" in the Core menu, under the sync row (US-018).
   *
   * Company name and plan ("Usage plan" or "Trial, N days left"), this
   * month's usage against the included allowance (or trial usage against the
   * trial cap), one row per meter group, and the actions: Set up billing,
   * Usage details (Settings > Usage) and Turn off sync (Settings > Sync). All
   * numbers come from hq-pro (core-usage-model.ts); this file renders and
   * routes clicks. A failed read retries quietly, then offers Try again; it
   * never shows $0 or server text.
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
    TRIAL_MINIMUM_NOTE,
    USAGE_REFRESH_MS,
    billingRole,
    cachedCoreUsage,
    canReadBilling,
    canSetUpBilling,
    formatUsd,
    readCoreUsageWithRetry,
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
    /** Open Settings > Usage. */
    onopenusage?: () => void;
    /** Open the Sync section of Settings (repointed to US-016's per-vault section when it lands). */
    onopensync?: () => void;
    /** Test seam: waits between automatic retries. */
    retryDelays?: readonly number[];
    /** Test seam: the refresh interval while the menu is open. */
    refreshMs?: number;
  }

  let {
    source,
    companyUid,
    companyName,
    role = null,
    onopenurl,
    onopenusage,
    onopensync,
    retryDelays,
    refreshMs = USAGE_REFRESH_MS,
  }: Props = $props();

  let view = $state<CoreUsageView>({ kind: "loading", companyName: "" });
  let pending = $state(false);
  let retrying = $state(false);
  let outcome = $state<BillingPortalOutcome | null>(null);
  /** Bumped to re-read: after Stripe, on Try again, and on the refresh timer. */
  let refreshNonce = $state(0);

  const roleKind = $derived(billingRole(role));

  $effect(() => {
    void refreshNonce;
    const uid = companyUid;
    const name = companyName;
    const api = source;
    const delays = retryDelays;
    untrack(() => {
      outcome = null;
    });
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
    void readCoreUsageWithRetry(api as never, uid, name, {
      ...(delays ? { delays } : {}),
      cancelled: () => cancelled,
    }).then((next) => {
      if (cancelled) return;
      retrying = false;
      // Keep the last good numbers on screen when a refresh fails.
      if (next.kind === "unavailable" && view.kind === "ready") return;
      view = next;
      rememberCoreUsage(uid, next);
    });
    return () => {
      cancelled = true;
    };
  });

  // Opening the menu mounts this panel, which reads once; while it stays
  // open it re-reads at most every few minutes.
  $effect(() => {
    if (!companyUid || refreshMs <= 0) return;
    const timer = setInterval(() => {
      refreshNonce += 1;
    }, refreshMs);
    return () => clearInterval(timer);
  });

  const paid = $derived(view.kind === "ready" && view.paid);
  const notice = $derived(view.kind === "ready" ? view.notice : null);
  const billingLabel = $derived(paid ? "Manage billing" : (notice?.actionLabel ?? "Set up billing"));
  const hint = $derived(billingPortalHint(outcome, companyName));
  const mayBill = $derived(canSetUpBilling(role));
  const canBill = $derived(
    Boolean(onopenurl) && (paid || typeof source.createBillingCheckoutSession === "function"),
  );
  const showBilling = $derived(
    mayBill && (view.kind === "ready" || (view.kind === "owner-only" && roleKind === "admin")),
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

  function retry(): void {
    if (retrying) return;
    retrying = true;
    refreshNonce += 1;
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

  {#if notice}
    <p
      class="core-usage-notice"
      role="status"
      data-testid="core-usage-notice"
      data-kind={notice.kind}
    >{mayBill ? notice.text : notice.memberText}</p>
  {/if}

  {#if view.kind === "no-usage"}
    <p class="core-usage-note" data-testid="core-usage-none">No usage for this company. It isn't connected to HQ cloud.</p>
  {:else if view.kind === "loading"}
    <p class="core-usage-note" role="status" data-testid="core-usage-loading">Loading usage…</p>
  {:else if view.kind === "owner-only"}
    {#if roleKind === "admin"}
      <p class="core-usage-note" data-testid="core-usage-owner-only">Only a company owner can see usage. If Set up billing doesn't open for you, ask an owner.</p>
    {:else if roleKind === "member"}
      <p class="core-usage-note" data-testid="core-usage-owner-only">Ask an owner or admin of {companyName} to set up billing. Only owners can see usage.</p>
    {:else}
      <p class="core-usage-note" data-testid="core-usage-owner-only">Only a company owner can see usage and billing. Ask an owner or admin of {companyName}.</p>
    {/if}
  {:else if view.kind === "unavailable"}
    <p class="core-usage-note" data-testid="core-usage-unavailable">Usage isn't available right now.</p>
    <button
      type="button"
      class="core-usage-link"
      data-testid="core-usage-retry"
      disabled={retrying}
      aria-busy={retrying}
      onclick={retry}
    >{retrying ? "Checking…" : "Try again"}</button>
  {:else if view.usageUnavailable}
    <p class="core-usage-note" data-testid="core-usage-unavailable">This month's usage isn't available yet.</p>
  {:else if view.usage}
    {@const usage = view.usage}
    <span class="core-usage-label" data-testid="core-usage-label">{usage.mode === "trial" ? "Trial usage" : "Usage this month"}</span>
    <div
      class="core-usage-track"
      role="meter"
      aria-label={usage.mode === "trial" ? "Trial usage used" : "Included usage used"}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(usage.fill * 100)}
      data-testid="core-usage-bar"
      data-tone={usage.tone}
      data-mode={usage.mode}
    >
      <span class="core-usage-fill" data-tone={usage.tone} style={`--fill: ${usage.fill};`}></span>
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
    {:else if usage.rowsNote}
      <p class="core-usage-note small" data-testid="core-usage-rows-note">{usage.rowsNote}</p>
    {/if}
    {#if usage.partial && usage.mode === "allowance"}
      <p class="core-usage-note small" data-testid="core-usage-partial">Some usage isn't reported yet, so this total can still go up.</p>
    {:else if usage.partial && usage.mode === "trial" && usage.usedLine.startsWith("At least")}
      <p class="core-usage-note small" data-testid="core-usage-partial">{TRIAL_MINIMUM_NOTE}</p>
    {/if}
  {/if}

  {#if showBilling || view.kind === "ready"}
    <div class="core-usage-actions">
      {#if showBilling}
        <button
          type="button"
          class="core-usage-btn primary"
          data-testid="core-usage-billing"
          disabled={pending || !canBill}
          aria-busy={pending}
          onclick={() => void openBilling()}
        ><RailIcon name="credit-card" />{pending ? "Opening Stripe…" : billingLabel}</button>
      {/if}
      {#if view.kind === "ready"}
        <button
          type="button"
          class="core-usage-btn secondary"
          data-testid="core-usage-details"
          disabled={!onopenusage}
          onclick={() => onopenusage?.()}
        ><RailIcon name="arrow-right" />Usage details</button>
      {/if}
    </div>
    {#if hint}
      <p class="core-usage-note" role="status" data-testid="core-usage-billing-hint">{hint}</p>
    {/if}
  {/if}

  {#if view.kind !== "no-usage" && onopensync}
    <button
      type="button"
      class="core-usage-link"
      data-testid="core-usage-sync-off"
      onclick={() => onopensync?.()}
    >Turn off sync</button>
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

  .core-usage-notice {
    margin: 0;
    color: var(--t1);
    font-size: 13px;
    line-height: 1.35;
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

  /* Under 80% of the limit the bar is neutral, amber from 80%, red at it. */
  .core-usage-fill[data-tone="ok"] {
    background: var(--t2);
  }

  .core-usage-fill[data-tone="at"] {
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

  .core-usage-link {
    appearance: none;
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t3);
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .core-usage-link:hover:not(:disabled) {
    color: var(--t1);
  }

  .core-usage-link:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .core-usage-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }
</style>
