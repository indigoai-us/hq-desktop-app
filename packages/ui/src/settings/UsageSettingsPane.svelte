<script lang="ts">
  /**
   * Settings > Usage (usage-only-pricing US-018). One line per account,
   * Personal first, then every company the caller owns or administers (owner
   * direction, Corey, 2026-10-19). Each line shows the plan and this month's
   * total, and opens (one at a time) to the detail: the three groups with
   * their meters, the included usage, the trial cap or spend limit, the card
   * on file and the actions for that account. Every number is hq-pro's
   * (usage-accounts-model.ts).
   *
   * Lives in its own file so the Sync section work (US-016) and this screen
   * do not touch the same component.
   */
  import { untrack } from "svelte";
  import type { AdapterResult } from "@hq/platform";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import Caret from "../common/Caret.svelte";
  import {
    approvedCheckoutUrl,
    billingPortalHint,
    openBillingPortal,
    type BillingPortalOutcome,
  } from "../account/billing-portal.js";
  import {
    PERSONAL_ACCOUNT_KEY,
    PERSONAL_ACCOUNT_LABEL,
    formatUsd,
    preferredUsageAccount,
    type UsageAccount,
  } from "../home/core-usage-model.js";
  import type { UsagePricing } from "../company/usage-pricing.js";
  import {
    SWITCH_NOT_AVAILABLE_TEXT,
    accountKey,
    orderedAccounts,
    readAccountRow,
    readPricing,
    readSpendLimit,
    readSwitchState,
    rowTotalText,
    switchAccountToUsage,
    switchOutcomeText,
    withPricing,
    type AccountRowReady,
    type AccountRowView,
    type SwitchState,
    type UsageAccountsSource,
  } from "./usage-accounts-model.js";
  import { periodLabel, spendLimitLine, trialEndLabel, type SpendLimitDetail } from "./usage-settings-model.js";

  interface UsageCompanyRow {
    uid: string;
    label: string;
    role: string | null;
  }

  interface PaneSource extends UsageAccountsSource {
    createBillingPortalSession?(companyUid: string): Promise<AdapterResult<{ url: string }>>;
    createBillingCheckoutSession?(companyUid: string): Promise<AdapterResult<{ url: string }>>;
    createPersonalBillingCheckoutSession?(): Promise<AdapterResult<{ url: string }>>;
    createPersonalBillingPortalSession?(): Promise<AdapterResult<{ url: string }>>;
  }

  let {
    company = null,
    companies = [],
    accounts = undefined,
    selectedCompanyUid = null,
    onopenurl = undefined,
    onopensync = undefined,
  }: {
    company?: PaneSource | null;
    /** The caller's companies with their real role (null when unknown). */
    companies?: ReadonlyArray<UsageCompanyRow>;
    /** Owner/admin companies and the personal account. When given, it replaces `companies`. */
    accounts?: readonly UsageAccount[];
    /** The company selected in the shell; its line opens first when nothing else asked. */
    selectedCompanyUid?: string | null;
    /** Open a Stripe page in the system browser. */
    onopenurl?: (url: string) => void;
    /** Open Settings > Sync, where cloud sync is turned off per vault. */
    onopensync?: () => void;
  } = $props();

  const rows = $derived<UsageAccount[]>(
    orderedAccounts(
      accounts ??
        companies.map((row): UsageAccount => ({ kind: "company", uid: row.uid, name: row.label, role: row.role })),
    ),
  );
  const rowKeys = $derived(rows.map((r) => accountKey(r)).join("|"));

  let views = $state<Record<string, AccountRowView>>({});
  let pricing = $state<UsagePricing | null>(null);
  let spend = $state<Record<string, SpendLimitDetail | null | "loading">>({});
  let switchStates = $state<Record<string, SwitchState>>({});
  // Usage details in the Core menu opens this screen on the account it showed.
  let openKey = $state<string | null>(preferredUsageAccount() ?? null);
  let confirmKey = $state<string | null>(null);
  let switchingKey = $state<string | null>(null);
  let switchNote = $state<Record<string, { text: string; ok: boolean }>>({});
  let billingKey = $state<string | null>(null);
  let billingOutcome = $state<Record<string, BillingPortalOutcome | null>>({});
  let headers: HTMLButtonElement[] = $state([]);

  // Read every line once per account list; the price list once.
  $effect(() => {
    void rowKeys;
    const list = rows;
    const api = company;
    let cancelled = false;
    untrack(() => {
      if (openKey === null && selectedCompanyUid && list.some((a) => accountKey(a) === selectedCompanyUid)) {
        openKey = selectedCompanyUid;
      }
      const next: Record<string, AccountRowView> = {};
      for (const acct of list) next[accountKey(acct)] = views[accountKey(acct)] ?? { kind: "loading" };
      views = next;
    });
    void readPricing(api).then((feed) => {
      if (cancelled) return;
      pricing = feed;
      const next: Record<string, AccountRowView> = {};
      for (const [key, view] of Object.entries(views)) next[key] = withPricing(view, feed);
      views = next;
    });
    for (const acct of list) loadRow(acct, () => cancelled);
    return () => {
      cancelled = true;
    };
  });

  function loadRow(acct: UsageAccount, cancelled: () => boolean = () => false): void {
    const key = accountKey(acct);
    void readAccountRow(company, acct, untrack(() => pricing)).then((view) => {
      if (cancelled()) return;
      views = { ...views, [key]: withPricing(view, untrack(() => pricing)) };
      if (untrack(() => openKey) === key) loadDetail(acct, view);
    });
  }

  /** The detail's own reads: the spend limit, or the switch offer for a free account. */
  function loadDetail(acct: UsageAccount, view: AccountRowView | undefined): void {
    if (view?.kind !== "ready") return;
    const key = accountKey(acct);
    if (view.plan === "usage" || view.plan === "trial") {
      if (spend[key] !== undefined && spend[key] !== null) return;
      spend = { ...spend, [key]: "loading" };
      void readSpendLimit(company, acct).then((limit) => {
        spend = { ...spend, [key]: limit };
      });
    } else if (view.plan === "starter") {
      switchStates = { ...switchStates, [key]: { kind: "loading" } };
      void readSwitchState(company, acct).then((state) => {
        switchStates = { ...switchStates, [key]: state };
      });
    }
  }

  function toggle(acct: UsageAccount): void {
    const key = accountKey(acct);
    confirmKey = null;
    if (openKey === key) {
      openKey = null;
      return;
    }
    openKey = key;
    loadDetail(acct, views[key]);
  }

  function onHeaderKey(event: KeyboardEvent, index: number): void {
    const last = headers.length - 1;
    const target =
      event.key === "ArrowDown" ? Math.min(last, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    headers[target]?.focus();
  }

  function retry(acct: UsageAccount): void {
    views = { ...views, [accountKey(acct)]: { kind: "loading" } };
    loadRow(acct);
  }

  function refreshOnReturn(acct: UsageAccount): void {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      const key = accountKey(acct);
      spend = { ...spend, [key]: null };
      loadRow(acct);
    };
    window.addEventListener("focus", onFocus);
  }

  function canOpenBilling(acct: UsageAccount, paid: boolean): boolean {
    if (!onopenurl || !company) return false;
    if (acct.kind === "personal") {
      return typeof (paid ? company.createPersonalBillingPortalSession : company.createPersonalBillingCheckoutSession) === "function";
    }
    return typeof (paid ? company.createBillingPortalSession : company.createBillingCheckoutSession) === "function";
  }

  async function openBilling(acct: UsageAccount, paid: boolean): Promise<void> {
    const key = accountKey(acct);
    if (billingKey || !onopenurl || !company) return;
    const api = company;
    billingKey = key;
    billingOutcome = { ...billingOutcome, [key]: null };
    try {
      const outcome =
        acct.kind === "personal"
          ? await openBillingPortal({
              companyUid: PERSONAL_ACCOUNT_KEY,
              createSession: () => (paid ? api.createPersonalBillingPortalSession!() : api.createPersonalBillingCheckoutSession!()),
              openExternal: onopenurl,
              ...(paid ? {} : { approveUrl: approvedCheckoutUrl }),
            })
          : await openBillingPortal({
              companyUid: acct.uid ?? "",
              createSession: (id) => (paid ? api.createBillingPortalSession!(id) : api.createBillingCheckoutSession!(id)),
              openExternal: onopenurl,
              ...(paid ? {} : { approveUrl: approvedCheckoutUrl }),
            });
      billingOutcome = { ...billingOutcome, [key]: outcome };
      if (outcome.kind === "opened") refreshOnReturn(acct);
    } finally {
      billingKey = null;
    }
  }

  async function confirmSwitch(acct: UsageAccount): Promise<void> {
    const key = accountKey(acct);
    if (switchingKey) return;
    switchingKey = key;
    const { [key]: _dropped, ...rest } = switchNote;
    switchNote = rest;
    try {
      const outcome = await switchAccountToUsage(company, acct);
      switchNote = { ...switchNote, [key]: { text: switchOutcomeText(outcome), ok: outcome.kind === "switched" } };
      if (outcome.kind === "refused") switchStates = { ...switchStates, [key]: outcome.state };
      if (outcome.kind === "not-available") switchStates = { ...switchStates, [key]: { kind: "not-available" } };
      if (outcome.kind === "switched" || outcome.kind === "refused" || outcome.kind === "not-available") confirmKey = null;
      if (outcome.kind === "switched") loadRow(acct);
    } finally {
      switchingKey = null;
    }
  }

  function roleTag(acct: UsageAccount): string {
    if (acct.kind === "personal") return "";
    const role = (acct.role ?? "").toLowerCase();
    return role === "admin" ? "Admin" : "";
  }

  function lineName(acct: UsageAccount): string {
    return acct.kind === "personal" ? acct.name || PERSONAL_ACCOUNT_LABEL : acct.name;
  }

  function includedText(view: AccountRowReady): string {
    const included = view.usage?.allowanceCents ?? (pricing ? Math.round(pricing.includedUsd * 100) : null);
    return included === null ? "usage" : formatUsd(included);
  }
