<script lang="ts">
  /**
   * Settings > Usage (usage-only-pricing US-018; owner-approved new screen,
   * 2026-10-18). This month's cost per meter with labels and rates from
   * GET /v1/pricing, the included usage and how much is left, the trial
   * (days left, trial usage against the cap), the spend limit and the
   * projected bill. Same reads as the console usage view; every number is
   * hq-pro's (usage-settings-model.ts).
   *
   * Lives in its own file so the Sync section work (US-016) and this screen
   * do not touch the same component.
   */
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import { formatUsd } from "../home/core-usage-model.js";
  import {
    lineCostText,
    periodLabel,
    readUsageDetails,
    spendLimitLine,
    trialEndLabel,
    type UsageDetailsSource,
    type UsageDetailsView,
  } from "./usage-settings-model.js";

  interface UsageCompanyRow {
    uid: string;
    label: string;
    role: string | null;
  }

  let {
    company = null,
    companies = [],
    selectedCompanyUid = null,
  }: {
    company?: UsageDetailsSource | null;
    /** The caller's companies with their real role (null when unknown). */
    companies?: ReadonlyArray<UsageCompanyRow>;
    /** The company selected in the shell, preferred when present. */
    selectedCompanyUid?: string | null;
  } = $props();

  const isOwner = (row: UsageCompanyRow): boolean => (row.role ?? "").toLowerCase() === "owner";

  let chosenUid = $state<string | null>(null);
  let view = $state<UsageDetailsView>({ kind: "loading" });
  let reloading = $state(false);
  let nonce = $state(0);

  const defaultUid = $derived(
    companies.find((row) => row.uid === selectedCompanyUid)?.uid ??
      companies.find(isOwner)?.uid ??
      companies[0]?.uid ??
      null,
  );
  const target = $derived(companies.find((row) => row.uid === (chosenUid ?? defaultUid)) ?? null);
  // Usage reads are owner-gated: a known non-owner gets the note, not a 403.
  const knownNonOwner = $derived(target !== null && target.role !== null && !isOwner(target));

  $effect(() => {
    void nonce;
    const uid = target?.uid ?? null;
    const nonOwner = knownNonOwner;
    const api = company;
    if (!uid) return;
    if (nonOwner) {
      view = { kind: "owner-only" };
      reloading = false;
      return;
    }
    view = { kind: "loading" };
    let cancelled = false;
    void readUsageDetails(api, uid).then((next) => {
      if (cancelled) return;
      view = next;
      reloading = false;
    });
    return () => {
      cancelled = true;
    };
  });

  function choose(uid: string): void {
    chosenUid = uid;
  }

  function reload(): void {
    if (reloading) return;
    reloading = true;
    nonce += 1;
  }
</script>

