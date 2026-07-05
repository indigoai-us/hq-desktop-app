<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';

  interface ActivityEntry {
    company: string;
    path: string;
    bytes: number;
    /** "up" | "down" | "deleted" */
    direction: string;
    /** Email of the file's author (from S3 created-by). Only download rows. */
    author?: string;
    /** True if a downloaded file was new to the drive ("added"), false if it
     *  was an update ("updated"), undefined when not yet known. */
    isNew?: boolean;
    /** epoch millis */
    at: number;
  }

  let entries = $state<ActivityEntry[]>([]);

  /** Only the most recent N changes are shown; older ones scroll off. */
  const MAX_VISIBLE = 100;

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Stable day key (local) for grouping. */
  function dayKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  /** Human label for a day key relative to today. */
  function dayLabel(ms: number): string {
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(ms) === dayKey(today.getTime())) return 'Today';
    if (dayKey(ms) === dayKey(yesterday.getTime())) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Newest-first, capped at MAX_VISIBLE, grouped by day. Recomputed whenever
  // `entries` changes.
  const groups = $derived.by(() => {
    const sorted = [...entries]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_VISIBLE);
    const out: { key: string; label: string; items: ActivityEntry[] }[] = [];
    for (const e of sorted) {
      const key = dayKey(e.at);
      let g = out.find((x) => x.key === key);
      if (!g) {
        g = { key, label: dayLabel(e.at), items: [] };
        out.push(g);
      }
      g.items.push(e);
    }
    return out;
  });

  /**
   * Past-tense action verb describing what the author did, for the attribution
   * line ("Tom added" / "Tom updated"). Downloads distinguish added (new file)
   * from updated (changed file) when the runner's new-files event has reconciled
   * `isNew`; an un-reconciled download falls back to "updated".
   */
  function actionVerb(item: ActivityEntry): string {
    switch (item.direction) {
      case 'up':
        return 'uploaded';
      case 'deleted':
        return 'deleted';
      case 'down':
      default:
        return item.isNew ? 'added' : 'updated';
    }
  }

  function dirMeta(direction: string): { label: string; cls: string; glyph: string } {
    switch (direction) {
      case 'up':
        return { label: 'Uploaded', cls: 'dir-up', glyph: '↑' };
      case 'deleted':
        return { label: 'Deleted', cls: 'dir-del', glyph: '✕' };
      case 'down':
      default:
        return { label: 'Downloaded', cls: 'dir-down', glyph: '↓' };
    }
  }

  $effect(() => {
    let offAppend: (() => void) | undefined;
    let offList: (() => void) | undefined;

    // Pull the current snapshot on mount. This is the authoritative load —
    // robust against emit-timing races (the old emit-on-ready handshake could
    // fire before this webview's listener registered, leaving the window
    // empty). The window is shown by Rust on open; no ready-handshake needed.
    invoke<ActivityEntry[]>('get_activity_log').then((list) => {
      entries = list;
    });

    // Live updates: new entries recorded while the window is open are pushed
    // via `activity:append`. We also keep `activity:list` as a re-sync hook
    // (emitted when an already-open window is re-focused).
    listen<ActivityEntry>('activity:append', (event) => {
      entries = [...entries, event.payload];
    }).then((off) => {
      offAppend = off;
    });
    listen<ActivityEntry[]>('activity:list', (event) => {
      entries = event.payload;
    }).then((off) => {
      offList = off;
    });

    return () => {
      offAppend?.();
      offList?.();
    };
  });
</script>

