<!--
  Meetings sidepane (console-rail US-021).

  Sidepane host with the Messages grammar: header with Filter and New meeting,
  then Live, Today, Tomorrow, Past. Rows are a time slot, title, an optional
  company mark, and a notes mark on past rows with a recap. Sections derive
  from the meetings-store snapshot, which hydrates from meetings-cache before
  the first refresh, so the pane paints from cache in the first frame and
  shows shimmer rows only on a true cold start.
-->
<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import Sidepane from "../shell/Sidepane.svelte";
  import type { SidepaneScrollMemory } from "../shell/sidepane-models.js";
  import {
    activeFilterCount,
    EMPTY_MEETINGS_FILTER,
    filterCompanies,
    type MeetingsFilter,
    type MeetingsRailSection,
  } from "./meetings-rail-model";
  import type { MeetingEvent } from "./meetings-model";

  interface Props {
    sections: readonly MeetingsRailSection[];
    events: readonly MeetingEvent[];
    companyNamesByUid: Map<string, string>;
    selectedId: string | null;
    filter: MeetingsFilter;
    /** True only on a cold start with no cached snapshot. */
    loading?: boolean;
    memory?: SidepaneScrollMemory;
    onselect?: (id: string) => void;
    onfilter?: (next: MeetingsFilter) => void;
    onnewmeeting?: () => void;
    onearlier?: () => void;
  }

  let {
    sections,
    events,
    companyNamesByUid,
    selectedId,
    filter,
    loading = false,
    memory,
    onselect,
    onfilter,
    onnewmeeting,
    onearlier,
  }: Props = $props();

  let filterOpen = $state(false);
  const companies = $derived(filterOpen ? filterCompanies(events, companyNamesByUid) : []);
  const activeCount = $derived(activeFilterCount(filter));
  const liveCount = $derived(sections.find((s) => s.id === "live")?.rows.length ?? 0);

  function toggle(key: "hasRecording" | "hasRecap" | "liveOnly"): void {
    onfilter?.({ ...filter, [key]: !filter[key] });
  }

  function onWindowKey(event: KeyboardEvent): void {
    if (filterOpen && event.key === "Escape") filterOpen = false;
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<Sidepane modelKey="meetings" {memory} label="Meetings">
  {#snippet header()}
    <div class="pane-head" data-testid="meetings-sidepane-header">
      <span class="title">Meetings</span>
      <button
        type="button"
        class="icon-btn"
        class:is-active={filterOpen || activeCount > 0}
        aria-label="Filter"
        aria-expanded={filterOpen}
        data-testid="meetings-filter-button"
        onclick={() => (filterOpen = !filterOpen)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        aria-label="New meeting"
        data-testid="meetings-new-button"
        onclick={() => onnewmeeting?.()}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      {#if filterOpen}
        <div class="popover" role="dialog" aria-label="Filter meetings" data-testid="meetings-filter-popover">
          <div class="pop-sec">Company</div>
          <button type="button" class="pop-row" aria-pressed={!filter.companyUid} onclick={() => onfilter?.({ ...filter, companyUid: null })}>
            <span class="ck">{!filter.companyUid ? "✓" : ""}</span><span class="t">All companies</span>
          </button>
          {#each companies as c (c.uid)}
            <button type="button" class="pop-row" aria-pressed={filter.companyUid === c.uid} onclick={() => onfilter?.({ ...filter, companyUid: c.uid })}>
              <span class="ck">{filter.companyUid === c.uid ? "✓" : ""}</span>
              <span class="t"><CompanyLabel name={c.label} companyUid={c.uid} /></span><span class="count">{c.count}</span>
            </button>
          {/each}
          <div class="pop-sec">Show</div>
          <button type="button" class="pop-row" aria-pressed={filter.hasRecording} onclick={() => toggle("hasRecording")}>
            <span class="ck">{filter.hasRecording ? "✓" : ""}</span><span class="t">Has recording</span>
          </button>
          <button type="button" class="pop-row" aria-pressed={filter.hasRecap} onclick={() => toggle("hasRecap")}>
            <span class="ck">{filter.hasRecap ? "✓" : ""}</span><span class="t">Has recap</span>
          </button>
          <button type="button" class="pop-row" aria-pressed={filter.liveOnly} onclick={() => toggle("liveOnly")}>
            <span class="ck">{filter.liveOnly ? "✓" : ""}</span><span class="t">Live now</span>
            {#if liveCount}<span class="live-chip"><i class="ldot"></i>{liveCount}</span>{/if}
          </button>
          <div class="pop-foot">
            <span>{activeCount} active</span>
            <button type="button" class="link" onclick={() => onfilter?.(EMPTY_MEETINGS_FILTER)}>Clear</button>
          </div>
        </div>
      {/if}
    </div>
  {/snippet}

  {#if loading && sections.length === 0}
    <div class="skeleton" data-testid="meetings-sidepane-skeleton" aria-hidden="true">
      {#each [40, 0, 0, 40, 0, 0, 0] as label, i (i)}
        {#if label}<div class="sk-label"><span class="sk" style:width="40%"></span></div>
        {:else}<div class="sk-row"><span class="sk" style:width="34px"></span><span class="sk" style:width={`${110 + ((i * 37) % 60)}px`}></span></div>{/if}
      {/each}
    </div>
  {:else if sections.length === 0}
    <div class="empty" data-testid="meetings-sidepane-empty">
      {activeCount ? "No meetings match these filters." : "No meetings today or tomorrow."}
    </div>
  {:else}
    {#each sections as section (section.id)}
      <div class="sec" data-testid="meetings-section" data-section={section.id}>{section.label}</div>
      {#each section.rows as row (row.id)}
        <button
          type="button"
          class="row"
          class:is-selected={row.id === selectedId}
          aria-current={row.id === selectedId ? "page" : undefined}
          data-testid="meetings-row"
          data-row-id={row.id}
          data-live={row.live ? "true" : undefined}
          onclick={() => onselect?.(row.id)}
        >
          {#if row.live}
            <span class="time live" aria-hidden="true"><i class="ldot"></i></span>
          {:else}
            <span class="time">{row.time}</span>
          {/if}
          <span class="t">{row.title}</span>
          {#if row.companyMark}<span class="mark" title={row.companyUid ?? undefined} aria-hidden="true">{row.companyMark}</span>{/if}
          {#if row.hasRecap}
            <span class="notes" aria-label="Recap saved" data-testid="meetings-row-recap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>
            </span>
          {/if}
          {#if row.live}<span class="meta">{row.time}</span>{/if}
        </button>
      {/each}
    {/each}
    {#if sections.some((s) => s.id === "past")}
      <button type="button" class="sec earlier" onclick={() => onearlier?.()}>Earlier <span aria-hidden="true">›</span></button>
    {/if}
  {/if}
</Sidepane>

<style>
  .pane-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 30px;
    padding: 0 4px 0 8px;
  }

  .title {
    flex: 1 1 auto;
    font-size: 14px;
    font-weight: 500;
  }

  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }

  .icon-btn:hover,
  .icon-btn.is-active {
    background: var(--hover);
    color: var(--t1);
  }

  .sec {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    width: 100%;
    height: 30px;
    box-sizing: border-box;
    padding: 12px 8px 4px;
    border: 0;
    background: transparent;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-align: left;
    text-transform: uppercase;
  }

  .sec.earlier {
    cursor: pointer;
  }

  .sec.earlier:hover {
    color: var(--t1);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
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

  .row:hover {
    background: var(--hover);
  }

  .row.is-selected {
    background: var(--sel);
  }

  .row:focus-visible {
    outline: 1px solid var(--line2);
    outline-offset: -1px;
  }

  .time {
    flex: 0 0 38px;
    color: var(--t2);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .time.live {
    display: inline-flex;
    align-items: center;
  }

  .ldot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
  }

  .live-chip .ldot {
    width: 6px;
    height: 6px;
  }

  .t {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta,
  .count {
    flex: 0 0 auto;
    color: var(--t2);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .mark {
    display: inline-grid;
    flex: 0 0 14px;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font-size: 7px;
    font-weight: 600;
  }

  .notes {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--t2);
  }

  .empty {
    padding: 16px 8px;
    color: var(--t2);
    font-size: 13px;
  }

  .popover {
    position: absolute;
    top: 32px;
    right: 0;
    z-index: 20;
    width: 232px;
    box-sizing: border-box;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--v4-popover, var(--side-bg));
    box-shadow: var(--v4-shadow-popover);
  }

  .pop-sec {
    padding: 8px 8px 4px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .pop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .pop-row:hover {
    background: var(--hover);
  }

  .ck {
    flex: 0 0 12px;
    color: var(--t1);
    font-size: 11px;
  }

  .live-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .pop-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
    padding: 6px 8px 2px;
    border-top: 1px solid var(--line);
    color: var(--t2);
    font-size: 12px;
  }

  .link {
    border: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    cursor: pointer;
  }

  .sk-label {
    height: 30px;
    box-sizing: border-box;
    padding: 14px 8px 4px;
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
    animation: meetings-sk 1.8s ease-in-out infinite;
  }

  @keyframes meetings-sk {
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
</style>
