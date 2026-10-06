<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  /**
   * More companies (console-rail US-005). 320 px popover on the More tile.
   * Paints from the cached roster. Pin and unpin show on hover. A seventh
   * pin opens an inline chooser instead of growing the rail past six.
   */
  import { focusReturn } from "./focus-return.js";
  import {
    moreCompaniesSections,
    pinCompany,
    replacePinnedCompany,
    unpinCompany,
    type MoreCompany,
  } from "./more-companies.js";

  interface Props {
    companies: readonly MoreCompany[];
    pinnedIds: readonly string[];
    recentIds: readonly string[];
    anchorTop?: number;
    anchorLeft?: number;
    onclose?: () => void;
    onopen?: (company: MoreCompany) => void;
    onpins?: (ids: string[]) => void;
    onnewcompany?: () => void;
  }

  let {
    companies,
    pinnedIds,
    recentIds,
    anchorTop = 72,
    anchorLeft = 64,
    onclose,
    onopen,
    onpins,
    onnewcompany,
  }: Props = $props();

  let query = $state("");
  /** Company waiting for the user to pick which pinned tile it replaces. */
  let replacing = $state<MoreCompany | null>(null);

  const sections = $derived(
    moreCompaniesSections(companies, pinnedIds, recentIds, query),
  );
  const replaceTargets = $derived(
    pinnedIds
      .map((id) => companies.find((company) => company.uid === id))
      .filter((company): company is MoreCompany => Boolean(company)),
  );


  function open(company: MoreCompany): void {
    onopen?.(company);
  }

  function togglePin(company: MoreCompany, pinned: boolean): void {
    if (pinned) {
      onpins?.(unpinCompany(pinnedIds, company.uid));
      return;
    }
    const result = pinCompany(pinnedIds, company.uid);
    if (result.status === "pinned") onpins?.(result.ids);
    else if (result.status === "replace") replacing = company;
  }

  function chooseReplacement(remove: MoreCompany): void {
    if (!replacing) return;
    onpins?.(replacePinnedCompany(pinnedIds, remove.uid, replacing.uid));
    replacing = null;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (replacing) replacing = null;
      else onclose?.();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<button type="button" class="scrim" data-testid="more-companies-scrim" aria-label="Close" onclick={() => onclose?.()}></button>
<div
  class="popover"
  role="dialog"
  tabindex="-1"
  aria-label="More companies"
  data-testid="more-companies-popover"
  use:focusReturn
  style:top="{anchorTop}px"
  style:left="{anchorLeft}px"
>
  <input
    class="search"
    type="search"
    placeholder="Switch company…"
    aria-label="Switch company"
    bind:value={query}
    autocomplete="off"
  />

  {#if replacing}
    <div class="sec">Replace a pinned tile</div>
    <p class="hint">The rail holds six. Pick the company {replacing.name} replaces.</p>
    <div class="list" data-testid="more-replace-list">
      {#each replaceTargets as company (company.uid)}
        <button type="button" class="row" onclick={() => chooseReplacement(company)}>
          <span class="name"
            ><CompanyLabel name={company.name} iconUrl={company.iconUrl} companyUid={company.uid} size={16} /></span
          >
        </button>
      {/each}
    </div>
    <div class="foot">
      <button type="button" class="row" onclick={() => (replacing = null)}><RailIcon name="x" />Cancel</button>
    </div>
  {:else}
    <div class="list" data-testid="more-companies-list">
      {#if sections.pinned.length > 0}
        <div class="sec">Pinned · {sections.pinnedCount} of {sections.pinLimit}</div>
        {#each sections.pinned as company (company.uid)}
          {@render companyRow(company, true)}
        {/each}
      {/if}
      {#if sections.recent.length > 0}
        <div class="sec">Recent</div>
        {#each sections.recent as company (company.uid)}
          {@render companyRow(company, false)}
        {/each}
      {/if}
      <div class="sec">All · {sections.matchCount}</div>
      {#if sections.all.length === 0 && sections.pinned.length === 0 && sections.recent.length === 0}
        <p class="hint">No companies match.</p>
      {/if}
      {#each sections.all as company (company.uid)}
        {@render companyRow(company, false)}
      {/each}
    </div>
    <div class="foot">
      <button type="button" class="row" data-testid="more-new-company" onclick={() => onnewcompany?.()}>
        <span class="mark" aria-hidden="true"><RailIcon name="plus" /></span>
        <span class="name">New company</span>
      </button>
    </div>
  {/if}
</div>

{#snippet companyRow(company: MoreCompany, pinned: boolean)}
  {#if company.localOnly}
    <div class="row-wrap local" data-testid="more-local-company">
      <div class="row">
        <span class="name"
          ><CompanyLabel name={company.name} iconUrl={null} size={16} /></span
        >
        <span class="local-tag">Local, not synced</span>
      </div>
    </div>
  {:else}
  <div class="row-wrap">
    <button type="button" class="row" onclick={() => open(company)}>
      <span class="name"
        ><CompanyLabel name={company.name} iconUrl={company.iconUrl} companyUid={company.uid} size={16} /></span
      >
      {#if company.liveCount > 0}
        <span class="live"><i></i>{company.liveCount}</span>
      {/if}
    </button>
    <button
      type="button"
      class="pin"
      aria-label={pinned ? `Unpin ${company.name}` : `Pin ${company.name}`}
      onclick={() => togglePin(company, pinned)}
    >{pinned ? "unpin" : "pin"}</button>
  </div>
  {/if}
{/snippet}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  .popover {
    position: fixed;
    z-index: 41;
    width: 320px;
    max-height: min(480px, calc(100vh - 24px));
    display: flex;
    flex-direction: column;
    padding: 8px;
    border-radius: var(--v4-radius-popover, 8px);
    background: var(--overlay-bg);
    color: var(--v4-text-1);
    border: 1px solid var(--v4-hairline);
    box-shadow: var(--v4-shadow-popover);
    font-family: var(--font-ui);
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    height: 32px;
    margin: 0 0 6px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--v4-hairline);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font: 13px/1 var(--font-ui);
  }

  .search::placeholder {
    color: var(--v4-text-3);
  }

  .list {
    overflow: auto;
    min-height: 0;
    overscroll-behavior: contain;
  }

  .sec {
    padding: 8px 8px 4px;
    font: 500 13px/1.2 var(--font-ui);
    color: var(--v4-text-2);
  }

  .hint {
    margin: 0;
    padding: 4px 8px 8px;
    font: 13px/1.4 var(--font-ui);
    color: var(--v4-text-3);
  }

  .row-wrap {
    display: flex;
    align-items: center;
    border-radius: 8px;
  }

  .row-wrap:hover,
  .row-wrap:focus-within {
    background: var(--v4-active-row);
  }

  .row {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: default;
    font: 13px/1 var(--font-ui);
  }

  .row-wrap .row:hover {
    background: transparent;
  }

  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mark {
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font: 500 10px/1 var(--font-ui);
  }

  .live {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--v4-text-2);
    font: 13px/1 var(--font-ui);
  }

  .live i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }

  .pin {
    flex: 0 0 auto;
    margin-right: 6px;
    padding: 2px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-3);
    font: 13px/1 var(--font-ui);
    opacity: 0;
    cursor: default;
  }

  .row-wrap:hover .pin,
  .row-wrap:focus-within .pin,
  .pin:focus-visible {
    opacity: 1;
  }

  .local-tag {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font: 13px/1 var(--font-ui);
  }

  .foot {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--v4-hairline);
  }

  .list .row-wrap {
    content-visibility: auto;
    contain-intrinsic-size: 32px;
  }
</style>