</script>

<div class="proto-stack" data-testid="settings-usage-pane" data-state={rows.length ? "ready" : "no-company"}>
  {#if rows.length === 0}
    <div class="empty" data-testid="usage-none">Usage is tracked per company. Join or create a company to see it.</div>
  {:else}
    <ul class="accounts" aria-label="Usage by account" data-testid="usage-accounts">
      {#each rows as acct, index (accountKey(acct))}
        {@const key = accountKey(acct)}
        {@const view = views[key] ?? { kind: "loading" }}
        {@const open = openKey === key}
        <li class="account" class:open data-testid="usage-account-row" data-key={key}>
          <h3 class="head">
            <button
              bind:this={headers[index]}
              type="button"
              class="line"
              id={`usage-line-${index}`}
              aria-expanded={open}
              aria-controls={`usage-detail-${index}`}
              data-testid="usage-account"
              data-key={key}
              onclick={() => toggle(acct)}
              onkeydown={(event) => onHeaderKey(event, index)}
            >
              <span class="chev" class:open aria-hidden="true"><Caret tone="var(--t3)" /></span>
              <span class="name" data-testid="usage-account-name">{#if acct.kind === "personal"}{lineName(acct)}{:else}<CompanyLabel name={acct.name} companyUid={acct.uid} size={14} />{/if}</span>
              {#if roleTag(acct)}<span class="role">{roleTag(acct)}</span>{/if}
              <span class="plan" data-testid="usage-account-plan" data-plan={view.kind === "ready" ? view.plan : view.kind}>{view.kind === "ready" ? view.planLabel : ""}</span>
              <span class="total" data-testid="usage-account-total">{rowTotalText(view)}</span>
            </button>
          </h3>
          {#if open}
            <div
              class="detail"
              id={`usage-detail-${index}`}
              role="region"
              aria-labelledby={`usage-line-${index}`}
              data-testid="usage-account-detail"
              data-state={view.kind}
            >
              {#if view.kind === "loading"}
                <p class="note" role="status" data-testid="usage-loading">Loading usage…</p>
              {:else if view.kind === "owner-only"}
                <p class="note" data-testid="usage-owner-only">Only a company owner can see usage. Ask an owner of {acct.name}.</p>
              {:else if view.kind === "unavailable"}
                <p class="note" data-testid="usage-unavailable">Usage isn't available right now.</p>
                <div class="actions">
                  <button type="button" class="act" data-testid="usage-retry" onclick={() => retry(acct)}>Try again</button>
                </div>
              {:else}
                {@const paid = view.cardOnFile === true || view.plan === "legacy"}
                {#if view.notice}
                  <p class="notice" role="status" data-testid="usage-notice" data-kind={view.notice.kind}>{view.notice.text}</p>
                {/if}
                <dl class="kv">
                  {#if view.usage}
                    <dt class="muted" data-testid="usage-period">{periodLabel(view.usage.periodStart, view.usage.periodEnd)}</dt>
                    <dd></dd>
                    {#each view.usage.groups as group (group.id)}
                      <dt>{group.label}</dt>
                      <dd class="num" data-testid="usage-group" data-group={group.id}>{group.cents === null ? "Not reported" : `${group.partial ? "At least " : ""}${formatUsd(group.cents)}`}</dd>
                      <dd class="meters">
                        {#each group.meters as meter (meter.key)}
                          <span class="meter" title={meter.rate} data-testid="usage-line" data-key={meter.key}>{meter.label} {meter.waived ? "waived" : meter.costCents === null ? "not reported" : formatUsd(meter.costCents)}</span>
                        {/each}
                      </dd>
                    {/each}
                    {#if view.trial}
                      <dd class="meters wide">Trial days are free, so costs by meter count only days after the trial.</dd>
                    {/if}
                    <dt>Usage so far</dt>
                    <dd class="num strong" data-testid="usage-total">{formatUsd(view.usage.usageCents)}</dd>
                    <dt title="Usage included every month before anything is billed.">Included</dt>
                    <dd class="num" data-testid="usage-allowance-left">{formatUsd(view.usage.allowanceLeftCents)} of free usage left</dd>
                  {:else if view.usageUnavailable}
                    <dt>This month</dt>
                    <dd class="num muted" data-testid="usage-unavailable">Not available right now</dd>
                  {:else}
                    <dt>Plan</dt>
                    <dd class="num" data-testid="usage-old-plan">{view.planLabel}</dd>
                  {/if}
                  {#if view.trial}
                    <dt title={trialEndLabel(view.trial.endsAt)}>Trial</dt>
                    <dd class="num" data-testid="usage-trial-usage">
                      {#if view.trial.usedCents !== null && view.trial.capCents !== null}
                        {view.trial.unknownMeters?.length ? "At least " : ""}{formatUsd(view.trial.usedCents)} of {formatUsd(view.trial.capCents)}
                        <span class="bar" aria-hidden="true"><span style={`width:${Math.min(100, Math.round((view.trial.usedCents / Math.max(1, view.trial.capCents)) * 100))}%`}></span></span>
                      {:else}
                        Not measured yet
                      {/if}
                    </dd>
                  {/if}
                  {#if view.plan === "usage" || view.plan === "trial"}
                    {@const limit = spend[key]}
                    <dt title="Metered work pauses when the month's bill reaches the limit.">Spend limit</dt>
                    <dd class="num" data-testid="usage-spend-limit">{limit === "loading" || limit === undefined ? "…" : limit === null ? "Can't be shown" : spendLimitLine(limit)}</dd>
                    {#if view.usage}
                      <dt title="What this month would cost at the current pace, after the included usage.">Projected bill</dt>
                      <dd class="num" data-testid="usage-projected">{view.usage.projectedBillCents === null ? "Not available yet" : formatUsd(view.usage.projectedBillCents)}</dd>
                    {/if}
                  {/if}
                  <dt>Card on file</dt>
                  <dd class="num" data-testid="usage-card">{view.cardOnFile === null ? "Unknown" : view.cardOnFile ? "Yes" : "No"}</dd>
                </dl>

                {#if view.plan === "starter"}
                  {@const state = switchStates[key] ?? { kind: "loading" }}
                  <div class="switch" data-testid="usage-switch" data-state={state.kind}>
                    {#if confirmKey === key}
                      <div class="confirm" role="group" aria-label="Confirm switch" data-testid="usage-switch-confirm">
                        <p>Switch {lineName(acct)} to usage pricing? {includedText(view)} of usage is included each month, then each meter is billed at its rate. There's no free trial: usage past the included amount is charged to the card on file. You can't switch back here.</p>
                        <div class="actions">
                          <button
                            type="button"
                            class="act primary"
                            data-testid="usage-switch-now"
                            disabled={switchingKey === key}
                            aria-busy={switchingKey === key}
                            onclick={() => void confirmSwitch(acct)}
                          >{switchingKey === key ? "Switching…" : "Switch now"}</button>
                          <button type="button" class="act" data-testid="usage-switch-cancel" disabled={switchingKey === key} onclick={() => (confirmKey = null)}>Cancel</button>
                        </div>
                      </div>
                    {:else if state.kind === "loading"}
                      <p class="note" role="status">Checking whether this account can switch…</p>
                    {:else if state.kind === "offered"}
                      <div class="actions">
                        <button type="button" class="act primary" data-testid="usage-switch-start" onclick={() => (confirmKey = key)}>Switch to usage pricing</button>
                      </div>
                    {:else if state.kind === "card-required"}
                      <p class="note" data-testid="usage-switch-note">A card is needed to switch. There's no free trial when you switch.</p>
                    {:else if state.kind === "refused"}
                      <p class="note" data-testid="usage-switch-note">{state.text}</p>
                    {:else if state.kind === "switched"}
                      <p class="note" data-testid="usage-switch-note">This account is already on usage pricing.</p>
                    {:else}
                      <div class="actions">
                        <button type="button" class="act" data-testid="usage-switch-start" disabled>Switch to usage pricing</button>
                      </div>
                      <p class="note" data-testid="usage-switch-note">{SWITCH_NOT_AVAILABLE_TEXT}</p>
                    {/if}
                  </div>
                {/if}
                {#if switchNote[key]}
                  <p class="note" class:ok={switchNote[key].ok} role="status" data-testid="usage-switch-result">{switchNote[key].text}</p>
                {/if}

                <div class="actions">
                  {#if canOpenBilling(acct, paid)}
                    <button
                      type="button"
                      class="act"
                      data-testid="usage-billing"
                      disabled={billingKey === key}
                      aria-busy={billingKey === key}
                      onclick={() => void openBilling(acct, paid)}
                    >{billingKey === key ? "Opening…" : paid ? "Manage billing" : (view.notice?.actionLabel ?? "Add a card")}</button>
                  {/if}
                  {#if onopensync}
                    <button type="button" class="act link" data-testid="usage-sync-off" onclick={() => onopensync?.()}>Turn off sync</button>
                  {/if}
                </div>
                {#if billingPortalHint(billingOutcome[key] ?? null, lineName(acct))}
                  <p class="note" role="status" data-testid="usage-billing-hint">{billingPortalHint(billingOutcome[key] ?? null, lineName(acct))}</p>
                {/if}
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .empty {
    padding: 14px 16px;
    color: var(--t2);
    font-size: 12px;
  }

  .accounts {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .account + .account {
    border-top: 1px solid var(--line);
  }

  .head {
    margin: 0;
    font: inherit;
  }

  .line {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 12px;
    border: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .line:hover {
    background: var(--hover, rgba(127, 127, 127, 0.08));
  }

  .line:focus-visible {
    outline: 2px solid var(--focus, var(--t2));
    outline-offset: -2px;
  }

  .chev {
    display: inline-flex;
    flex: none;
    transform: rotate(-90deg);
    transition: transform 120ms ease;
  }

  .chev.open {
    transform: none;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .role,
  .plan {
    flex: none;
    color: var(--t3, var(--t2));
    font-size: 11px;
  }

  .plan {
    margin-left: auto;
  }

  .total {
    flex: none;
    min-width: 92px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .detail {
    padding: 2px 12px 12px 32px;
    font-size: 12px;
  }

  .kv {
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: 16px;
    row-gap: 4px;
    margin: 0;
  }

  .kv dt {
    color: var(--t2);
  }

  .kv dd {
    margin: 0;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--t1);
  }

  .strong {
    font-weight: 500;
  }

  .muted {
    color: var(--t3, var(--t2));
  }

  .meters {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin-top: -2px;
    color: var(--t3, var(--t2));
    font-size: 11px;
  }

  .bar {
    display: inline-block;
    width: 64px;
    height: 4px;
    margin-left: 6px;
    vertical-align: middle;
    border-radius: 2px;
    background: var(--line2, var(--line));
    overflow: hidden;
  }

  .bar > span {
    display: block;
    height: 100%;
    background: var(--t2);
  }

  .notice,
  .note {
    margin: 6px 0;
    color: var(--t2);
    line-height: 1.45;
  }

  .notice {
    color: var(--t1);
  }

  .note.ok {
    color: var(--t1);
  }

  .switch,
  .confirm {
    margin-top: 8px;
  }

  .confirm p {
    margin: 0 0 6px;
    color: var(--t1);
    line-height: 1.45;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  .act {
    padding: 4px 10px;
    border: 1px solid var(--line2, var(--line));
    border-radius: 6px;
    background: none;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .act.primary {
    border-color: var(--t2);
  }

  .act.link {
    padding: 0;
    border: 0;
    color: var(--t3, var(--t2));
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .act:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
