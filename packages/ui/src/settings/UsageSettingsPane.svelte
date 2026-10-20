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
  import UsageStackBar from "../home/UsageStackBar.svelte";
  import { segmentColor } from "../home/usage-stack.js";
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
    isPaused,
    lineBar,
    usageIsPartial,
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

  // A company with no cloud account (local only) has no usage to show here.
  const rows = $derived<UsageAccount[]>(
    orderedAccounts(
      (
        accounts ??
        companies.map((row): UsageAccount => ({ kind: "company", uid: row.uid, name: row.label, role: row.role }))
      ).filter((a) => a.kind === "personal" || Boolean(a.uid)),
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
  /** Groups whose meters are shown (click or Enter on the group name; hover shows them too). */
  let metersOpen = $state<Record<string, boolean>>({});

  // Read every line once per account list; the price list once.
  $effect(() => {
    void rowKeys;
    // Only the set of accounts re-reads the lines, not a new array with the same accounts.
    const list = untrack(() => rows);
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
      // The spend limit is the line's marker and sets its colour, so it is
      // read with the line, not when it opens.
      if (view.kind === "ready" && (view.plan === "usage" || view.plan === "trial")) loadSpend(acct);
      if (untrack(() => openKey) === key) loadDetail(acct, view);
    });
  }

  function loadSpend(acct: UsageAccount): void {
    const key = accountKey(acct);
    const current = untrack(() => spend[key]);
    if (current === "loading") return;
    spend = { ...spend, [key]: "loading" };
    void readSpendLimit(company, acct).then((limit) => {
      spend = { ...spend, [key]: limit };
    });
  }

  function spendFor(key: string): SpendLimitDetail | null | undefined {
    const value = spend[key];
    return value === "loading" ? undefined : value;
  }

  /** The detail's own reads: the spend limit, or the switch offer for a free account. */
  function loadDetail(acct: UsageAccount, view: AccountRowView | undefined): void {
    if (view?.kind !== "ready") return;
    const key = accountKey(acct);
    if (view.plan === "usage" || view.plan === "trial") {
      if (spend[key] === undefined || spend[key] === null) loadSpend(acct);
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
    return included === null ? "Some" : formatUsd(included);
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
        {@const bar = view.kind === "ready" ? lineBar(view, spendFor(key)) : null}
        {@const paused = view.kind === "ready" && isPaused(view)}
        <li class="account" class:open data-testid="usage-account-row" data-key={key}>
          <h3 class="head">
            <button
              bind:this={headers[index]}
              type="button"
              class="line"
              id={`usage-line-${index}`}
              aria-expanded={open}
              aria-controls={open ? `usage-detail-${index}` : undefined}
              data-testid="usage-account"
              data-key={key}
              data-tone={bar?.tone ?? "none"}
              onclick={() => toggle(acct)}
              onkeydown={(event) => onHeaderKey(event, index)}
            >
              <span class="top">
                <span class="chev" class:open aria-hidden="true"><Caret tone="var(--t3)" /></span>
                <span class="name" class:personal={acct.kind === "personal"} data-testid="usage-account-name">{#if acct.kind === "personal"}{lineName(acct)}{:else}<CompanyLabel name={acct.name} companyUid={acct.uid} size={14} />{/if}</span>
                {#if roleTag(acct)}<span class="badge">{roleTag(acct)}</span>{/if}
                <span class="badge plan" class:hidden={view.kind !== "ready"} data-testid="usage-account-plan" data-plan={view.kind === "ready" ? view.plan : view.kind}>{view.kind === "ready" ? view.planLabel : ""}</span>
                {#if paused}<span class="badge alert" data-testid="usage-account-paused">Sync paused</span>{/if}
                <span class="sum">
                  <span class="total" class:quiet={!bar} data-testid="usage-account-total">{rowTotalText(view)}</span>
                  {#if bar}<span class="helper">{bar.helper}</span>{/if}
                </span>
              </span>
              {#if bar}
                <span class="bar-row">
                  <UsageStackBar
                    segments={bar.segments}
                    scaleCents={bar.scaleCents}
                    includedCents={bar.includedCents}
                    marker={bar.marker}
                    tone={bar.tone}
                    size="lg"
                    grow="change"
                    role="presentation"
                    aria-hidden="true"
                    data-testid="usage-account-bar"
                  />
                </span>
              {/if}
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
                  <p class="notice" class:alert={paused} role="status" data-testid="usage-notice" data-kind={view.notice.kind}>{view.notice.text}</p>
                {/if}
                {#if view.trial && bar}
                  <div class="trial-bar">
                    <span class="g-label">Trial usage</span>
                    <span class="g-amt" data-testid="usage-trial-usage">{view.trial.unknownMeters?.length ? "At least " : ""}{formatUsd(view.trial.usedCents ?? 0)} of {formatUsd(view.trial.capCents ?? 0)}</span>
                  </div>
                  <p class="note small" data-testid="usage-trial-note">Trial days are free. Costs by group start when the trial ends.</p>
                {:else if view.usage && bar}
                  <ul class="groups" aria-label="This month by group">
                    {#each view.usage.groups as group (group.id)}
                      <li class="group" class:show={metersOpen[key + ":" + group.id]} title={group.meters.map((m) => `${m.label}: ${m.waived ? "waived" : m.costCents === null ? "not reported" : formatUsd(m.costCents)}${m.rate ? ` (${m.rate})` : ""}`).join("\n")}>
                        <button type="button" class="g-label g-toggle" aria-pressed={Boolean(metersOpen[key + ":" + group.id])} data-testid="usage-group-toggle" onclick={() => (metersOpen = { ...metersOpen, [key + ":" + group.id]: !metersOpen[key + ":" + group.id] })}><span class="dot" style={`background:${segmentColor(group.id)}`} aria-hidden="true"></span>{group.label}</button>
                        <span class="g-amt" data-testid="usage-group" data-group={group.id}>{group.cents === null ? "Not reported" : `${group.partial ? "At least " : ""}${formatUsd(group.cents)}`}</span>
                        <span class="g-bar">
                          <UsageStackBar
                            segments={[{ id: group.id, label: group.label, cents: group.cents ?? 0 }]}
                            scaleCents={bar.scaleCents}
                            size="sm"
                            grow="mount"
                            label={`${group.label} ${group.cents === null ? "not reported" : formatUsd(group.cents)}`}
                          />
                        </span>
                        <span class="g-meters">
                          {#each group.meters as meter (meter.key)}
                            <span class="meter" title={meter.rate} data-testid="usage-line" data-key={meter.key}>{meter.label} {meter.waived ? "waived" : meter.costCents === null ? "not reported" : formatUsd(meter.costCents)}</span>
                          {/each}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <dl class="facts">
                  {#if view.usage && !view.trial}
                    <div><dt>Usage so far</dt><dd data-testid="usage-total">{usageIsPartial(view.usage) ? "At least " : ""}{formatUsd(view.usage.usageCents)}</dd><dd class="sub" data-testid="usage-period">{periodLabel(view.usage.periodStart, view.usage.periodEnd)}</dd></div>
                    <div><dt>Included</dt><dd data-testid="usage-allowance-left">{formatUsd(view.usage.allowanceLeftCents)} of free usage left</dd><dd class="sub">{formatUsd(view.usage.allowanceCents)} each month</dd></div>
                  {:else if view.usageUnavailable && !view.trial}
                    <div><dt>This month</dt><dd class="quiet" data-testid="usage-unavailable">Not available right now</dd></div>
                  {:else if !view.trial}
                    <div><dt>Plan</dt><dd data-testid="usage-old-plan">{view.planLabel}</dd></div>
                  {/if}
                  {#if view.trial}
                    <div><dt>Trial</dt><dd data-testid="usage-trial-days">{view.trial.daysLeft} {view.trial.daysLeft === 1 ? "day" : "days"} left</dd>{#if trialEndLabel(view.trial.endsAt)}<dd class="sub">{trialEndLabel(view.trial.endsAt)}</dd>{/if}</div>
                    {#if !bar}
                      <div><dt>Trial usage</dt><dd data-testid="usage-trial-usage">Not measured yet</dd></div>
                    {/if}
                  {/if}
                  {#if view.plan === "usage" || view.plan === "trial"}
                    {@const limit = spend[key]}
                    <div><dt>Spend limit</dt><dd data-testid="usage-spend-limit">{limit === "loading" || limit === undefined ? "…" : limit === null ? "Can't be shown" : spendLimitLine(limit)}</dd><dd class="sub">{limit && limit !== "loading" && limit.noLimit ? "Metered work doesn't pause for spending" : "Metered work pauses at the limit"}</dd></div>
                    {#if view.usage && !view.trial}
                      <div><dt>Projected bill</dt><dd data-testid="usage-projected">{view.usage.projectedBillCents === null ? "Not available yet" : formatUsd(view.usage.projectedBillCents)}</dd><dd class="sub" data-testid="usage-projected-note">At this pace, after the {formatUsd(view.usage.allowanceCents)} included</dd></div>
                    {/if}
                  {/if}
                  <div><dt>Card on file</dt><dd data-testid="usage-card">{view.cardOnFile === null ? "Unknown" : view.cardOnFile ? "Yes" : "No"}</dd></div>
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
                    {:else if state.kind === "card-required"}
                      <p class="note" data-testid="usage-switch-note">A card is needed to switch. There's no free trial when you switch.</p>
                    {:else if state.kind === "refused"}
                      <p class="note" data-testid="usage-switch-note">{state.text}</p>
                    {:else if state.kind === "switched"}
                      <p class="note" data-testid="usage-switch-note">This account is already on usage pricing.</p>
                    {:else if state.kind === "not-available"}
                      <p class="note" data-testid="usage-switch-note">{SWITCH_NOT_AVAILABLE_TEXT}</p>
                    {/if}
                  </div>
                {/if}
                {#if switchNote[key]}
                  <p class="note" class:ok={switchNote[key].ok} role="status" data-testid="usage-switch-result">{switchNote[key].text}</p>
                {/if}

                {#if confirmKey !== key}
                  <div class="actions">
                    {#if view.plan === "starter"}
                      {@const offer = switchStates[key]}
                      {#if offer?.kind === "offered"}
                        <button type="button" class="act primary" data-testid="usage-switch-start" onclick={() => (confirmKey = key)}>Switch to usage pricing</button>
                      {:else if offer?.kind === "not-available"}
                        <button type="button" class="act" data-testid="usage-switch-start" disabled>Switch to usage pricing</button>
                      {/if}
                    {/if}
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
                {/if}
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
    flex-direction: column;
    gap: 7px;
    width: 100%;
    padding: 10px 14px 11px;
    border: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  /* Hover and the open line share one quiet tint: it marks what a click acts on. */
  .line:hover,
  .account.open .line {
    background: var(--hover, rgba(127, 127, 127, 0.06));
  }

  .line:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t2));
    outline-offset: -2px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .chev {
    display: inline-flex;
    flex: none;
    transform: rotate(-90deg);
    transition: transform 140ms ease;
  }

  .chev.open {
    transform: none;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
  }

  /* Lines up with the company names, which follow a 14px avatar and a 6px gap. */
  .name.personal {
    padding-left: 20px;
  }

  .badge {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--line2, var(--line));
    border-radius: 999px;
    color: var(--t2);
    font-size: 10px;
    line-height: 1.5;
    white-space: nowrap;
  }

  .badge.hidden {
    display: none;
  }

  .badge.alert {
    border-color: color-mix(in srgb, var(--v4-error, var(--red, #dc2626)) 45%, transparent);
    color: var(--v4-error, var(--red, #dc2626));
  }

  .sum {
    display: flex;
    flex: none;
    align-items: baseline;
    gap: 6px;
    margin-left: auto;
  }

  /* The month's total is the largest thing on a line. */
  .total {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
    color: var(--t1);
  }

  .line[data-tone="near"] .total {
    color: var(--warn-ink, var(--warn, #b45309));
  }

  .line[data-tone="at"] .total {
    color: var(--v4-error, var(--red, #dc2626));
  }

  .total.quiet {
    font-size: 12px;
    font-weight: 400;
    color: var(--t2);
  }

  .helper {
    color: var(--t2);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .bar-row {
    display: block;
    padding-left: 20px;
  }

  .detail {
    padding: 4px 14px 14px 34px;
    font-size: 12px;
    background: var(--hover, rgba(127, 127, 127, 0.06));
  }

  .groups {
    display: grid;
    gap: 8px;
    margin: 4px 0 12px;
    padding: 0;
    list-style: none;
  }

  .group {
    display: grid;
    grid-template-columns: 1fr auto;
    row-gap: 4px;
    outline: none;
  }

  .g-label {
    color: var(--t2);
  }

  .g-amt {
    color: var(--t1);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .g-bar {
    grid-column: 1 / -1;
  }

  /* The meters behind a group show on hover or keyboard focus (detail on
     demand); screen readers always read them. */
  .g-meters {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    color: var(--t2);
    font-size: 11px;
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .group:hover .g-meters,
  .group.show .g-meters {
    position: static;
    width: auto;
    height: auto;
    overflow: visible;
    clip-path: none;
    white-space: normal;
  }

  .g-toggle {
    appearance: none;
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .g-toggle:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t2));
    outline-offset: 2px;
    border-radius: 3px;
  }

  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 2px;
    vertical-align: 0;
  }

  /* Facts sit side by side at their natural width; labels never wrap. */
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 28px;
    margin: 0;
  }

  .facts dt {
    color: var(--t2);
    font-size: 11px;
    white-space: nowrap;
  }

  .facts dd {
    margin: 1px 0 0;
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .facts dd.sub {
    margin: 0;
    color: var(--t2);
    font-size: 11px;
    font-weight: 400;
  }

  .facts dd.quiet {
    color: var(--t2);
    font-weight: 400;
  }

  .notice,
  .note {
    margin: 6px 0;
    color: var(--t2);
    line-height: 1.45;
  }

  .note.small {
    margin: -4px 0 12px;
    font-size: 11px;
    color: var(--t2);
  }

  .trial-bar {
    display: grid;
    grid-template-columns: 1fr auto;
    row-gap: 4px;
    margin: 4px 0 10px;
  }

  .notice {
    margin: 4px 0 12px;
    color: var(--t1);
  }

  .notice.alert {
    color: var(--v4-error, var(--red, #dc2626));
  }

  .note.ok {
    color: var(--t1);
  }

  .switch,
  .confirm {
    margin-top: 10px;
  }

  .confirm p {
    margin: 0 0 6px;
    color: var(--t1);
    line-height: 1.45;
  }

  /* Actions sit below the numbers and stay quieter than them. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-top: 12px;
  }

  .act {
    padding: 3px 9px;
    border: 1px solid var(--line2, var(--line));
    border-radius: 6px;
    background: none;
    color: var(--t2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .act:hover:not(:disabled) {
    color: var(--t1);
  }

  .act.primary {
    border-color: var(--t2);
    color: var(--t1);
  }

  .act.link {
    padding: 0;
    border: 0;
    color: var(--t2);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .act:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
