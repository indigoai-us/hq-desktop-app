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
  import { COMPANY_SETTINGS_ROW, type SidepaneScrollMemory } from "./sidepane-models.js";
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
  }

  let { company, selectedId = null, onselect, memory, companyApi = null }: Props = $props();

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
  const model = $derived(
    companyPaneModel(
      { uid: company.uid, label: company.label, liveCount },
      summary.summary,
      selectedId,
    ),
  );
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
