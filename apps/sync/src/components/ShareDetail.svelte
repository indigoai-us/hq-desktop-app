<script lang="ts">
  // popover.css defines `:root --popover-*` tokens with proper light/dark
  // media queries. Without this import the share-detail window falls back
  // to in-line var fallbacks AND the default white html/body shows through
  // the 92%-opacity surface — the "light grey on white" bug surfaced
  // during dogfood (2026-05-26). Importing the same stylesheet App.svelte
  // uses gives this window the canonical Liquid Glass palette.
  import '../styles/popover.css';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { ShareEvent, Item } from '../lib/notificationGroups';
  import { defaultSelectedId } from '../lib/quickWindowPane';
  import QuickWindowSidePane from './QuickWindowSidePane.svelte';
  import ShareMainPane from './ShareMainPane.svelte';
  import DmThreadPane from './DmThreadPane.svelte';

  // Opening share event(s) from the notification that launched this window.
  let events = $state<ShareEvent[]>([]);
  // Explicit side-pane selection; null = show the opening share(s).
  let selected = $state<Item | null>(null);
  // Session-viewed ids clear the unread dot without advancing the watermark.
  let viewedIds = $state(new Set<string>());

  const selectedId = $derived(
    selected ? selected.id : defaultSelectedId('share', events[0]?.eventId),
  );

  function onselect(item: Item): void {
    selected = item;
    viewedIds = new Set([...viewedIds, item.id]);
  }

  $effect(() => {
    let unlisten: (() => void) | undefined;

    listen<ShareEvent[]>('share:events-list', (event) => {
      events = event.payload;
      // Reopening this singleton window must show the just-opened share, not
      // a stale side-pane selection from a previous open.
      selected = null;
      // Opening shares count as viewed for the side-pane unread dots.
      if (event.payload.length > 0) {
        viewedIds = new Set([
          ...viewedIds,
          ...event.payload.map((e) => `share:${e.eventId}`),
        ]);
      }
    }).then((fn) => {
      unlisten = fn;
      // Signal to Rust that our listener is registered — Rust emits the
      // pending events + shows the window. Mirrors the new-files-detail
      // ready-handshake (races with WebviewWindowBuilder otherwise).
      invoke('share_detail_window_ready');
    });

    return () => {
      unlisten?.();
    };
  });
</script>

<div class="detail-window">
  <QuickWindowSidePane {selectedId} {viewedIds} {onselect} />

  <div class="detail-main">
    {#if selected?.kind === 'dm' && selected.dm}
      <header class="detail-header">
        <h1>{selected.dm.fromDisplayName || 'Direct Message'}</h1>
        {#if selected.dm.fromEmail}
          <span class="detail-count">{selected.dm.fromEmail}</span>
        {/if}
      </header>
      <!-- Keyed remount per thread: a fast side-pane switch must not let an
           older fetch_dm_thread response paint (or send against) the newer
           selection. -->
      {#key selected.dm.eventId}
        <DmThreadPane event={selected.dm} />
      {/key}
    {:else if selected?.kind === 'share' && selected.share}
      <header class="detail-header">
        <h1>Shared with Me</h1>
        <span class="detail-count">1 share</span>
      </header>
      <ShareMainPane events={[selected.share]} />
    {:else}
      <header class="detail-header">
        <h1>Shared with Me</h1>
        <span class="detail-count"
          >{events.length} share{events.length === 1 ? '' : 's'}</span
        >
      </header>
      <ShareMainPane {events} />
    {/if}
  </div>
</div>

<style>
  /* Paint the share-detail document with the shared light-default ground —
     scoped via the [data-window] attribute set by main.ts so it only
     affects this window, not the popover. */
  :global([data-window="share-detail"] html),
  :global([data-window="share-detail"] body) {
    margin: 0;
    padding: 0;
    background: var(--page-bg);
    color: var(--c-text);
    color-scheme: light;
    font-family: var(--font-sans);
  }

  .detail-window {
    display: flex;
    flex-direction: row;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    background: var(--pop-bg);
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    border: 1px solid var(--pop-border);
    box-shadow: inset 0 1px 0 var(--pop-highlight);
    color: var(--pop-text);
    font-family: var(--font-sans);
    overflow: hidden;
  }

  .detail-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--pop-divider);
    flex-shrink: 0;
  }

  .detail-header h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--pop-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-count {
    font-size: 0.75rem;
    color: var(--pop-muted);
    white-space: nowrap;
  }

  @media (prefers-reduced-transparency: reduce) {
    .detail-window {
      background: var(--c-bg);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
