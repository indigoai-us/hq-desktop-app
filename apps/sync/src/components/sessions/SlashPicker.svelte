<script lang="ts">
  /**
   * The `/` discovery picker — HQ workers, HQ skills and the CLI's own
   * commands, in one popover over the composer.
   *
   * Shape: a search box on top (focused the moment the picker opens, showing
   * whatever followed the `/`), a segmented header — **All · Recent ·
   * Workers · Skills · Commands** — and, for skills, a filter row of chips:
   * the four scopes (Company, Personal, Core, Packages) and then the union of
   * the catalog's tags. The row is visible on the All view too; picking a
   * chip there lands on the Skills tab so the narrowing is seen, not implied.
   *
   * Every row wears a **kind pill** so a worker, a worker skill, an HQ skill
   * and a bare CLI command are told apart at a glance — the same pill the
   * composer keeps above the draft once a row is picked. A worker row drills
   * into that worker's skills under a back link; a skill inserts
   * `/run {worker} {skill} `.
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
    SCOPE_FILTERS,
    cliRows,
    filterRows,
    groupByScope,
    kindLabel,
    recentRows,
    rowKind,
    scopeFilterMatches,
    scopeLabel,
    skillRows,
    tagUnion,
    workerRows,
    workerSkillRows,
    type PickerGroup,
    type PickerRow,
    type RecentSlash,
    type ScopeFilter,
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
    /** Take the caret into the search box on open. */
    autofocus?: boolean;
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
    autofocus = true,
    onpick,
    onquery,
    onclose,
  }: Props = $props();

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'recent', label: 'Recent' },
    { id: 'workers', label: 'Workers' },
    { id: 'skills', label: 'Skills' },
    { id: 'cli', label: 'Commands' },
  ];

  let tab = $state<Tab>('all');
  let highlighted = $state(0);
  let drilled = $state<WorkerEntry | null>(null);
  let scope = $state<ScopeFilter | null>(null);
  let tag = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  let list = $state<HTMLElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);

  const allRecent = $derived(recentRows(recent));
  const allWorkers = $derived(workerRows(catalog));
  const allSkills = $derived(skillRows(catalog, company));
  const allCli = $derived(cliRows(cliCommands, catalog));

  /** Skills after the query and the scope chip — what the tag row is built from. */
  const scopedSkills = $derived(
    filterRows(allSkills, query).filter((row) => scopeFilterMatches(row, scope)),
  );
  /** Skills after the tag chip too — what the Skills section(s) paint. */
  const narrowedSkills = $derived(
    tag ? scopedSkills.filter((row) => row.tags.includes(tag!)) : scopedSkills,
  );
  const skillTags = $derived.by(() => {
    const available = tagUnion(scopedSkills);
    // Keep the active tag visible when a newly-selected scope has no rows
    // carrying it. Otherwise the empty state also removes the control needed
    // to relax the filter.
    return tag && !available.includes(tag) ? [...available, tag] : available;
  });
  /** The filter row shows wherever skills are being listed. */
  const filtersVisible = $derived(!drilled && (tab === 'all' || tab === 'skills') && allSkills.length > 0);
  const companyChipLabel = $derived(company ? scopeLabel(`company:${company}`) : 'Company');

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
      const rows = filterRows(workerSkillRows(drilled), query);
      return [section('drill', 'Skills', 'workers', rows)];
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
      const rows = narrowedSkills;
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
      if (rows.length > 0 || tab === 'cli') out.push(section('cli', 'Commands', 'cli', rows));
    }
    return out;
  });

  /** Every visible row in paint order — what Up / Down walk. */
  const flat = $derived(sections.flatMap((entry) => entry.rows));
  const index = $derived(
    flat.length === 0 ? 0 : Math.min(Math.max(highlighted, 0), flat.length - 1),
  );
  const empty = $derived(flat.length === 0);
  /** Which section labels are worth painting: the overview and the scoped Skills tab. */
  const labelled = $derived(tab === 'all' || tab === 'skills');

  // A new query, tab, chip or drill resets the highlight to the best match.
  let lastKey = $state('');
  $effect(() => {
    const key = `${query} ${tab} ${drilled?.id ?? ''} ${scope ?? ''} ${tag ?? ''}`;
    if (key === lastKey) return;
    lastKey = key;
    highlighted = 0;
  });

  // Keep the highlighted row on screen as the keyboard walks the list.
  $effect(() => {
    void index;
    void tick().then(() => {
      const el = list?.querySelector<HTMLElement>('[data-highlighted="true"]');
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    });
  });

  // The search box takes the caret on open, with the query already in it.
  $effect(() => {
    if (!autofocus) return;
    const el = search;
    if (!el) return;
    void tick().then(() => {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      const end = el.value.length;
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(end, end);
    });
  });

  function choose(row: PickerRow) {
    if (row.insert === '' && row.workerId) {
      drilled = catalog?.workers.find((worker) => worker.id === row.workerId) ?? null;
      return;
    }
    onpick?.(row);
  }

  function back() {
    drilled = null;
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
        back();
      } else {
        onclose?.();
      }
      return true;
    }
    if (event.key === 'ArrowLeft' && drilled && !query) {
      back();
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
  }

  /** A scope chip narrows skills; from the overview it lands on the Skills tab. */
  function pickScope(next: ScopeFilter) {
    scope = scope === next ? null : next;
    if (tab === 'all' && scope) tab = 'skills';
  }

  function pickTag(next: string) {
    tag = tag === next ? null : next;
    if (tab === 'all' && tag) tab = 'skills';
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
    // Keep the caret where it is unless the search box itself was hit.
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  }}
>
  <div class="head">
    <div class="search-wrap">
      <span class="search-slash" aria-hidden="true">/</span>
      <input
        bind:this={search}
        class="search"
        type="text"
        value={query}
        placeholder="Search skills, workers, commands…"
        aria-label="Search commands"
        autocomplete="off"
        spellcheck="false"
        data-testid="session-slash-search"
        oninput={(event) => onquery?.((event.currentTarget as HTMLInputElement).value)}
        onkeydown={onSearchKeydown}
      />
    </div>
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

  {#if filtersVisible}
    <div class="filters" data-testid="session-slash-tags">
      {#each SCOPE_FILTERS as entry (entry.id)}
        <button
          type="button"
          class="chip scope-chip"
          class:active={scope === entry.id}
          aria-pressed={scope === entry.id}
          data-testid="session-slash-scope"
          data-scope={entry.id}
          onclick={() => pickScope(entry.id)}
        >
          {entry.id === 'company' ? companyChipLabel : entry.label}
        </button>
      {/each}
      {#if skillTags.length > 0}
        <span class="chip-rule" aria-hidden="true"></span>
      {/if}
      {#each skillTags as entry (entry)}
        <button
          type="button"
          class="chip"
          class:active={tag === entry}
          aria-pressed={tag === entry}
          data-testid="session-slash-tag"
          onclick={() => pickTag(entry)}
        >
          {entry}
        </button>
      {/each}
    </div>
  {/if}

  {#if drilled}
    <div class="drill-head" data-testid="session-slash-drill">
      <button type="button" class="back" data-testid="session-slash-back" onclick={back}>
        <span aria-hidden="true">‹</span> Workers
      </button>
      <span class="kind kind-worker">{kindLabel('worker')}</span>
      <span class="drill-name">{drilled.name || drilled.id}</span>
      {#if drilled.description}
        <span class="drill-description">{drilled.description}</span>
      {/if}
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
        {#if labelled && !drilled}
          <div class="section-label">{entry.label}</div>
        {/if}
        {#if entry.rows.length === 0}
          <p class="note" data-testid="session-slash-empty-group">Nothing here yet.</p>
        {/if}
        {#each entry.rows as row (row.id)}
          {@const at = flatIndexOf(row)}
          {@const kind = rowKind(row)}
          <button
            type="button"
            role="option"
            class="row"
            class:highlighted={at === index}
            aria-selected={at === index}
            data-highlighted={at === index}
            data-testid="session-slash-item"
            data-group={row.group}
            data-kind={kind}
            data-insert={row.insert}
            onmouseenter={() => (highlighted = at)}
            onclick={() => choose(row)}
          >
            <span class={`kind kind-${kind}`} data-testid="session-slash-kind">{kindLabel(kind)}</span>
            <span class="name">{row.name}</span>
            {#if kind === 'worker'}
              <span class="chev" aria-hidden="true">›</span>
            {/if}
            {#if row.description}
              <span class="description">{row.description}</span>
            {/if}
            {#if row.scope && tab !== 'skills'}
              <span class="scope">{scopeLabel(row.scope)}</span>
            {/if}
            {#if at === index}
              <span class="enter" aria-hidden="true">↵</span>
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

  <div class="foot" aria-hidden="true">
    <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
    <span><kbd>↵</kbd> pick</span>
    <span><kbd>⇥</kbd> complete</span>
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
    border-radius: var(--v4-radius-popover, 10px);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
    font-family: var(--font-sans);
  }

  /* --- head: search + segmented header ---------------------------------- */

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2) var(--v4-space-2) 0;
  }

  .search-wrap {
    position: relative;
  }

  .search-slash {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--v4-text-3);
    pointer-events: none;
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    height: 30px;
    padding: 0 10px 0 24px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-field);
    background: var(--v4-control-faint, var(--v4-inset));
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    outline: none;
  }

  .search::placeholder {
    color: var(--v4-text-3);
  }

  .search:focus {
    border-color: var(--v4-control-border, var(--v4-hairline));
    background: transparent;
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding-bottom: var(--v4-space-2);
    border-bottom: 1px solid var(--v4-hairline);
  }

  .tab {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .tab:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .tab.active {
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font-weight: 600;
  }

  /* --- the scope / tag filter row --------------------------------------- */

  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: var(--v4-space-2) var(--v4-space-2) 0;
  }

  .chip {
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
  }

  .chip:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .scope-chip {
    font-weight: 600;
  }

  .chip.active {
    background: var(--v4-primary-bg);
    border-color: transparent;
    color: var(--v4-primary-fg);
  }

  .chip-rule {
    width: 1px;
    height: 14px;
    margin: 0 3px;
    background: var(--v4-hairline);
  }

  /* --- worker drill-down header ----------------------------------------- */

  .drill-head {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    min-width: 0;
    padding: var(--v4-space-2) var(--v4-space-2) 0;
    font-size: var(--type-metadata);
  }

  .back {
    flex: none;
    height: 22px;
    padding: 0 8px 0 6px;
    border: 0;
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .back:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .drill-name {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--v4-text-1);
  }

  .drill-description {
    min-width: 0;
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* --- the list ---------------------------------------------------------- */

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--v4-space-2);
  }

  .section + .section {
    margin-top: var(--v4-space-2);
  }

  .section-label {
    padding: 0 var(--v4-space-2) 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    width: 100%;
    min-height: 30px;
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

  .row:hover {
    background: var(--v4-active-row);
  }

  /* The keyboard row is unmistakable: a filled surface, a hairline ring and
     the ↵ glyph at its end. */
  .row.highlighted {
    background: var(--v4-control-bg);
    box-shadow: inset 0 0 0 1px var(--v4-control-border, var(--v4-hairline));
  }

  /* --- kind pills --------------------------------------------------------- */

  .kind {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-pill);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
  }

  .kind-worker {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .kind-worker-skill {
    border-color: var(--v4-primary-bg);
    color: var(--v4-text-1);
  }

  .kind-skill {
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
  }

  .kind-cli {
    border-color: var(--v4-hairline);
    color: var(--v4-text-3);
  }

  .name {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }

  .chev {
    flex: none;
    color: var(--v4-text-3);
  }

  .description {
    flex: 1;
    min-width: 0;
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope {
    flex: none;
    margin-left: auto;
    font-size: 10px;
    color: var(--v4-text-3);
  }

  .enter {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    color: var(--v4-text-3);
  }

  .more {
    width: 100%;
    padding: 5px var(--v4-space-2);
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
    padding: 6px var(--v4-space-2);
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .note.error {
    color: var(--v4-error, var(--v4-text-2));
  }

  /* --- keyboard footer --------------------------------------------------- */

  .foot {
    display: flex;
    gap: var(--v4-space-3);
    padding: 5px var(--v4-space-3);
    border-top: 1px solid var(--v4-hairline);
    font-size: 10px;
    color: var(--v4-text-3);
  }

  kbd {
    display: inline-block;
    min-width: 12px;
    margin-right: 3px;
    padding: 0 3px;
    border: 1px solid var(--v4-hairline);
    border-radius: 3px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 9px;
    line-height: 13px;
    text-align: center;
  }
</style>
