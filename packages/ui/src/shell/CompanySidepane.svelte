<!--
  Company sidepane (console-rail US-007).

  Header: circle company mark, name, and the live count chip from the presence
  snapshot. Body: the Console-aligned sections. Footer: Company settings,
  pinned so it never scrolls. Row counts paint from the cached company summary
  and refresh in the background; nothing here blocks the first frame.
-->
<script lang="ts">
  import Sidepane from "./Sidepane.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import SidepaneList from "./SidepaneList.svelte";
  import {
    COMPANY_SETTINGS_ROW,
    atlasSidepaneModel,
    type SidepaneRosterEntry,
    type SidepaneScrollMemory,
  } from "./sidepane-models.js";
  import { companyPaneModel } from "./company-pane.js";
  import { companyPageCounts } from "./company-page-counts.svelte.js";
  import { companyLiveCount } from "./pinned-companies.js";
  import { presenceSnapshot } from "../chat/presence-store.svelte.js";
  import { useCompanySummary } from "../company/company-summary.svelte.js";
  import { companyIconSrc } from "../avatars/csp-image-src.js";
  import { companyStore, configureCompanyApi } from "../company/company-store.svelte.js";
  import { secretRowsFromSource } from "../company/files-connect/files-connect-model.js";
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
    /** Atlas (US-009): names still loading; show the loader under the roster label. */
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

  // Same wiring the old company Overview did, minus the poller: counts load once per
  // company from the shared cache and pick up any background refresh.
  $effect.pre(() => {
    if (companyApi) configureCompanyApi(companyApi);
  });

  const summary = useCompanySummary({
    slug: () => company.slug?.trim() || null,
    enabled: () => Boolean(companyApi),
  });

  // Secrets count from the same list the Secrets page reads (QA-014): the
  // summary's secrets field counts env groups, not keys. Cache first, then a
  // background load refreshes it; the page's own refresh lands here too.
  const slugValue = $derived(company.slug?.trim() || null);
  const storeCounts = $derived.by((): Record<string, number> => {
    void companyStore.revision;
    const list = slugValue && companyApi ? companyStore.secrets(slugValue) : null;
    return Array.isArray(list) ? { secrets: secretRowsFromSource(list).length } : {};
  });
  $effect(() => {
    const s = slugValue;
    if (!s || !companyApi) return;
    void companyStore.loadSecrets(s, false).catch((err: unknown) => {
      console.warn("[company-sidepane] secrets count refresh failed", err);
    });
  });

  const liveCount = $derived(companyLiveCount(presenceSnapshot(), company.uid));
  const atlasActive = $derived(selectedId === "atlas");
  const model = $derived.by(() => {
    const base = companyPaneModel(
      { uid: company.uid, label: company.label, liveCount },
      summary.summary,
      selectedId,
      { ...storeCounts, ...companyPageCounts(company.slug, company.uid) },
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
    onselect={(row) => onselect?.(row.id)}
  />
  {#if atlasActive && rosterLoading}
    <div class="roster-loading">
      <div class="roster-label">People</div>
      <ReadLoader testid="company-sidepane-roster-loading" />
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
    font-weight: 500;
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
    font-size: 13px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--t2);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
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

  .roster-label {
    height: 30px;
    box-sizing: border-box;
    padding: 12px 8px 4px;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .footer-row {
    display: flex;
    align-items: center;
    width: 100%;
    height: 31px;
    box-sizing: border-box;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    line-height: 17px;
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
