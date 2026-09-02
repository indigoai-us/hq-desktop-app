<script lang="ts">
  /**
   * The `/` discovery picker — HQ workers, HQ skills and the CLI's own
   * commands, in one popover over the composer.
   *
   * Groups: **All** (every group, sectioned), **Recent** (the last eight
   * picks), **Workers** (pick one to see its skills; pick a skill to insert
   * `/run {worker} {skill} `), **Skills** (by scope — the selected company
   * first, then Personal, Core, Packages — with a tag row), and **CLI** (what
   * the CLI announced that HQ does not already name: `/compact`, `/model`…).
   *
   * The composer's draft IS the search: the query prop is the text after the
   * `/`, and the search box mirrors it both ways. Keyboard handling is
   * exported (`handleKey`) so the composer's textarea can drive Up / Down /
   * Enter / Tab / Escape without losing the caret.
   *
   * Cheap by construction: every list is a pure function of the props (see
   * `slash-commands.ts`), no group paints more than `PICKER_PAGE` rows until
   * its "more…" is pressed, and the catalog itself is cached by the store.
   */
  import { tick } from 'svelte';
  import type { SessionCommand } from './session-events';
  import {
    PICKER_PAGE,
    cliRows,
    filterRows,
    groupByScope,
    recentRows,
    scopeLabel,
    skillRows,
    tagUnion,
    workerRows,
    workerSkillRows,
    type PickerGroup,
    type PickerRow,
    type RecentSlash,
    type SkillCatalog,
    type WorkerEntry,
  } from './slash-commands';

  type Tab = 'all' | PickerGroup;

  interface Section {
    key: string;
    label: string;
    rows: PickerRow[];
    /** Rows hidden behind "more…". */
    hidden: number;
    group: PickerGroup;
  }

  interface Props {
    /** What follows the `/` in the draft. */
    query: string;
    catalog: SkillCatalog | null;
    catalogLoading?: boolean;
    catalogError?: string;
    /** The CLI's own announced commands. */
    cliCommands?: SessionCommand[];
    company?: string | null;
    recent?: RecentSlash[];
    onpick?: (row: PickerRow) => void;
    onquery?: (query: string) => void;
    onclose?: () => void;
  }

  let {
    query,
    catalog,
    catalogLoading = false,
    catalogError = '',
    cliCommands = [],
    company = null,
    recent = [],
    onpick,
    onquery,
    onclose,
  }: Props = $props();

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'recent', label: 'Recent' },
    { id: 'workers', label: 'Workers' },
    { id: 'skills', label: 'Skills' },
    { id: 'cli', label: 'CLI' },
  ];

  let tab = $state<Tab>('all');
  let highlighted = $state(0);
  let drilled = $state<WorkerEntry | null>(null);
  let tag = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  let list = $state<HTMLElement | null>(null);

  const BACK_ROW: PickerRow = {
    id: 'back',
    name: '← Workers',
    description: 'Back to every worker',
    insert: '',
    group: 'workers',
    tags: [],
  };

  const allRecent = $derived(recentRows(recent));
  const allWorkers = $derived(workerRows(catalog));
  const allSkills = $derived(skillRows(catalog, company));
  const allCli = $derived(cliRows(cliCommands, catalog));

  /** The tag row for the Skills tab: the union across the rows the query left. */
  const skillTags = $derived(tagUnion(filterRows(allSkills, query)));

  function capped(key: string, rows: PickerRow[]): { rows: PickerRow[]; hidden: number } {
    if (expanded[key] || rows.length <= PICKER_PAGE) return { rows, hidden: 0 };
    return { rows: rows.slice(0, PICKER_PAGE), hidden: rows.length - PICKER_PAGE };
  }

  function section(key: string, label: string, group: PickerGroup, rows: PickerRow[]): Section {
    const cut = capped(key, rows);
    return { key, label, group, rows: cut.rows, hidden: cut.hidden };
  }

  const sections = $derived.by((): Section[] => {
    if (drilled) {
      const rows = [BACK_ROW, ...filterRows(workerSkillRows(drilled), query)];
      return [section('drill', drilled.name || drilled.id, 'workers', rows)];
    }
    const out: Section[] = [];
    const want = (group: PickerGroup) => tab === 'all' || tab === group;
    if (want('recent')) {
      const rows = filterRows(allRecent, query);
      if (rows.length > 0 || tab === 'recent') out.push(section('recent', 'Recent', 'recent', rows));
    }
    if (want('workers')) {
      const rows = filterRows(allWorkers, query);
      if (rows.length > 0 || tab === 'workers') out.push(section('workers', 'Workers', 'workers', rows));
    }
    if (want('skills')) {
      let rows = filterRows(allSkills, query);
      if (tab === 'skills' && tag) rows = rows.filter((row) => row.tags.includes(tag!));
      if (tab === 'skills') {
        for (const scoped of groupByScope(rows, company)) {
          out.push(section(`skills:${scoped.scope}`, scoped.label, 'skills', scoped.rows));
        }
        if (rows.length === 0) out.push(section('skills', 'Skills', 'skills', []));
      } else if (rows.length > 0) {
        out.push(section('skills', 'Skills', 'skills', rows));
      }
    }
    if (want('cli')) {
      const rows = filterRows(allCli, query);
      if (rows.length > 0 || tab === 'cli') out.push(section('cli', 'CLI commands', 'cli', rows));
    }
    return out;
  });

  /** Every visible row in paint order — what Up / Down walk. */
  const flat = $derived(sections.flatMap((entry) => entry.rows));
  const index = $derived(
    flat.length === 0 ? 0 : Math.min(Math.max(highlighted, 0), flat.length - 1),
  );
  const empty = $derived(flat.length === 0);

  // A new query, tab or drill resets the highlight to the best match.
  let lastKey = $state('');
  $effect(() => {
    const key = `${query} ${tab} ${drilled?.id ?? ''} ${tag ?? ''}`;
    if (key === lastKey) return;
    lastKey = key;
    highlighted = 0;
  });

  // Keep the highlighted row on screen as the keyboard walks the list.
  $effect(() => {
    void index;
    void tick().then(() => {
      const el = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    });
  });

  function choose(row: PickerRow) {
    if (row.id === 'back') {
      drilled = null;
      return;
    }
    if (row.insert === '' && row.workerId) {
      drilled = catalog?.workers.find((worker) => worker.id === row.workerId) ?? null;
      return;
    }
    onpick?.(row);
  }

  /**
   * The composer forwards its textarea's keydown here first. Returns true
   * when the key was consumed, so the textarea does not also act on it.
   */
  export function handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowDown') {
      if (flat.length > 0) highlighted = (index + 1) % flat.length;
      return true;
    }
    if (event.key === 'ArrowUp') {
      if (flat.length > 0) highlighted = (index - 1 + flat.length) % flat.length;
      return true;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      const row = flat[index];
      if (row) choose(row);
      return true;
    }
    if (event.key === 'Escape') {
      if (drilled) {
        drilled = null;
      } else {
        onclose?.();
      }
      return true;
    }
    if (event.key === 'ArrowLeft' && drilled && !query) {
      drilled = null;
      return true;
    }
    return false;
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      if (handleKey(event)) event.preventDefault();
    }
  }

  function pickTab(next: Tab) {
    tab = next;
    drilled = null;
    tag = null;
  }

  function flatIndexOf(row: PickerRow): number {
    return flat.indexOf(row);
  }
