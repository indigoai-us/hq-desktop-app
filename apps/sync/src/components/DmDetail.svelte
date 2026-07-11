<script lang="ts">
  // Same stylesheet App.svelte uses so this window gets the canonical Liquid
  // Glass palette (and an opaque near-black behind the translucent surface).
  import '../styles/popover.css';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { Item, ShareEvent } from '../lib/notificationGroups';
  import { defaultSelectedId } from '../lib/quickWindowPane';
  import { initials } from '../lib/notificationFeedData';
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

  const header = $derived.by(() => {
    if (selected?.kind === 'share' && selected.share) {
      const n =
        selectedShareEvents.length > 0 ? selectedShareEvents.length : 1;
      return {
        title: selected.actor || 'Shared with Me',
        subtitle: `${n} share${n === 1 ? '' : 's'}`,
        kind: 'share' as const,
      };
    }
    const dm = selected?.kind === 'dm' && selected.dm ? selected.dm : event;
    if (dm) {
      return {
        title: dm.fromDisplayName?.trim() || 'Direct Message',
        subtitle: dm.fromEmail || '',
        kind: 'dm' as const,
      };
    }
    return { title: 'Direct Message', subtitle: '', kind: 'dm' as const };
  });

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
    <header class="detail-header" data-tauri-drag-region>
      <div class="detail-avatar" aria-hidden="true" data-kind={header.kind}>
        {initials(header.title)}
      </div>
      <div class="detail-titles">
        <p class="detail-eyebrow">{header.kind === 'share' ? 'Shared with you' : 'Direct Message'}</p>
        <h1>{header.title}</h1>
        {#if header.subtitle}
          <p class="detail-sub">{header.subtitle}</p>
        {/if}
      </div>
    </header>

    {#if selected?.kind === 'share' && selected.share}
      {@const shareEvents = selectedShareEvents.length > 0 ? selectedShareEvents : [selected.share]}
      <ShareMainPane events={shareEvents} />
    {:else if selected?.kind === 'dm' && selected.dm}
      <!-- Keyed remount per thread: a fast side-pane switch must not let an
           older fetch_dm_thread response paint (or send against) the newer
           selection. -->
      {#key selected.dm.eventId}
        <DmThreadPane event={selected.dm} />
      {/key}
    {:else if event}
      <!-- Opening DM: reply composer must keep working unchanged. Keyed so a
           reopen with a different DM remounts a fresh thread (no stale race). -->
      {#key event.eventId}
        <DmThreadPane {event} />
      {/key}
    {:else}
      <div class="detail-empty">
        <p>Waiting for message…</p>
      </div>
    {/if}
  </div>
</div>

<style>
  :global([data-window='dm-detail'] html),
  :global([data-window='dm-detail'] body) {
    margin: 0;
    padding: 0;
    background: var(--page-bg, #0a0a0c);
    color: var(--c-text, #fff);
    color-scheme: light dark;
    font-family: var(--font-sans);
  }

  .detail-window {
    display: flex;
    flex-direction: row;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    /* Solid panel — Lizzie frosted tokens read better opaque in a full window. */
    background: var(--c-bg, #2b2b2e);
    border: 1px solid var(--pop-border, rgba(255, 255, 255, 0.14));
    box-shadow: inset 0 1px 0 var(--pop-highlight, rgba(255, 255, 255, 0.12));
    color: var(--pop-text, var(--c-text));
    font-family: var(--font-sans);
    overflow: hidden;
  }

  .detail-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--c-bg, #2b2b2e);
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px 12px;
    border-bottom: 1px solid var(--pop-divider, rgba(255, 255, 255, 0.1));
    flex-shrink: 0;
    background: color-mix(in srgb, var(--c-bg, #2b2b2e) 92%, #000 8%);
  }

  .detail-avatar {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--pop-text, #fff);
    background: var(--pop-hover, rgba(255, 255, 255, 0.08));
    border: 0.5px solid var(--pop-border, rgba(255, 255, 255, 0.14));
  }

  .detail-avatar[data-kind='share'] {
    border-radius: 10px;
    color: var(--pop-accent, #6cb2ff);
  }

  .detail-titles {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .detail-eyebrow {
    margin: 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--pop-muted, rgba(255, 255, 255, 0.5));
  }

  .detail-header h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.01em;
    color: var(--pop-text, #fff);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-sub {
    margin: 0;
    font-size: 12px;
    color: var(--pop-muted, rgba(255, 255, 255, 0.5));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .detail-empty p {
    font-size: 13px;
    color: var(--pop-muted);
    margin: 0;
  }

  @media (prefers-color-scheme: light) {
    :global([data-window='dm-detail'] html),
    :global([data-window='dm-detail'] body) {
      background: var(--page-bg, #e9ecf1);
    }

    .detail-window,
    .detail-main {
      background: var(--c-bg, #fff);
    }

    .detail-header {
      background: color-mix(in srgb, var(--c-bg, #fff) 96%, #000 4%);
    }
  }
</style>
