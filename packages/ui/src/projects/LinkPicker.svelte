<script lang="ts">
  /**
   * LinkPicker — choose a goal or key result to link (storyboard link-picker).
   * A closed field shows the current link; opening it shows a search box and
   * goal sections with their KRs. Selection is a background highlight.
   */
  import Caret from "../common/Caret.svelte";
  import type { Objective } from "./local-projects.js";
  import { linkPickerOptions, type LinkPickerOption } from "./new-project.js";

  let {
    objectives,
    value = null,
    onchange,
  }: {
    objectives: readonly Objective[];
    value?: LinkPickerOption | null;
    onchange: (next: LinkPickerOption | null) => void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  const options = $derived(linkPickerOptions(objectives, query));

  function pick(option: LinkPickerOption | null): void {
    onchange(option);
    open = false;
    query = "";
  }
</script>

<div class="link-picker" data-testid="link-picker">
  <button
    type="button"
    class="field"
    aria-haspopup="listbox"
    aria-expanded={open}
    data-testid="link-picker-field"
    onclick={() => (open = !open)}
  >
    <span class="value" class:ph={!value}>{value ? `◎ ${value.label}` : "No goal"}</span>
    <span class="caret" aria-hidden="true"><Caret open={open} /></span>
  </button>
  {#if open}
    <div class="pick" role="listbox" aria-label="Link a goal">
      <input
        class="q"
        placeholder="Search goals and key results"
        bind:value={query}
        data-testid="link-picker-search"
      />
      <button type="button" class="row" role="option" aria-selected={!value} onclick={() => pick(null)}>
        No goal
      </button>
      {#each options as option (option.id)}
        <button
          type="button"
          class="row"
          class:kr={option.kind === "kr"}
          role="option"
          aria-selected={value?.id === option.id}
          data-testid="link-picker-option"
          onclick={() => pick(option)}
        >
          <span class="t">{option.kind === "kr" ? option.title : `◎ ${option.title}`}</span>
          {#if option.kind === "goal"}<span class="meta">Goal</span>{/if}
        </button>
      {:else}
        <div class="empty">{objectives.length === 0 ? "No goals synced yet" : "No matches"}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .link-picker { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field {
    display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; min-width: 0;
    border: 1px solid var(--v4-control-border); border-radius: 6px; background: transparent;
    color: var(--v4-text-1); font: inherit; font-size: 13px; text-align: left;
  }
  .value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .value.ph, .caret { color: var(--v4-text-3); }
  .pick {
    max-height: 220px; overflow: auto; border: 1px solid var(--v4-control-border);
    border-radius: 6px; background: var(--v4-control-faint);
  }
  .q {
    width: 100%; height: 28px; padding: 0 10px; border: 0; border-bottom: 1px solid var(--v4-rowline);
    background: transparent; color: var(--v4-text-1); font: inherit; font-size: 13px;
  }
  .row {
    display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 10px; border: 0;
    background: transparent; color: var(--v4-text-1); font: inherit; font-size: 13px; text-align: left;
  }
  .row.kr { padding-left: 24px; color: var(--v4-text-2); }
  .row:hover { background: var(--v4-control-faint); }
  .row[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .empty { font-size: 12px; color: var(--v4-text-3); }
  .empty { padding: 6px 10px; }
</style>
