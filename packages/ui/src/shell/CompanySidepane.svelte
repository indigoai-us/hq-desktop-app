<!--
  Company sidepane (console-rail US-007).

  Header: circle company mark, name, and the live count chip from the presence
  snapshot. Body: the Console-aligned sections. Footer: Company settings,
  pinned so it never scrolls. Row counts paint from the cached company summary
  and refresh in the background; nothing here blocks the first frame.
-->
<script lang="ts">
  import Sidepane from "./Sidepane.svelte";
  import SidepaneList from "./SidepaneList.svelte";
  import {
    COMPANY_SETTINGS_ROW,
    INVITE_TEAMMATE_ROW,
    atlasSidepaneModel,
    type SidepaneRosterEntry,
    type SidepaneScrollMemory,
  } from "./sidepane-models.js";
  import { companyPaneModel } from "./company-pane.js";
  import { companyLiveCount } from "./pinned-companies.js";
  import { presenceSnapshot } from "../chat/presence-store.svelte.js";
  import { useCompanySummary } from "../company/company-summary.svelte.js";
  import { companyIconSrc } from "../avatars/csp-image-src.js";
  import { configureCompanyApi } from "../company/company-store.svelte.js";
  import type { CompanyApi } from "@hq/platform";

  interface Props {
    company: { uid: string; label: string; slug?: string | null; iconUrl?: string | null };
    selectedId?: string | null;
    onselect?: (rowId: string) => void;
    memory?: SidepaneScrollMemory;
    /** Host company backend; without one the rows render without counts. */
    companyApi?: CompanyApi | null;
    /** Atlas (US-009): Live now and Idle rosters follow the sections. */
    roster?: readonly SidepaneRosterEntry[];
    /** Atlas (US-009): names still loading; draw skeleton roster rows. */
    rosterLoading?: boolean;
    /** Atlas (US-013): roster person filtering the map; highlighted instead of Atlas. */
    rosterSelected?: string | null;
  }

  let {
    company,
    selectedId = null,
    onselect,
    memory,
    companyApi = null,
    roster = [],
    rosterLoading = false,
    rosterSelected = null,
  }: Props = $props();

  // Same wiring CompanyPage does, minus the poller: counts load once per
  // company from the shared cache and pick up any background refresh.
  $effect.pre(() => {
    if (companyApi) configureCompanyApi(companyApi);
  });

  const summary = useCompanySummary({
    slug: () => company.slug?.trim() || null,
    enabled: () => Boolean(companyApi),
  });

  const liveCount = $derived(companyLiveCount(presenceSnapshot(), company.uid));
  const atlasActive = $derived(selectedId === "atlas");
  const model = $derived.by(() => {
    const base = companyPaneModel(
      { uid: company.uid, label: company.label, liveCount },
      summary.summary,
      selectedId,
    );
    if (!atlasActive || rosterLoading) return base;
    // Same pane key either way, so landing on Atlas keeps scroll memory.
    const rosterSections = atlasSidepaneModel(company, roster).sections.filter(
      (s) => s.id === "live-now" || s.id === "idle" || s.id === "invite",
    );
    const filtered = rosterSelected ? `person:${rosterSelected}` : null;
    const hasRow = filtered && rosterSections.some((s) => s.rows.some((r) => r.id === filtered));
    return {
      ...base,
      sections: [...base.sections, ...rosterSections],
      selectedId: hasRow ? filtered : base.selectedId,
    };
  });
  const iconSrc = $derived(companyIconSrc(company.iconUrl ?? null));
  const initial = $derived((model.title.trim()[0] ?? "?").toUpperCase());
</script>

<Sidepane modelKey={model.key} {memory} label={`${model.title} sections`}>
  {#snippet header()}
    <div class="company-head" data-testid="company-sidepane-header">
      <span class="company-mark" aria-hidden="true">
        {#if iconSrc}<img src={iconSrc} alt="" />{:else}{initial}{/if}
      </span>
      <span class="company-name">{model.title}</span>
      <span
        class="live-chip"
        class:is-live={model.liveCount > 0}
        data-testid="company-sidepane-live"
        aria-label={`${model.liveCount} live`}
      >
        <i class="live-dot" aria-hidden="true"></i>{model.liveCount}
      </span>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      type="button"
      class="footer-row"
      class:is-selected={selectedId === COMPANY_SETTINGS_ROW.id}
      aria-current={selectedId === COMPANY_SETTINGS_ROW.id ? "page" : undefined}
      data-testid="company-sidepane-settings"
      onclick={() => onselect?.(COMPANY_SETTINGS_ROW.id)}
    >
      {COMPANY_SETTINGS_ROW.label}
    </button>
  {/snippet}
  <SidepaneList
    sections={model.sections}
    selectedId={model.selectedId}
    onselect={(row) => onselect?.(row.id === INVITE_TEAMMATE_ROW.id ? "team" : row.id)}
  />
  {#if atlasActive && rosterLoading}
    <div class="roster-skeleton" data-testid="company-sidepane-roster-skeleton" aria-hidden="true">
      <div class="sk-label">People</div>
      {#each [78, 64, 58, 84, 60, 70] as width, i (i)}
        <div class="sk-row"><span class="sk sk-mark"></span><span class="sk" style:width={`${width}px`}></span></div>
      {/each}
    </div>
  {/if}
</Sidepane>

<style>
  .company-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
  }

  .company-mark {
    display: inline-grid;
    flex: 0 0 20px;
    place-items: center;
    width: 20px;
    height: 20px;
    overflow: hidden;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font-size: 10px;
    font-weight: 600;
  }

  .company-mark img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .company-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--line2);
  }

  .live-chip.is-live .live-dot {
    background: var(--ok);
  }

  .sk-label {
    height: 30px;
    box-sizing: border-box;
    padding: 12px 8px 4px;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .sk-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
  }

  .sk {
    display: inline-block;
    height: 10px;
    border-radius: 4px;
    background: var(--line);
    animation: sidepane-sk 1.8s ease-in-out infinite;
  }

  .sk-mark {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }

  @keyframes sidepane-sk {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk {
      animation: none;
    }
  }

  .footer-row {
    display: flex;
    align-items: center;
    width: 100%;
    height: 30px;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }

  .footer-row:hover {
    background: var(--hover);
  }

  .footer-row.is-selected {
    background: var(--sel);
  }

  .footer-row:focus-visible {
    outline: 1px solid var(--line2);
    outline-offset: -1px;
  }
</style>
