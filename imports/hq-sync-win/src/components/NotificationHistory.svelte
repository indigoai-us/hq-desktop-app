<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  // Share the popover's design tokens + Fluent thin-scrollbar rules with
  // every secondary window. Without this import the standalone
  // notification-history webview falls back to the Win11 native 16 px
  // chunky scrollbar and a solid black backing colour.
  import '../styles/popover.css';

  // ── Wire types (mirror the Rust structs in notification_history.rs) ──────────
  // The Windows fork persists a flat, self-describing history locally and returns
  // it whole from `fetch_notification_history` — no server dual-source / activity
  // merge (that's the macOS build's model). Each row already carries its kind,
  // actor, summary, timestamp, and (for DM/share rows) the payload needed to
  // re-open the existing detail window.
  interface DmEvent {
    eventId: string;
    fromPersonUid: string;
    fromEmail: string;
    fromDisplayName: string;
    body: string;
    details?: string | null;
    prompt?: string | null;
    createdAt: string;
  }
  interface ShareEvent {
    eventId: string;
    issuerEmail: string;
    issuerDisplayName: string;
    paths: string[];
    note: string | null;
    permission: string;
    createdAt: string;
  }

  type Kind = 'dm' | 'share' | 'new-file' | 'update';

  interface HistoryEntry {
    id: string;
    kind: Kind;
    actor: string;
    summary: string;
    /** Epoch ms — drives sort + day grouping. */
    ts: number;
    dm?: DmEvent | null;
    share?: ShareEvent | null;
  }

  // When mounted inline inside the main popover (the Windows-fork
  // default), App.svelte passes `onback` so the user can return to the
  // home view without dismissing the popover. When mounted as a
  // standalone window (notification-history label), no `onback` is
  // wired and the header back-arrow is hidden — the window's own X /
  // Esc close it.
  interface Props {
    onback?: () => void;
    /** Inline-popover handlers. When wired, row clicks dispatch to
     *  App.svelte instead of spawning standalone DmDetail / ShareDetail
     *  windows. Same fallback semantics as the bell button → `onback`. */
    ondmopen?: (dm: DmEvent) => void;
    onshareopen?: (events: ShareEvent[]) => void;
  }
  let { onback, ondmopen, onshareopen }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let items = $state<HistoryEntry[]>([]);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      // Single source of truth: the local persistent store. Reads off disk, so
      // it works offline and signed-out. Returned newest-first already; we sort
      // defensively in case the contract ever changes.
      const rows = await invoke<HistoryEntry[]>('fetch_notification_history');
      rows.sort((a, b) => b.ts - a.ts);
      items = rows;
    } catch (e) {
      error = typeof e === 'string' ? e : 'Could not load notifications.';
      items = [];
    } finally {
      loading = false;
    }
  }

  // ── Day grouping (mirrors ActivityLog.svelte) ────────────────────────────────
  function dayKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ms: number): string {
    const d = new Date(ms);
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (dayKey(ms) === dayKey(today.getTime())) return 'Today';
    if (dayKey(ms) === dayKey(yest.getTime())) return 'Yesterday';
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
      }).format(d);
    } catch {
      return '';
    }
  }
  function formatTime(ms: number): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(ms));
    } catch {
      return '';
    }
  }

  const groups = $derived(
    (() => {
      const out: Array<{ key: string; label: string; items: HistoryEntry[] }> = [];
      let cur: { key: string; label: string; items: HistoryEntry[] } | null = null;
      for (const it of items) {
        const k = dayKey(it.ts);
        if (!cur || cur.key !== k) {
          cur = { key: k, label: dayLabel(it.ts), items: [] };
          out.push(cur);
        }
        cur.items.push(it);
      }
      return out;
    })(),
  );

  function kindGlyph(kind: Kind): string {
    switch (kind) {
      case 'dm':
        return '✦'; // message
      case 'share':
        return '⇲'; // shared-with-me
      case 'new-file':
        return '＋'; // new file
      case 'update':
        return '↑'; // update
      default:
        return '•';
    }
  }
  function kindLabel(kind: Kind): string {
    switch (kind) {
      case 'dm':
        return 'Message';
      case 'share':
        return 'Shared';
      case 'new-file':
        return 'New file';
      case 'update':
        return 'Update';
      default:
        return '';
    }
  }

  async function openItem(it: HistoryEntry): Promise<void> {
    try {
      if (it.kind === 'dm' && it.dm) {
        // Prefer the in-popover view when App.svelte has wired ondmopen
        // (standard Win11 tray-utility path). Fall back to the standalone
        // DmDetail window if not — preserves the legacy entry path.
        if (ondmopen) {
          ondmopen(it.dm);
        } else {
          await invoke('open_dm_detail', { event: it.dm });
        }
      } else if (it.kind === 'share' && it.share) {
        if (onshareopen) {
          onshareopen([it.share]);
        } else {
          await invoke('open_share_detail', { events: [it.share] });
        }
      }
      // new-file / update rows have no detail window — the file is already in
      // the synced folder; the row is informational.
    } catch (e) {
      console.error('notification-history: open failed', e);
    }
  }

  const clickable = (it: HistoryEntry) =>
    (it.kind === 'dm' && !!it.dm) || (it.kind === 'share' && !!it.share);

  $effect(() => {
    void load();
  });
