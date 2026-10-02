<script lang="ts">
  import { dismissable } from "../../common/dismissable.js";
  /**
   * Resolve-conflicts sheet (US-036). Per file: keep local, keep cloud, or
   * discard. Apply sends each choice through the existing sync resolve
   * command (`keep-local` / `keep-remote` / `discard`).
   */
  import type { HomeConflict } from "../home-model.js";

  type Strategy = "keep-local" | "keep-remote" | "discard";

  interface Props {
    conflicts: readonly HomeConflict[];
    onresolve?: (path: string, strategy: Strategy) => void | Promise<void>;
    onclose?: () => void;
  }

  let { conflicts, onresolve, onclose }: Props = $props();

  let picks = $state<Record<string, Strategy>>({});
  let query = $state("");
  let applying = $state(false);

  const rows = $derived(
    conflicts.filter((c) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return c.path.toLowerCase().includes(q);
    }),
  );
  const chosen = $derived(conflicts.filter((c) => picks[c.path]).length);

  function fileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  function pick(path: string, strategy: Strategy): void {
    picks = { ...picks, [path]: strategy };
  }

  function pickAll(strategy: Strategy): void {
    const next = { ...picks };
    for (const row of conflicts) next[row.path] = strategy;
    picks = next;
  }

  async function applyAll(): Promise<void> {
    if (applying) return;
    applying = true;
    try {
      for (const row of conflicts) {
        const strategy = picks[row.path];
        if (!strategy) continue;
        await onresolve?.(row.path, strategy);
      }
      onclose?.();
    } finally {
      applying = false;
    }
  }
</script>

<div class="rc-scrim" data-testid="resolve-conflicts-scrim" onclick={onclose} role="presentation"></div>
<div
  class="rc-sheet"
  use:dismissable={{ onclose }}
  role="dialog"
  aria-label="Resolve conflicts"
  data-testid="resolve-conflicts-sheet"
>
  <header class="rc-h">
    <span>Resolve conflicts</span>
    <span class="sub">{conflicts.length} {conflicts.length === 1 ? "file" : "files"}</span>
    <button type="button" class="icon" aria-label="Close" data-testid="resolve-conflicts-close" onclick={onclose}>✕</button>
  </header>
  <div class="rc-tb">
    <input
      class="search"
      type="search"
      placeholder="Search files"
      aria-label="Search conflict files"
      bind:value={query}
    />
    <span class="sm">Both sides changed. Discard drops both and takes the pre-sync copy.</span>
    <button type="button" class="lnk" data-testid="resolve-conflicts-local-all" onclick={() => pickAll("keep-local")}>Local for all</button>
    <button type="button" class="lnk" data-testid="resolve-conflicts-cloud-all" onclick={() => pickAll("keep-remote")}>Cloud for all</button>
  </div>
  <div class="rc-b">
    {#if rows.length === 0}
      <p class="empty">No matching files.</p>
    {:else}
      {#each rows as row (row.path)}
        <div class="rc-row" data-testid="resolve-conflicts-row">
          <div class="nm">{fileName(row.path)}</div>
          <div class="seg" role="group" aria-label={`Choose for ${fileName(row.path)}`}>
            <button type="button" class="tab" aria-pressed={picks[row.path] === "keep-local"} data-testid="resolve-keep-local" onclick={() => pick(row.path, "keep-local")}>Keep local</button>
            <button type="button" class="tab" aria-pressed={picks[row.path] === "keep-remote"} data-testid="resolve-keep-cloud" onclick={() => pick(row.path, "keep-remote")}>Keep cloud</button>
            <button type="button" class="tab dc" aria-pressed={picks[row.path] === "discard"} data-testid="resolve-discard" onclick={() => pick(row.path, "discard")}>Discard</button>
          </div>
          <div class="pa">{row.path}</div>
          {#if picks[row.path]}
            <div class="pick">Chosen: <b>{picks[row.path] === "keep-local" ? "Keep local" : picks[row.path] === "keep-remote" ? "Keep cloud" : "Discard"}</b></div>
          {:else}
            <div class="pick">Choose a side. Losing sides stay as conflict copies.</div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
  <footer class="rc-f">
    <span class="hint">{chosen} of {conflicts.length} chosen</span>
    <button type="button" class="btn" onclick={onclose}>Cancel</button>
    <button
      type="button"
      class="btn primary"
      data-testid="resolve-conflicts-apply"
      disabled={chosen === 0 || applying}
      onclick={() => void applyAll()}
    >{applying ? "Applying…" : "Apply all"}</button>
  </footer>
</div>

<style>
  .rc-scrim {
    position: fixed;
    inset: 0;
    z-index: 10020;
    background: rgba(0, 0, 0, 0.45);
  }
  .rc-sheet {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 10021;
    width: min(680px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover, 0 16px 48px rgba(0, 0, 0, 0.28));
    color: var(--v4-text-1);
    font-size: 13px;
    overflow: hidden;
  }
  .rc-h {
    flex: none;
    height: 52px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 16px;
    border-bottom: 1px solid var(--v4-hairline);
    font-size: 15px;
    font-weight: 600;
  }
  .sub { font-weight: 400; color: var(--v4-text-3); font-size: 13px; }
  .icon {
    margin-left: auto;
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font-size: 14px;
    cursor: pointer;
  }
  .rc-tb {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .search {
    width: 180px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-1);
    padding: 0 8px;
    font: inherit;
    font-size: 12px;
  }
  .sm { flex: 1; font-size: 12px; color: var(--v4-text-3); }
  .lnk {
    appearance: none;
    border: 0;
    background: transparent;
    font-size: 12px;
    font-weight: 500;
    color: var(--v4-text-2);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    white-space: nowrap;
  }
  .rc-b { flex: 1; min-height: 0; overflow: auto; }
  .rc-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 14px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .nm { font-size: 13px; font-weight: 500; }
  .pa {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick { font-size: 12px; color: var(--v4-text-3); }
  .pick b { font-weight: 500; color: var(--v4-text-1); }
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: 6px;
    background: var(--v4-control-faint);
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    grid-row: 1 / 4;
    grid-column: 2;
  }
  .tab {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab[aria-pressed="true"] { background: var(--v4-active-row, var(--v4-hover)); color: var(--v4-text-1); }
  .tab.dc[aria-pressed="true"] { color: var(--v4-error); }
  .empty { padding: 16px; color: var(--v4-text-3); }
  .rc-f {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--v4-hairline);
  }
  .hint { flex: 1; font-size: 12px; color: var(--v4-text-3); }
  .btn {
    appearance: none;
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-1);
    border-radius: 6px;
    padding: 4px 10px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
