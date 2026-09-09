<script lang="ts">
  import { tick } from 'svelte';
  import {
    PICKER_PAGE,
    filterRows,
    filterSkillRows,
    groupOptions,
    skillRows,
    tagUnion,
    workerRows,
    type PickerRow,
    type SkillCatalog,
  } from './slash-commands';

  type Tab = 'skills' | 'workers';

  interface Props {
    query: string;
    catalog: SkillCatalog | null;
    catalogLoading?: boolean;
    catalogError?: string;
    company?: string | null;
    groupMetadataAvailable?: boolean;
    onpick?: (row: PickerRow) => void;
    onquery?: (query: string) => void;
    onclose?: () => void;
  }

  let {
    query,
    catalog,
    catalogLoading = false,
    catalogError = '',
    company = null,
    groupMetadataAvailable = true,
    onpick,
    onquery,
    onclose,
  }: Props = $props();

  let tab = $state<Tab>('skills');
  let group = $state('');
  let tag = $state('');
  let highlighted = $state(0);
  let expanded = $state(false);
  let list = $state<HTMLElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);

  const skills = $derived(skillRows(catalog, company));
  const workers = $derived(workerRows(catalog));
  const groups = $derived(groupOptions(skills));
  const useCloudTaxonomy = $derived(
    groupMetadataAvailable && Boolean(company) && skills.some((row) => row.cloudTags !== undefined),
  );
  const tagRows = $derived(
    useCloudTaxonomy ? skills.filter((row) => row.scope === `company:${company}`) : skills,
  );
  const tags = $derived(tagUnion(tagRows, 24, useCloudTaxonomy));
  const filtered = $derived(
    tab === 'skills'
      ? filterSkillRows(skills, query, group || null, tag || null, useCloudTaxonomy)
      : filterRows(workers, query),
  );
  const visible = $derived(expanded ? filtered : filtered.slice(0, PICKER_PAGE));
  const hidden = $derived(Math.max(0, filtered.length - visible.length));
  const index = $derived(
    visible.length === 0 ? 0 : Math.min(Math.max(highlighted, 0), visible.length - 1),
  );
  const filtersActive = $derived(Boolean(group || tag));

  $effect(() => {
    if (
      !groupMetadataAvailable ||
      (group && group !== 'company-wide' && !groups.some((option) => option.id === group))
    ) {
      group = '';
    }
    if (tag && !tags.includes(tag)) tag = '';
  });

  let lastKey = $state('');
  $effect(() => {
    const key = `${query}\n${tab}\n${group ?? ''}\n${tag ?? ''}`;
    if (key === lastKey) return;
    lastKey = key;
    highlighted = 0;
    expanded = false;
  });

  $effect(() => {
    void index;
    void tick().then(() =>
      list
        ?.querySelector<HTMLElement>('[data-highlighted="true"]')
        ?.scrollIntoView?.({ block: 'nearest' }),
    );
  });

  $effect(() => {
    const el = search;
    if (!el) return;
    void tick().then(() => {
      el.focus?.({ preventScroll: true });
      el.setSelectionRange?.(el.value.length, el.value.length);
    });
  });

  function pickTab(next: Tab) {
    tab = next;
    group = '';
    tag = '';
  }

  function clearFilters() {
    group = '';
    tag = '';
  }

  export function handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowDown') {
      if (visible.length) highlighted = (index + 1) % visible.length;
      return true;
    }
    if (event.key === 'ArrowUp') {
      if (visible.length) highlighted = (index - 1 + visible.length) % visible.length;
      return true;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      const row = visible[index];
      if (row) onpick?.(row);
      return true;
    }
    if (event.key === 'Escape') {
      onclose?.();
      return true;
    }
    return false;
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (
      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) &&
      handleKey(event)
    ) {
      event.preventDefault();
    }
  }
</script>

<div
  class="slash-picker"
  role="dialog"
  tabindex="-1"
  aria-label="Skills and workers"
  data-testid="session-slash-menu"
  onmousedown={(event) => {
    if (
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLSelectElement)
    ) {
      event.preventDefault();
    }
  }}