<div class="detail-window">
  <header class="detail-header" data-tauri-drag-region>
    <h1>Recent Changes</h1>
    <span class="detail-count">
      {#if entries.length > MAX_VISIBLE}
        latest {MAX_VISIBLE} of {entries.length} this session
      {:else}
        {entries.length} change{entries.length === 1 ? '' : 's'} this session
      {/if}
    </span>
  </header>

  {#if entries.length === 0}
    <div class="detail-empty">
      <p>No file changes synced yet this session.</p>
    </div>
  {:else}
    <div class="detail-list">
      {#each groups as group (group.key)}
        <div class="day-header">{group.label}</div>
        {#each group.items as item (item.path + item.at)}
          {@const meta = dirMeta(item.direction)}
          <div class="detail-row">
            <span class="col-dir {meta.cls}" title={meta.label}>
              <span class="dir-glyph">{meta.glyph}</span>
              <span class="dir-label">{meta.label}</span>
            </span>
            <span class="col-path detail-path" title={`${item.company}/${item.path}`}>
              <span class="path-main">{item.path}</span>
              <span class="path-company">
                {#if item.author}<span class="path-author">{item.author}</span> {actionVerb(item)}{:else}{item.company}{/if}
              </span>
            </span>
            <span class="col-time">{formatTime(item.at)}</span>
            <span class="col-size">{formatBytes(item.bytes)}</span>
          </div>
        {/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Reset the root document for THIS window only (scoped by the
     data-window attribute main.ts stamps), mirroring App.svelte's main-window
     reset. Without this the default 8px <body> margin offsets our content and
     the transparent+vibrant window shows a gray strip of bare NSVisualEffect
     along the top/left edges. Scoped so it can't bleed into other windows. */
  :global(html[data-window='activity-log']),
  :global(html[data-window='activity-log'] body) {
    margin: 0;
    padding: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: var(--page-bg);
    color: var(--c-text);
    font-family: var(--font-sans);
  }

  .detail-window {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    background: var(--pop-bg);
    backdrop-filter: blur(32px) saturate(1.7);
    -webkit-backdrop-filter: blur(32px) saturate(1.7);
    border: 1px solid var(--pop-border);
    box-shadow: inset 0 1px 0 var(--pop-highlight);
    color: var(--pop-text);
    font-family: var(--font-sans);
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    /* Extra top padding clears the macOS traffic-light buttons that the
       Overlay title-bar style floats over the body's top-left. */
    padding: 2.25rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--pop-divider);
    flex-shrink: 0;
  }

  .detail-header h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--pop-text);
  }

  .detail-count {
    font-size: 0.75rem;
    color: var(--pop-muted);
  }

  .detail-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .detail-empty p {
    font-size: 0.8125rem;
    color: var(--pop-muted);
    margin: 0;
  }

  .detail-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0 0.75rem;
    scrollbar-width: thin;
    scrollbar-color: var(--pop-muted) transparent;
  }

  .detail-list::-webkit-scrollbar {
    width: 6px;
  }
  .detail-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .detail-list::-webkit-scrollbar-thumb {
    background: var(--pop-hover);
    border-radius: 3px;
  }
  .detail-list:hover::-webkit-scrollbar-thumb {
    background: var(--c-field-bg);
  }

  .day-header {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0.5rem 1.25rem 0.3rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--pop-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    /* Slightly more opaque than the body so rows scrolling under it stay
       legible; same hue as the window surface to avoid a seam. */
    background: var(--pop-bg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .detail-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    border-bottom: 1px solid var(--pop-divider);
    transition: background-color 0.1s ease;
  }
  .detail-row:hover {
    background: var(--pop-hover);
  }

  .col-dir {
    width: 104px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .dir-glyph {
    font-size: 0.8rem;
    line-height: 1;
  }
  .dir-up {
    color: var(--popover-success, #1f9d4d);
  }
  .dir-down {
    color: var(--pop-muted);
  }
  .dir-del {
    color: var(--popover-danger, #dc2626);
  }

  .col-path {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .path-main {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--pop-text);
  }
  .path-company {
    font-size: 0.6875rem;
    color: var(--pop-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path-author {
    /* The "who" — slightly brighter than the trailing verb so it reads as the
       subject of "{author} added/updated". */
    color: var(--pop-text);
    font-weight: 500;
  }

  .col-time {
    width: 58px;
    flex-shrink: 0;
    text-align: right;
    font-size: 0.7rem;
    color: var(--pop-muted);
    font-variant-numeric: tabular-nums;
  }

  .col-size {
    width: 66px;
    flex-shrink: 0;
    text-align: right;
    font-size: 0.7rem;
    color: var(--pop-muted);
    font-variant-numeric: tabular-nums;
  }

  @media (prefers-reduced-transparency: reduce) {
    .detail-window,
    .day-header {
      background: var(--c-bg);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
