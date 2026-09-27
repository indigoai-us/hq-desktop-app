<script lang="ts">
  /**
   * QuickSwitcher: Cmd+O jump-to-file for the open vault, fuzzy by path.
   * Enter opens, Cmd+Enter opens in a new tab, Escape closes.
   *
   * Matching runs in the native vault index; typing is debounced and a slow
   * answer for an old query never replaces a newer one.
   */
  import type { VaultFileHit } from "@hq/platform";
  import { vaultRelativePath, noteTitle, type Vault } from "./vault-model.js";

  interface Props {
    vault: Vault;
    search: (query: string) => Promise<VaultFileHit[] | null>;
    onopen: (path: string, opts: { newTab: boolean }) => void;
    onclose: () => void;
  }

  let { vault, search, onopen, onclose }: Props = $props();

  const DEBOUNCE_MS = 60;

  let query = $state("");
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let results = $state<VaultFileHit[]>([]);
  let searching = $state(true);
  let failed = $state(false);
  let seq = 0;

  $effect(() => {
    const q = query;
    const mine = ++seq;
    searching = true;
    const timer = setTimeout(async () => {
      const hits = await search(q);
      if (mine !== seq) return;
      searching = false;
      failed = hits === null;
      results = hits ?? [];
    }, q ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    input?.focus();
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function folderOf(path: string): string {
    const rel = vaultRelativePath(vault, path);
    return rel.split("/").slice(0, -1).join(" / ");
  }

  function choose(i: number, newTab: boolean): void {
    const f = results[i];
    if (!f) return;
    onopen(f.path, { newTab });
    onclose();
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      scrollActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      scrollActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active, event.metaKey || event.ctrlKey);
    }
  }

  function scrollActive(): void {
    queueMicrotask(() => {
      document.querySelector(`[data-qs-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="qs-scrim" onclick={onclose} data-testid="quick-switcher">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="qs" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1" aria-modal="true" aria-label="Open a file">
    <input
      bind:this={input}
      bind:value={query}
      {onkeydown}
      class="qs-input"
      type="text"
      placeholder={`Find a file in ${vault.label}…`}
      aria-label="File name"
      aria-controls="qs-results"
      spellcheck="false"
      autocomplete="off"
    />
    <ul class="qs-results" id="qs-results" role="listbox">
      {#each results as f, i (f.path)}
        <li
          class="qs-row"
          class:is-active={i === active}
          role="option"
          aria-selected={i === active}
          data-qs-index={i}
          onmouseenter={() => (active = i)}
          onclick={(e) => choose(i, e.metaKey || e.ctrlKey)}
        >
          <span class="qs-name">{f.isMarkdown ? noteTitle(f.path) : f.name}</span>
          <span class="qs-folder">{folderOf(f.path)}</span>
        </li>
      {:else}
        <li class="qs-empty">{searching ? "Searching…" : failed ? "Search is not available right now." : "No matching files."}</li>
      {/each}
    </ul>
    <footer class="qs-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>⌘</kbd><kbd>↵</kbd> new tab</span>
      <span><kbd>esc</kbd> close</span>
    </footer>
  </div>
</div>

<style>
  .qs-scrim {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: color-mix(in srgb, black 28%, transparent);
  }
  .qs {
    width: min(620px, calc(100% - 48px));
    border: 1px solid var(--v4-hairline);
    border-radius: 14px;
    background: var(--v4-popover-strong);
    box-shadow: var(--v4-shadow-popover);
    overflow: hidden;
  }
  .qs-input {
    width: 100%;
    box-sizing: border-box;
    padding: 16px 18px;
    border: 0;
    border-bottom: 1px solid var(--v4-hairline);
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 16px;
    outline: none;
  }
  .qs-input::placeholder {
    color: var(--v4-text-3);
  }
  .qs-results {
    max-height: 46vh;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    list-style: none;
  }
  .qs-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 8px;
    cursor: pointer;
  }
  .qs-row.is-active {
    background: var(--v4-active-row);
  }
  .qs-name {
    color: var(--v4-text-1);
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qs-folder {
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: right;
  }
  .qs-empty {
    padding: 18px 12px;
    color: var(--v4-text-3);
    font-size: 13px;
  }
  .qs-foot {
    display: flex;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--v4-hairline);
    color: var(--v4-text-3);
    font-size: 11px;
  }
  kbd {
    display: inline-block;
    min-width: 14px;
    margin-right: 3px;
    padding: 0 4px;
    border: 1px solid var(--v4-hairline);
    border-radius: 4px;
    font: inherit;
    text-align: center;
  }
</style>
