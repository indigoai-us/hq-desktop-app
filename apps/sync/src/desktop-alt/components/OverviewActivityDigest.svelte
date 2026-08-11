<script lang="ts">
  import { companyStore } from '../lib/company-store.svelte';
  import {
    TEAM_ACTIVITY_WINDOW_DAYS,
    hasTeamActivity,
    normalizeTeamActivity,
    teamActivitySummaryLine,
    teamActivityWindowLabel,
    teamMemberRows,
    type CompanyActivity,
  } from '../lib/team-activity';
  import Sparkline from './Sparkline.svelte';

  /**
   * Compact recent-activity digest for company Overview (DESKTOP-003 / US-019).
   * Reuses `get_company_activity` (same as the Activity tab), warmed through
   * companyStore. Renders as a naked section: hairline rows, no outer rounded
   * dashboard boxes. All values are real; empty/zero states stay honest.
   * Absent optional fields (membersDetail, vaultBytes) mean no data — never error.
   */
  interface Props {
    slug: string;
    cloudBacked?: boolean;
    /** Local sync Off — pause fetches without treating the company as disconnected. */
    syncEnabled?: boolean;
    /** Open the global Inbox for full notification chronology. */
    onopeninbox?: () => void;
  }

  let { slug, cloudBacked = true, syncEnabled = true, onopeninbox }: Props = $props();
  const resourcesEnabled = $derived(cloudBacked && syncEnabled);

  const emptyActivity = (): CompanyActivity =>
    normalizeTeamActivity({ stats: {}, sparkline: [], top: [] });

  let activity = $state<CompanyActivity>(emptyActivity());
  let loading = $state(false);

  $effect(() => {
    void companyStore.revision;
    if (!slug || !resourcesEnabled) {
      activity = emptyActivity();
      loading = false;
      return;
    }
    let cancelled = false;

    const warm = companyStore.activity(slug);
    if (warm != null) {
      activity = normalizeTeamActivity(warm as Partial<CompanyActivity>);
      loading = false;
    } else {
      activity = emptyActivity();
      loading = true;
    }

    void companyStore.loadActivity<Partial<CompanyActivity>>(slug)
      .then((result) => {
        if (!cancelled) {
          activity = normalizeTeamActivity(result);
        }
      })
      .catch((err) => {
        console.warn(`get_company_activity(${slug}) failed:`, err);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  // Real field surface for the DESKTOP-003 contract + US-019 member rows.
  // Passing explicit activity.* paths keeps the live payload wired into the UI.
  const hasActivity = $derived(hasTeamActivity(activity));
  const summaryLine = $derived(
    teamActivitySummaryLine({
      stats: {
        files7: activity.stats.files7,
        edits7: activity.stats.edits7,
        members: activity.stats.members,
        vaultSize: activity.stats.vaultSize,
        vaultBytes: activity.stats.vaultBytes,
      },
      sparkline: activity.sparkline,
      top: activity.top,
      membersDetail: activity.membersDetail,
    }),
  );
  const memberRows = $derived(teamMemberRows(activity));
  const windowLabel = $derived(teamActivityWindowLabel(TEAM_ACTIVITY_WINDOW_DAYS));
</script>

<section
  class="digest"
  aria-labelledby="overview-activity-title"
  aria-busy={loading}
  data-testid="overview-recent-activity"
>
  <header class="digest-header">
    <h2 id="overview-activity-title">Recent activity</h2>
    <button
      type="button"
      class="digest-link"
      data-testid="overview-open-inbox"
      onclick={() => onopeninbox?.()}
    >
      Open inbox
    </button>
  </header>

  {#if !cloudBacked}
    <p class="digest-empty">Connect this company to see recent activity.</p>
  {:else if loading && !hasActivity}
    <div class="digest-skeleton" aria-hidden="true">
      {#each [0, 1, 2] as row (row)}<span style={`width: ${78 - row * 18}%`}></span>{/each}
    </div>
  {:else if !hasActivity}
    <p class="digest-empty">No activity yet — it appears here after files sync.</p>
  {:else}
    {#if summaryLine || activity.sparkline.length > 0}
      <div class="digest-summary" data-testid="overview-activity-summary">
        <div class="digest-summary-copy">
          {#if summaryLine}
            <span class="digest-summary-title">{summaryLine}</span>
          {/if}
          <span class="digest-summary-meta">{windowLabel}</span>
        </div>
        {#if activity.sparkline.length > 0}
          <span class="digest-monitor" aria-label="Edits over time">
            <Sparkline data={activity.sparkline} width={88} height={16} />
          </span>
        {/if}
      </div>
    {/if}

    {#if memberRows.length > 0}
      <ul class="digest-list">
        {#each memberRows.slice(0, 5) as row, index (`${row.name}:${row.email}:${index}`)}
          <li class="digest-row" data-testid="overview-activity-member-row">
            <span class="digest-mark" aria-hidden="true">{row.name.slice(0, 1).toUpperCase()}</span>
            <div class="digest-copy">
              <span class="digest-title">{row.name}</span>
              <span class="digest-meta">{row.meta}</span>
              {#if row.email}
                <span class="digest-email">{row.email}</span>
              {/if}
            </div>
            <strong class="digest-count">{row.edits}</strong>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .digest {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .digest-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-height: 28px;
  }

  .digest-header h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
    line-height: 1.25;
  }

  .digest-link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--type-metadata, var(--text-micro));
    cursor: pointer;
  }

  .digest-link:hover {
    color: var(--v4-text-2);
  }

  .digest-link:focus-visible {
    outline: 1px solid var(--v4-focus-ring);
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .digest-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    padding: 8px 0 10px;
    border-bottom: 1px solid var(--v4-rowline);
  }

  .digest-summary-copy {
    display: grid;
    min-width: 0;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .digest-summary-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .digest-summary-meta {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.25;
  }

  /* Sparkline is summary content, not a separate card. */
  .digest-monitor {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .digest-list {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .digest-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 7px 0;
    border-bottom: 1px solid var(--v4-rowline);
  }

  .digest-row:last-child {
    border-bottom: 0;
  }

  .digest-mark {
    display: grid;
    width: 24px;
    height: 24px;
    place-items: center;
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 500;
  }

  .digest-copy {
    display: grid;
    min-width: 0;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .digest-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .digest-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .digest-email {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .digest-count {
    flex: 0 0 auto;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .digest-empty {
    margin: 0;
    padding: 10px 0;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    line-height: 1.35;
  }

  .digest-skeleton {
    display: grid;
    gap: 8px;
    padding: 8px 0;
  }

  .digest-skeleton span {
    height: 8px;
    border-radius: 999px;
    background: var(--v4-control-faint);
    animation: digest-pulse 1.2s ease-in-out infinite;
  }

  @keyframes digest-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .digest-skeleton span {
      animation: none;
    }
  }
</style>