</script>

<div
  class="slash-picker"
  role="dialog"
  tabindex="-1"
  aria-label="Slash commands"
  data-testid="session-slash-menu"
  onmousedown={(event) => {
    // Keep the caret in the textarea unless the search box itself was hit.
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  }}
>
  <div class="head">
    <input
      class="search"
      type="text"
      value={query}
      placeholder="Search skills, workers, commands…"
      aria-label="Search commands"
      data-testid="session-slash-search"
      oninput={(event) => onquery?.((event.currentTarget as HTMLInputElement).value)}
      onkeydown={onSearchKeydown}
    />
    <div class="tabs" role="tablist" data-testid="session-slash-tabs">
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          role="tab"
          class="tab"
          class:active={tab === entry.id}
          aria-selected={tab === entry.id}
          data-testid={`session-slash-tab-${entry.id}`}
          onclick={() => pickTab(entry.id)}
        >
          {entry.label}
        </button>
      {/each}
    </div>
  </div>

  {#if tab === 'skills' && !drilled && skillTags.length > 0}
    <div class="tags" data-testid="session-slash-tags">
      {#each skillTags as entry (entry)}
        <button
          type="button"
          class="tag"
          class:active={tag === entry}
          aria-pressed={tag === entry}
          data-testid="session-slash-tag"
          onclick={() => (tag = tag === entry ? null : entry)}
        >
          {entry}
        </button>
      {/each}
    </div>
  {/if}

  <div class="list" role="listbox" aria-label="Commands" bind:this={list}>
    {#if catalogLoading && !catalog}
      <p class="note" data-testid="session-slash-loading">Loading HQ skills…</p>
    {/if}
    {#if catalogError}
      <p class="note error" data-testid="session-slash-error">{catalogError}</p>
    {/if}
    {#each sections as entry (entry.key)}
      <div class="section" data-testid="session-slash-section" data-group={entry.group}>
        {#if drilled || tab === 'all' || tab === 'skills'}
          <div class="section-label">{entry.label}</div>
        {/if}
        {#if entry.rows.length === 0}
          <p class="note" data-testid="session-slash-empty-group">Nothing here yet.</p>
        {/if}
        {#each entry.rows as row (row.id)}
          {@const at = flatIndexOf(row)}
          <button
            type="button"
            role="option"
            class="row"
            class:highlighted={at === index}
            aria-selected={at === index}
            data-testid="session-slash-item"
            data-group={row.group}
            data-insert={row.insert}
            onmouseenter={() => (highlighted = at)}
            onclick={() => choose(row)}
          >
            <span class="name">{row.name}</span>
            {#if row.insert === '' && row.workerId}
              <span class="chev" aria-hidden="true">›</span>
            {/if}
            {#if row.description}
              <span class="description">{row.description}</span>
            {/if}
            {#if tab === 'all' && row.scope}
              <span class="scope">{scopeLabel(row.scope)}</span>
            {/if}
          </button>
        {/each}
        {#if entry.hidden > 0}
          <button
            type="button"
            class="more"
            data-testid="session-slash-more"
            onclick={() => (expanded = { ...expanded, [entry.key]: true })}
          >
            {entry.hidden} more…
          </button>
        {/if}
      </div>
    {/each}
    {#if empty && !catalogLoading}
      <p class="note" data-testid="session-slash-empty">No commands match.</p>
    {/if}
  </div>
</div>

<style>
  .slash-picker {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    max-height: 360px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
    font-family: var(--font-sans);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 6px 4px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    outline: none;
  }

  .search:focus {
    border-color: var(--v4-control-border, var(--v4-hairline));
  }

  .tabs {
    display: flex;
    gap: 2px;
  }

  .tab {
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .tab:hover {
    color: var(--v4-text-1);
  }

  .tab.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .tag {
    height: 20px;
    padding: 0 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 10px;
    cursor: pointer;
  }

  .tag.active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
  }

  .section + .section {
    margin-top: 4px;
  }

  .section-label {
    padding: 4px 8px 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: var(--v4-space-2);
    width: 100%;
    padding: 5px var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .row.highlighted {
    background: var(--v4-active-row);
  }

  .name {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .chev {
    flex: none;
    color: var(--v4-text-3);
  }

  .description {
    min-width: 0;
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope {
    flex: none;
    margin-left: auto;
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: 10px;
    line-height: 1.4;
  }

  .more {
    width: 100%;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .more:hover {
    color: var(--v4-text-1);
  }

  .note {
    margin: 0;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .note.error {
    color: var(--v4-error, var(--v4-text-2));
  }
</style>
