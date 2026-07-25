<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { companyStore } from '../lib/company-store.svelte';
  import Sparkline from './Sparkline.svelte';

  /**
   * Compact recent-activity digest for company Overview (DESKTOP-003).
   * Reuses `get_company_activity` (same as the Activity tab), warmed through
   * companyStore. Renders as a naked section: hairline rows, no outer rounded
   * dashboard boxes. All values are real; empty/zero states stay honest.
   */
  interface Props {
    slug: string;
    cloudBacked?: boolean;
    /** Open the global Inbox for full notification chronology. */
    onopeninbox?: () => void;
  }

  interface ActivityStats {
    files7: number;
    edits7: number;
    members: number;
    vaultSize: string;
  }
  interface ActivityContributor {
    who: string;
    edits: number;
  }
  interface CompanyActivity {
    stats: ActivityStats;
    sparkline: number[];
    top: ActivityContributor[];
  }

  let { slug, cloudBacked = true, onopeninbox }: Props = $props();

  const emptyStats = (): ActivityStats => ({ files7: 0, edits7: 0, members: 0, vaultSize: '' });
  const emptyActivity = (): CompanyActivity => ({ stats: emptyStats(), sparkline: [], top: [] });

  let activity = $state<CompanyActivity>(emptyActivity());
  let loading = $state(false);

  const numberOrZero = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  function normalize(result: Partial<CompanyActivity> | null | undefined): CompanyActivity {
    const stats = result?.stats ?? emptyStats();
    return {
      stats: {
        files7: numberOrZero(stats.files7),
        edits7: numberOrZero(stats.edits7),
        members: numberOrZero(stats.members),
        vaultSize: typeof stats.vaultSize === 'string' ? stats.vaultSize : '',
      },
      sparkline: Array.isArray(result?.sparkline) ? result.sparkline.map(numberOrZero) : [],
      top: Array.isArray(result?.top)
        ? result.top.map((c) => ({
            who: typeof c?.who === 'string' ? c.who : 'Unknown',
            edits: numberOrZero(c?.edits),
          }))
        : [],
    };
  }

  $effect(() => {
    activity = emptyActivity();
    if (!slug || !cloudBacked) {
      loading = false;
      return;
    }
    let cancelled = false;

    const warm = companyStore.activity(slug);
    activity = warm != null ? normalize(warm as Partial<CompanyActivity>) : emptyActivity();
    loading = warm == null;

    void invoke<Partial<CompanyActivity>>('get_company_activity', { slug })
      .then((result) => {
        if (!cancelled) {
          activity = normalize(result);
          companyStore.setActivity(slug, result);
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

  const hasActivity = $derived(
    activity.top.length > 0 || activity.sparkline.some((v) => v > 0) || activity.stats.edits7 > 0,
  );
  const summaryLine = $derived(
    [
      activity.stats.edits7 > 0 ? `${activity.stats.edits7} edits · 7d` : null,
      activity.stats.files7 > 0 ? `${activity.stats.files7} files · 7d` : null,
      activity.stats.members > 0 ? `${activity.stats.members} members` : null,
      activity.stats.vaultSize ? activity.stats.vaultSize : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
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
          <span class="digest-summary-meta">Team vault · last 7–14 days</span>
        </div>
        {#if activity.sparkline.length > 0}
          <span class="digest-monitor" aria-label="Edits over time">
            <Sparkline data={activity.sparkline} width={88} height={16} />
          </span>
        {/if}
      </div>
    {/if}

    {#if activity.top.length > 0}
      <ul class="digest-list">
        {#each activity.top.slice(0, 5) as c, index (`${c.who}:${index}`)}
          <li class="digest-row">
            <span class="digest-mark" aria-hidden="true">{c.who.slice(0, 1).toUpperCase()}</span>
            <div class="digest-copy">
              <span class="digest-title">{c.who}</span>
              <span class="digest-meta">
                {c.edits} {c.edits === 1 ? 'edit' : 'edits'} · recent window
              </span>
            </div>
            <strong class="digest-count">{c.edits}</strong>
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

  /* Discrete live monitor — rounded is intentional for object identity. */
  .digest-monitor {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    padding: 4px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-inset);
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