</script>

<div class="notif-root">
  <header class="notif-header" data-tauri-drag-region>
    {#if onback}
      <!-- Back-arrow mirrors the Settings view's affordance so the
           in-popover NotificationHistory feels like a sibling screen,
           not a modal. Hidden in the standalone-window fallback path. -->
      <button
        type="button"
        class="notif-back"
        title="Back"
        aria-label="Back"
        onclick={() => onback?.()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M10 3.5 5.5 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    {/if}
    <h1>Notifications</h1>
    <button class="notif-refresh" onclick={() => load()} disabled={loading} title="Refresh">
      &#8635;
    </button>
  </header>

  <div class="notif-body">
    {#if loading}
      <p class="notif-status">Loading&hellip;</p>
    {:else if error}
      <p class="notif-status notif-error" role="alert">{error}</p>
    {:else if items.length === 0}
      <p class="notif-status notif-empty">No past notifications.</p>
    {:else}
      {#each groups as group (group.key)}
        <div class="notif-day">
          <div class="notif-day-label">{group.label}</div>
          {#each group.items as it (it.id)}
            <div
              class="notif-row notif-{it.kind}"
              class:clickable={clickable(it)}
              role={clickable(it) ? 'button' : undefined}
              tabindex={clickable(it) ? 0 : undefined}
              onclick={() => clickable(it) && openItem(it)}
              onkeydown={(e) =>
                clickable(it) && (e.key === 'Enter' || e.key === ' ') && openItem(it)}
            >
              <span class="notif-glyph" aria-hidden="true">{kindGlyph(it.kind)}</span>
              <div class="notif-main">
                <div class="notif-line1">
                  <span class="notif-actor">{it.actor}</span>
                  <span class="notif-kind">{kindLabel(it.kind)}</span>
                </div>
                <div class="notif-summary">{it.summary}</div>
              </div>
              <span class="notif-time">{formatTime(it.ts)}</span>
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Keep the window chrome transparent so the Rust-side Mica/Acrylic vibrancy
     (apply_windows_vibrancy) shows through — same pattern as the other Windows
     secondary windows (MeetingPermissionsWindow / DriftDetail). The root below
     carries a translucent solid-background fallback for when vibrancy is
     unavailable (Win Server SKUs, third-party shells). */
  :global(html[data-window='notification-history']),
  :global(body[data-window='notification-history']) {
    margin: 0;
    height: 100%;
    background: transparent;
  }

  .notif-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    /* Match the OS DWMWCP_ROUNDSMALL (~4 px) set in main.rs so the
       content edge and the OS Mica clip coincide. */
    border-radius: 4px;
    overflow: hidden;
    color: var(--popover-text, #e7e7ea);
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
    /* Share the popover background token so Mica blur is consistent across
       all inline sibling screens. `prefers-reduced-transparency` already
       provides an opaque fallback when Mica is off. */
    background: var(--popover-bg, rgba(18, 18, 20, 0.68));
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
  }

  .notif-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .notif-header h1 {
    margin: 0;
    flex: 1;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  /* Back chevron, same outlined-icon-button look + sizing as
     .notif-refresh so the header reads symmetrically. Only rendered
     when `onback` is wired (inline-popover mode). */
  .notif-back {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #c9c9cf;
    border-radius: 7px;
    width: 26px;
    height: 26px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-app-region: no-drag;
  }
  .notif-back:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .notif-refresh {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #c9c9cf;
    border-radius: 7px;
    width: 26px;
    height: 26px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }
  .notif-refresh:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .notif-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 16px;
  }

  .notif-status {
    text-align: center;
    color: #8a8a90;
    font-size: 13px;
    margin-top: 40px;
  }
  .notif-error {
    color: #f0a3a3;
  }

  .notif-day {
    margin-top: 6px;
  }
  .notif-day-label {
    position: sticky;
    top: 0;
    background: rgba(11, 11, 13, 0.82);
    backdrop-filter: blur(8px);
    color: #8a8a90;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 16px 4px;
    z-index: 1;
  }

  .notif-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .notif-row.clickable {
    cursor: pointer;
  }
  .notif-row.clickable:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .notif-glyph {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: #d8d8de;
    font-size: 12px;
    margin-top: 1px;
  }

  .notif-main {
    flex: 1;
    min-width: 0;
  }
  .notif-line1 {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .notif-actor {
    font-size: 13px;
    font-weight: 600;
    color: #f2f2f4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .notif-kind {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #7c7c82;
    flex: 0 0 auto;
  }
  .notif-summary {
    font-size: 12.5px;
    color: #b9b9c0;
    margin-top: 2px;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .notif-time {
    flex: 0 0 auto;
    font-size: 11px;
    color: #76767c;
    margin-top: 1px;
  }
</style>
