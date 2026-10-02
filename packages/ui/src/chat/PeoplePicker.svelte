<script lang="ts">
  import {
    filterPickerEntries,
    groupPickerEntries,
    type PeoplePickerEntry,
  } from "./people-picker.js";

  let {
    entries,
    selected = [],
    query = $bindable(""),
    companyUid = null,
    onToggle,
  }: {
    entries: readonly PeoplePickerEntry[];
    selected?: readonly string[];
    query?: string;
    companyUid?: string | null;
    onToggle: (entry: PeoplePickerEntry) => void;
  } = $props();

  const visible = $derived(filterPickerEntries(entries, query, companyUid));
  const sections = $derived(groupPickerEntries(visible));
  const selectedEntries = $derived(
    entries.filter((entry) => selected.includes(entry.id)),
  );

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "•";
  }
</script>

<div class="pp" data-testid="people-picker">
  {#if selectedEntries.length > 0}
    <div class="pp-sel">
      {#each selectedEntries as entry (entry.id)}
        <button
          type="button"
          class="chip"
          data-testid="people-picker-chip"
          onclick={() => onToggle(entry)}
        >
          <span class="mini" class:sq={entry.kind === "agent"} class:grp={entry.kind === "group"}>{initials(entry.name)}</span>
          {entry.name}
          <span class="x" aria-hidden="true">✕</span>
        </button>
      {/each}
      <span class="pp-n">{selectedEntries.length}</span>
    </div>
  {/if}
  <label class="pp-q">
    <input
      type="text"
      placeholder="Search people, groups, bots…"
      bind:value={query}
      data-testid="people-picker-query"
    />
  </label>
  <div class="pp-list" data-testid="people-picker-list">
    {#each sections as section (section.kind)}
      <div class="sec">{section.label}</div>
      {#each section.rows as entry (entry.id)}
        <button
          type="button"
          class="pp-li"
          role="checkbox"
          aria-checked={selected.includes(entry.id)}
          data-testid="people-picker-row"
          data-kind={entry.kind}
          data-id={entry.id}
          onclick={() => onToggle(entry)}
        >
          <i aria-hidden="true">{selected.includes(entry.id) ? "✓" : ""}</i>
          <span class="mini" class:sq={entry.kind === "agent"} class:grp={entry.kind === "group"}>{initials(entry.name)}</span>
          <span class="who">
            <b>{entry.name}</b>
            {#if entry.detail}<span class="m">{entry.detail}</span>{/if}
          </span>
          {#if entry.meta}
            <span class="rt" class:live={entry.live}>{entry.meta}</span>
          {/if}
        </button>
      {/each}
    {:else}
      <p class="empty">No matches</p>
    {/each}
  </div>
</div>

<style>
  .pp {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--panel-border, var(--v4-hairline));
    border-radius: 8px;
    background: var(--panel-bg, var(--v4-popover));
    color: var(--t1, var(--v4-text-1));
    font-size: 13px;
  }
  .pp-sel {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--panel-border, var(--v4-rowline));
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 6px 0 2px;
    border: 0;
    border-radius: 6px;
    background: var(--hover, var(--v4-control-bg));
    color: var(--t1, var(--v4-text-1));
    font-size: 13px;
  }
  .x { color: var(--t3, var(--v4-text-3)); }
  .pp-n { margin-left: auto; align-self: center; font-size: 13px; color: var(--t3, var(--v4-text-3)); }
  .pp-q { display: block; margin: 8px 10px 2px; }
  .pp-q input {
    width: 100%;
    height: 28px;
    border: 1px solid var(--panel-border, var(--v4-control-border));
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0 8px;
  }
  .pp-list { overflow: auto; max-height: 240px; padding: 0 6px 6px; }
  .sec {
    padding: 10px 6px 2px;
    font-size: 13px;
    font-weight: 500;
    color: var(--t2, var(--v4-text-2));
  }
  .pp-li {
    display: grid;
    grid-template-columns: 14px 18px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 5px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
  }
  .pp-li:hover { background: var(--hover, var(--v4-hover)); }
  .pp-li[aria-checked="true"] {
    background: var(--v4-active-row, var(--hover));
    color: var(--t1, var(--v4-text-1));
  }
  .pp-li i {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid var(--panel-border, var(--v4-control-border));
    display: grid;
    place-items: center;
    font-size: 10px;
    font-style: normal;
  }
  .pp-li[aria-checked="true"] i {
    background: var(--t1, var(--v4-text-1));
    color: var(--panel-bg, var(--v4-popover));
    border-color: transparent;
  }
  .mini {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 8px;
    background: var(--hover, var(--v4-control-bg));
    color: var(--t1, var(--v4-text-1));
  }
  .mini.sq, .mini.grp { border-radius: 4px; }
  .who { min-width: 0; }
  .who b { font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .m {
    display: block;
    font-size: 13px;
    color: var(--t3, var(--v4-text-3));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rt { font-size: 13px; color: var(--t3, var(--v4-text-3)); }
  .rt.live { color: var(--ok, var(--v4-ok)); }
  .empty { padding: 12px 8px; color: var(--t3, var(--v4-text-3)); font-size: 13px; }
</style>