>
  <div class="head">
    <div class="search-wrap">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r="4.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
        />
        <path
          d="m10.5 10.5 3 3"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
      <input
        bind:this={search}
        class="search"
        type="text"
        value={query}
        placeholder={tab === 'skills' ? 'Search skills' : 'Search workers'}
        aria-label="Search skills and workers"
        autocomplete="off"
        spellcheck="false"
        data-testid="session-slash-search"
        oninput={(event) => onquery?.((event.currentTarget as HTMLInputElement).value)}
        onkeydown={onSearchKeydown}
      />
    </div>
    <div class="tabs" role="tablist" data-testid="session-slash-tabs">
      <button
        type="button"
        role="tab"
        class:active={tab === 'skills'}
        aria-selected={tab === 'skills'}
        data-testid="session-slash-tab-skills"
        onclick={() => pickTab('skills')}>Skills</button
      >
      <button
        type="button"
        role="tab"
        class:active={tab === 'workers'}
        aria-selected={tab === 'workers'}
        data-testid="session-slash-tab-workers"
        onclick={() => pickTab('workers')}>Workers</button
      >
    </div>
  </div>

  {#if tab === 'skills' && skills.length > 0}
    <div class="filters" data-testid="session-slash-filters">
      <label>
        <span class="sr-only">Group</span>
        <select
          value={group}
          onchange={(event) => (group = event.currentTarget.value)}
          disabled={!groupMetadataAvailable}
          data-testid="session-slash-group"
        >
          <option value="">All groups</option>
          <option value="company-wide">Company-wide</option>
          {#each groups as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="sr-only">Tag</span>
        <select
          value={tag}
          onchange={(event) => (tag = event.currentTarget.value)}
          data-testid="session-slash-tag-filter"
        >
          <option value="">All tags</option>
          {#each tags as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </label>
      {#if filtersActive}
        <button
          type="button"
          class="clear"
          data-testid="session-slash-clear"
          onclick={clearFilters}>Clear</button
        >
      {/if}
    </div>
    {#if !groupMetadataAvailable}
      <p class="metadata-note" data-testid="session-slash-metadata-note">
        Groups unavailable offline. Local skills still work.
      </p>
    {/if}
  {/if}

  <div
    class="list"
    role="listbox"
    aria-label={tab === 'skills' ? 'Skills' : 'Workers'}
    bind:this={list}
  >
    {#if catalogLoading && !catalog}
      <p class="note" data-testid="session-slash-loading">Loading skills and workers…</p>
    {/if}
    {#if catalogError}
      <p class="note error" data-testid="session-slash-error">{catalogError}</p>
    {/if}
    {#each visible as row, at (row.id)}
      <button
        type="button"
        role="option"
        class="row"
        class:highlighted={at === index}
        aria-selected={at === index}
        data-highlighted={at === index}
        data-testid="session-slash-item"
        data-kind={tab === 'skills' ? 'skill' : 'worker'}
        onclick={() => onpick?.(row)}
        onmouseenter={() => (highlighted = at)}
      >
        <span class={`kind ${tab === 'skills' ? 'skill' : 'worker'}`}>
          {tab === 'skills' ? 'Skill' : 'Worker'}
        </span>
        <span class="copy">
          <span class="name">{row.route?.label ?? row.name}</span>
          {#if row.description}<span class="description">{row.description}</span>{/if}
        </span>
        {#if tab === 'skills' && row.scope}
          <span class="scope">
            {row.groupName ??
              (row.companyWide ? 'Company-wide' : row.scope.replace('company:', ''))}
          </span>
        {/if}
        {#if at === index}<span class="enter" aria-hidden="true">↵</span>{/if}
      </button>
    {/each}
    {#if hidden > 0}
      <button
        type="button"
        class="more"
        data-testid="session-slash-more"
        onclick={() => (expanded = true)}>Show {hidden} more</button
      >
    {/if}
    {#if visible.length === 0 && !catalogLoading}
      <p class="note" data-testid="session-slash-empty">No {tab} match.</p>
    {/if}
  </div>
  <div class="foot" aria-hidden="true">
    <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
    <span><kbd>↵</kbd> select</span>
    <span><kbd>esc</kbd> close</span>
  </div>
</div>

<style>
  .slash-picker {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    max-height: 440px;
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    /* Transcript text must never bleed through a command surface. */
    background: var(--v4-surface-solid, #242424);
    box-shadow: var(--v4-shadow-popover, 0 16px 44px rgb(0 0 0 / 0.16));
    font-family: var(--font-sans);
    font-size: 13px;
  }

  .head {
    padding: 10px 10px 0;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .search-wrap {
    position: relative;
    color: var(--v4-text-3);
  }

  .search-wrap svg {
    position: absolute;
    left: 10px;
    top: 9px;
  }

  .search {
    box-sizing: border-box;
    width: 100%;
    height: 32px;
    padding: 0 10px 0 32px;
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    outline: none;
    background: var(--v4-control-faint, var(--v4-inset));
    color: var(--v4-text-1);
    font: inherit;
  }

  .search:focus {
    border-color: color-mix(in srgb, var(--v4-text-1) 28%, var(--v4-hairline));
    box-shadow: none;
  }

  .tabs {
    display: flex;
    gap: 18px;
    margin-top: 7px;
  }

  .tabs button {
    position: relative;
    padding: 7px 2px 9px;
    border: 0;
    background: none;
    color: var(--v4-text-3);
    font: 500 13px/1 var(--font-sans);
  }

  .tabs button.active {
    color: var(--v4-text-1);
  }

  .tabs button.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: var(--v4-text-1);
  }

  .filters {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 10px 6px;
  }

  select {
    max-width: 180px;
    height: 28px;
    padding: 0 26px 0 9px;
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    background: var(--v4-control-faint, var(--v4-inset));
    color: var(--v4-text-2);
    font: inherit;
  }

  select:disabled {
    opacity: 0.5;
  }

  .clear {
    margin-left: auto;
    border: 0;
    background: none;
    color: var(--v4-text-2);
    font: 500 12px var(--font-sans);
  }

  .metadata-note {
    margin: 0;
    padding: 0 11px 7px;
    color: var(--v4-text-3);
    font-size: 12px;
  }

  .list {
    min-height: 54px;
    overflow: auto;
    padding: 6px;
  }

  .row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 48px;
    padding: 7px 9px;
    border: 0;
    background: transparent;
    color: var(--v4-text-1);
    text-align: left;
    font: inherit;
  }

  .row.highlighted {
    background: var(--v4-selection, var(--v4-control-hover));
  }

  .kind {
    min-width: 49px;
    padding: 3px 6px;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-align: center;
    text-transform: uppercase;
  }

  .kind.skill {
    background: var(--v4-secondary-bg, rgb(255 255 255 / 0.08));
    color: var(--v4-text-1);
  }

  .kind.worker {
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    background: transparent;
    color: var(--v4-text-2);
  }

  .copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .name {
    overflow: hidden;
    color: var(--v4-text-1);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .description {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope {
    max-width: 120px;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .enter {
    color: var(--v4-text-3);
  }

  .more {
    width: 100%;
    padding: 8px;
    border: 0;
    background: none;
    color: var(--v4-text-2);
    font: 500 12px var(--font-sans);
  }

  .note {
    margin: 0;
    padding: 16px 10px;
    color: var(--v4-text-3);
  }

  .note.error {
    color: var(--v4-danger, #bd5656);
  }

  .foot {
    display: flex;
    gap: 16px;
    padding: 7px 10px;
    border-top: 1px solid var(--v4-hairline);
    color: var(--v4-text-3);
    font-size: 10px;
  }

  .foot span {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  kbd {
    font: 10px var(--font-sans);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
