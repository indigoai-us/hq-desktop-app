<script lang="ts">
  // Same stylesheet App.svelte uses so this window gets the canonical Liquid
  // Glass palette (and an opaque near-black behind the translucent surface).
  import '../styles/popover.css';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { Item, ShareEvent } from '../lib/notificationGroups';
  import { defaultSelectedId } from '../lib/quickWindowPane';
  import QuickWindowSidePane from './QuickWindowSidePane.svelte';
  import ShareMainPane from './ShareMainPane.svelte';
  import DmThreadPane, { type DmEvent } from './DmThreadPane.svelte';

  // The DM that opened the window (the reply target).
  let event = $state<DmEvent | null>(null);
  // Explicit side-pane selection; null = show the opening DM.
  let selected = $state<Item | null>(null);
  // Session-viewed ids clear the unread dot without advancing the watermark.
  let viewedIds = $state(new Set<string>());

  const selectedId = $derived(
    selected ? selected.id : defaultSelectedId('dm', event?.eventId),
  );

  // Full grouped conversation for a selected share row (US-016) — the main
  // pane shows every share from that sender, not just the latest.
  let selectedShareEvents = $state<ShareEvent[]>([]);

  function onselect(item: Item, conversationIds?: string[], conversationItems?: Item[]): void {
    selected = item;
    selectedShareEvents =
      item.kind === 'share'
        ? (conversationItems ?? [item]).flatMap((i) =>
            i.kind === 'share' && i.share ? [i.share] : [],
          )
        : [];
    viewedIds = new Set([...viewedIds, item.id, ...(conversationIds ?? [])]);
  }

  $effect(() => {
    let unlisten: (() => void) | undefined;

    listen<DmEvent>('dm:detail-event', (e) => {
      event = e.payload;
      // Reopening this singleton window must show the just-opened DM (and its
      // reply composer), not a stale side-pane selection from a previous open.
      selected = null;
      selectedShareEvents = [];
      // Opening DM counts as viewed for the side-pane unread dots.
      viewedIds = new Set([...viewedIds, `dm:${e.payload.eventId}`]);
    }).then((fn) => {
      unlisten = fn;
      // Ready-handshake: tell Rust the listener is mounted so it emits the
      // pending event + shows the window (mirrors ShareDetail).
      invoke('dm_detail_window_ready');
    });

    return () => {
      unlisten?.();
    };
  });
</script>

<div class="detail-window">
  <QuickWindowSidePane {selectedId} {viewedIds} {onselect} />

  <div class="detail-main">
    {#if selected?.kind === 'share' && selected.share}
      {@const shareEvents = selectedShareEvents.length > 0 ? selectedShareEvents : [selected.share]}
      <header class="detail-header">
        <h1>Shared with Me</h1>
        <span class="detail-count"
          >{shareEvents.length} share{shareEvents.length === 1 ? '' : 's'}</span
        >
      </header>
      <ShareMainPane events={shareEvents} />
    {:else if selected?.kind === 'dm' && selected.dm}
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
    {:else if event}
      <header class="detail-header">
        <h1>{event.fromDisplayName}</h1>
        {#if event.fromEmail}
          <span class="detail-count">{event.fromEmail}</span>
        {/if}
      </header>
      <!-- Opening DM: reply composer must keep working unchanged. Keyed so a
           reopen with a different DM remounts a fresh thread (no stale race). -->
      {#key event.eventId}
        <DmThreadPane {event} />
      {/key}
    {:else}
      <header class="detail-header">
        <h1>Direct Message</h1>
      </header>
      <div class="detail-empty">
        <p>Waiting for message…</p>
      </div>
    {/if}
  </div>
</div>

<style>
  :global([data-window="dm-detail"] html),
  :global([data-window="dm-detail"] body) {
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
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--pop-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-count {
    margin-left: auto;
    font-size: var(--text-base);
    color: var(--pop-muted);
    white-space: nowrap;
  }

  .detail-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .detail-empty p {
    font-size: var(--text-base);
    color: var(--pop-muted);
    margin: 0;
  }

  @media (prefers-reduced-transparency: reduce) {
    .detail-window {
      background: var(--c-bg);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