<div class="proto-stack" data-testid="settings-usage-pane" data-state={target ? view.kind : "no-company"}>
  {#if companies.length > 1}
    <div class="set-row">
      <div>
        <div class="sn">Company</div>
        <div class="sd">Usage is billed per company.</div>
      </div>
      <div class="picker" role="radiogroup" aria-label="Company">
        {#each companies as row (row.uid)}
          <button
            type="button"
            class="chip"
            class:on={target?.uid === row.uid}
            role="radio"
            aria-checked={target?.uid === row.uid}
            data-testid="usage-company"
            onclick={() => choose(row.uid)}
          ><CompanyLabel name={row.label} companyUid={row.uid} size={14} /></button>
        {/each}
      </div>
    </div>
  {/if}

  {#if !target}
    <div class="set-row">
      <div>
        <div class="sn">Usage</div>
        <div class="sd" data-testid="usage-none">Usage is tracked per company. Join or create a company to see it.</div>
      </div>
    </div>
  {:else if view.kind === "loading"}
    <div class="set-row">
      <div>
        <div class="sn">{target.label}</div>
        <div class="sd" role="status" data-testid="usage-loading">Loading usage…</div>
      </div>
    </div>
  {:else if view.kind === "owner-only"}
    <div class="set-row">
      <div>
        <div class="sn">{target.label}</div>
        <div class="sd" data-testid="usage-owner-only">Only a company owner can see usage. Ask an owner of {target.label}.</div>
      </div>
    </div>
  {:else if view.kind === "not-usage"}
    <div class="set-row">
      <div>
        <div class="sn">{target.label}</div>
        <div class="sd" data-testid="usage-not-usage">{target.label} isn't on the usage plan, so there is no usage bill.</div>
      </div>
    </div>
  {:else if view.kind === "unavailable"}
    <div class="set-row">
      <div>
        <div class="sn">{target.label}</div>
        <div class="sd" data-testid="usage-unavailable">Usage isn't available right now.</div>
      </div>
      <RailButton
        icon="refresh"
        type="button"
        data-testid="usage-retry"
        disabled={reloading}
        aria-busy={reloading}
        onclick={reload}
      >{reloading ? "Checking…" : "Try again"}</RailButton>
    </div>
  {:else}
    <div class="set-row">
      <div>
        <div class="sn" data-testid="usage-company-name">{target.label}</div>
        <div class="sd" data-testid="usage-period">
          {periodLabel(view.periodStart, view.periodEnd)}{view.asOf ? "" : ". No full day measured yet"}{!view.complete && view.asOf ? ". Some usage isn't reported yet, so totals can still go up" : ""}
        </div>
      </div>
      {#if view.planLabel}
        <span class="tag" data-testid="usage-plan">{view.planLabel}</span>
      {/if}
    </div>

    {#if view.trial}
      <div class="set-row" data-testid="usage-trial">
        <div>
          <div class="sn">Free trial</div>
          <div class="sd" data-testid="usage-trial-days">
            {view.trial.daysLeft} {view.trial.daysLeft === 1 ? "day" : "days"} left. {trialEndLabel(view.trial.endsAt)}.
          </div>
        </div>
        <span class="amount" data-testid="usage-trial-usage">
          {#if view.trial.usedCents !== null && view.trial.capCents !== null}
            {formatUsd(view.trial.usedCents)} of {formatUsd(view.trial.capCents)}
          {:else}
            Not measured yet
          {/if}
        </span>
      </div>
    {/if}

    <div class="set-row">
      <div>
        <div class="sn">Included usage</div>
        <div class="sd">{formatUsd(view.allowanceCents)} of usage is included each month.</div>
      </div>
      <span class="amount" data-testid="usage-allowance-left">{formatUsd(view.allowanceLeftCents)} left</span>
    </div>

    <div class="set-row column">
      <div class="sn">This month by meter</div>
      <table class="meters" data-testid="usage-lines">
        <thead>
          <tr><th scope="col">Meter</th><th scope="col">Rate</th><th scope="col">Usage</th><th scope="col" class="num">Cost</th></tr>
        </thead>
        <tbody>
          {#each view.lines as line (line.key)}
            <tr data-testid="usage-line" data-key={line.key}>
              <td>{line.label}</td>
              <td class="muted">{line.rate}</td>
              <td class="muted">{line.usage ?? "—"}</td>
              <td class="num" class:muted={line.costCents === null || line.waived}>{lineCostText(line)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colspan="3">Usage so far</th>
            <td class="num" data-testid="usage-total">{formatUsd(view.usageCents)}</td>
          </tr>
        </tfoot>
      </table>
      {#if view.trial}
        <div class="sd">Trial days are free, so this month's costs count only days after the trial.</div>
      {/if}
      {#if view.freeText}
        <div class="sd" data-testid="usage-free">{view.freeText}</div>
      {/if}
    </div>

    <div class="set-row">
      <div>
        <div class="sn">Projected bill</div>
        <div class="sd">What this month would cost at the current pace, after the included usage.</div>
      </div>
      <span class="amount" data-testid="usage-projected">
        {view.projectedBillCents === null ? "Not available yet" : formatUsd(view.projectedBillCents)}
      </span>
    </div>

    <div class="set-row">
      <div>
        <div class="sn">Spend limit</div>
        <div class="sd" data-testid="usage-spend-limit-note">
          {#if view.spendLimit === null}
            The spend limit can't be shown right now.
          {:else if view.spendLimit.paused}
            Metered work is paused at the limit. An owner can raise it in HQ Console.
          {:else}
            Metered work pauses when the month's bill reaches the limit.
          {/if}
        </div>
      </div>
      {#if view.spendLimit}
        <span class="amount" data-testid="usage-spend-limit">{spendLimitLine(view.spendLimit)}</span>
      {/if}
    </div>
  {/if}
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

  .set-row.column {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
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

  .tag,
  .amount {
    flex: none;
    color: var(--t1);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .tag {
    color: var(--t2);
  }

  .meters {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .meters th,
  .meters td {
    padding: 6px 0;
    text-align: left;
    font-weight: 400;
    color: var(--t1);
  }

  .meters thead th {
    color: var(--t3, var(--t2));
    font-size: 11px;
  }

  .meters tbody tr {
    border-top: 1px solid var(--line);
  }

  .meters tfoot tr {
    border-top: 1px solid var(--line2, var(--line));
  }

  .meters tfoot th {
    font-weight: 500;
  }

  .meters .num {
    text-align: right;
  }

  .meters .muted {
    color: var(--t2);
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
