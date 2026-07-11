<script lang="ts">
  /**
   * Floating desktop widget — HQ wordmark (US-002) + notification stack (US-003).
   *
   * Locked design: no circle, no badge chip, no rounded container around the
   * mark. Idle translucency + full opacity on hover. Color tracks system
   * appearance via prefers-color-scheme. Queued count is a plain superscript
   * numeral (no chip). Notification rows stack above the wordmark in frosted
   * glass shells; the pure reducers live in `stores/widgetNotifications.ts`.
   *
   * Mountable with zero Tauri APIs (happy-dom US-002 / US-003 tests). Listeners
   * and invokes only run when `__TAURI_INTERNALS__` is present.
   */
  import { onMount, untrack } from 'svelte';
  import NotificationRow from './NotificationRow.svelte';
  import type { NotificationRowType } from './NotificationRow.svelte';
  import {
    type BannerPayloadLike,
    type WidgetStackItem,
    type WidgetStackState,
    WIDGET_RECENT_STORAGE_KEY,
    addItem,
    bannerToStackItem,
    deserializeRecent,
    dismissItem,
    dismissRecent,
    expireItems,
    hoverItems,
    hoverRows,
    markQueueSeen,
    markRecentRead,
    serializeRecent,
    setHeld,
    setOccluded,
    unreadRecentCount,
    widgetEmptyHoverWindowSize,
    widgetHoverWindowSize,
    widgetWindowSize,
  } from '../stores/widgetNotifications';

  let {
    /** Initial/test seed for the queued superscript when the stack is empty. */
    queued = 0,
    /** Seed visible rows for happy-dom tests (no Tauri). */
    initialItems = [],
  }: {
    queued?: number;
    initialItems?: WidgetStackItem[];
  } = $props();

  // Capture once on mount — tests seed rows; runtime stack is event-driven.
  // US-015: without initialItems, hydrate recent from localStorage (never visible).
  let stack = $state<WidgetStackState>(
    untrack(() => {
      if (initialItems.length > 0) {
        const seeded = initialItems.map((i) => ({ ...i }));
        return {
          visible: seeded,
          queued: [],
          // Seed recent so hover list works with initialItems (tests + cold start).
          recent: seeded.map((i) => ({ ...i, unread: i.unread ?? true })),
          occluded: false,
          held: false,
        };
      }
      let recent: WidgetStackItem[] = [];
      try {
        if (typeof localStorage !== 'undefined') {
          recent = deserializeRecent(localStorage.getItem(WIDGET_RECENT_STORAGE_KEY));
        }
      } catch {
        // localStorage unavailable / blocked — empty history.
      }
      return {
        visible: [],
        queued: [],
        recent,
        occluded: false,
        held: false,
      };
    }),
  );

  // US-015: persist recent history so the popup survives relaunch.
  $effect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(WIDGET_RECENT_STORAGE_KEY, serializeRecent(stack));
      }
    } catch {
      // Quota / private mode — no-op.
    }
  });

  /** Pointer anywhere over a notification row/stack/list suspends auto-hide. */
  let pointerHold = $state(false);
  /** Per-row reply focus/draft holds (ids of rows currently holding). */
  let replyHolds = $state(new Set<string>());

  /**
   * Apply hold to the pure stack. Plain function (not an $effect writing stack)
   * to avoid effect loops — callers compute holdActive after local state updates.
   */
  function applyHold(holdActive: boolean): void {
    stack = setHeld(stack, holdActive, Date.now());
  }

  function setPointerHold(on: boolean): void {
    pointerHold = on;
    applyHold(on || replyHolds.size > 0);
  }

  function setReplyHold(id: string, held: boolean): void {
    const next = new Set(replyHolds);
    if (held) {
      next.add(id);
    } else {
      next.delete(id);
    }
    replyHolds = next;
    const holdActive = pointerHold || next.size > 0;
    applyHold(holdActive);
    // Reply hold released with nothing else holding (pointer already left) —
    // resume normal hover collapse.
    if (!held && next.size === 0 && !pointerHold && hoverOpen && !pinned) {
      scheduleHoverClose();
    }
  }

  /**
   * Superscript shows real queue length, falling back to the prop seed —
   * but once hover has opened (markQueueSeen / hoverSeen), prop seed is ignored
   * so the count actually clears. Unread recent count takes priority when > 0.
   */
  let hoverSeen = $state(false);
  const queuedCount = $derived(
    stack.queued.length > 0 ? stack.queued.length : hoverSeen ? 0 : queued,
  );
  const unreadCount = $derived(unreadRecentCount(stack));
  const badgeCount = $derived(unreadCount > 0 ? unreadCount : queuedCount);

  let idSeq = 0;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  /** Last size sent to `resize_widget` (non-reactive — avoids effect loops). */
  let lastSent: { width: number; height: number } | null = null;

  /** Hover recent-list open state + collapse delay timer. */
  let hoverOpen = $state(false);
  /** Click-pinned open — survives pointerleave until click-away or re-click. */
  let pinned = $state(false);
  let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;

  /** Tracks native focusable state (non-reactive — avoids effect loops). */
  let widgetFocusable = false;

  const hoverList = $derived(
    hoverOpen ? hoverRows(hoverItems(stack), Date.now()) : [],
  );

  function hasTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  /**
   * Temporarily make the widget window key so the quick-reply input can type.
   * Restored to false on send/dismiss/pointerleave. No-ops without Tauri or
   * when the requested state matches the last sent value.
   */
  async function setWidgetFocusable(on: boolean): Promise<void> {
    if (!hasTauri()) return;
    if (widgetFocusable === on) return;
    widgetFocusable = on;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_widget_focusable', { focusable: on });
    } catch (err) {
      console.error('widget: set_widget_focusable failed', err);
      // Roll back local flag so a retry can re-invoke.
      widgetFocusable = !on;
    }
  }

  function handlePointerDownCapture(e: PointerEvent): void {
    if ((e.target as HTMLElement | null)?.closest?.('input')) {
      void setWidgetFocusable(true);
    }
  }

  function handleFocusInCapture(e: FocusEvent): void {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') {
      void setWidgetFocusable(true);
    }
  }

  function openHoverList(): void {
    if (hoverCloseTimer !== undefined) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
    if (hoverOpen) return;
    // A reply is focused / has a draft on a stack row. Switching surfaces
    // would unmount that row and destroy the draft — never hide a
    // notification mid-reply (US-012), so ignore the wordmark hover.
    if (replyHolds.size > 0) return;
    hoverOpen = true;
    hoverSeen = true;
    applyStack(markQueueSeen(stack));
  }

  /** Close a click-pinned list and clear unread (mark-on-leave watermark). */
  function closePinned(): void {
    pinned = false;
    hoverOpen = false;
    if (hoverCloseTimer !== undefined) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
    stack = markRecentRead(stack);
    // The hover list unmounts without a pointerleave — never leave a stale
    // pointer hold behind (it would suspend auto-hide forever).
    setPointerHold(false);
    // A quick-reply input may have flipped the native window focusable while
    // the list was pinned — always restore non-activating mode on close.
    void setWidgetFocusable(false);
  }

  function togglePinned(): void {
    if (pinned) {
      closePinned();
    } else {
      // Don't pin (and unmount a drafting stack row) mid-reply — see
      // openHoverList's reply-hold guard.
      if (replyHolds.size > 0) return;
      pinned = true;
      openHoverList();
    }
  }

  function handleWordmarkKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePinned();
    }
  }

  function cancelHoverClose(): void {
    if (hoverCloseTimer !== undefined) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
  }

  function scheduleHoverClose(): void {
    // Pinned list stays open through pointerleave — only click-away / re-click closes.
    if (pinned) return;
    // Reply focus/draft keeps the hover list open through pointerleave.
    if (replyHolds.size > 0) return;
    if (hoverCloseTimer !== undefined) {
      clearTimeout(hoverCloseTimer);
    }
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = undefined;
      // A reply hold acquired after this timer was armed wins — never
      // collapse the list mid-reply.
      if (replyHolds.size > 0) return;
      hoverOpen = false;
      stack = markRecentRead(stack);
      // Hover list unmounted without a pointerleave — drop any stale hold.
      setPointerHold(false);
    }, 450);
  }

  function applyStack(next: WidgetStackState): void {
    stack = next;
    syncExpiryTimer();
  }

  function syncExpiryTimer(): void {
    if (stack.visible.length === 0) {
      if (expiryTimer !== undefined) {
        clearInterval(expiryTimer);
        expiryTimer = undefined;
      }
      return;
    }
    if (expiryTimer !== undefined) return;
    expiryTimer = setInterval(() => {
      const next = expireItems(stack, Date.now());
      if (next !== stack) {
        stack = next;
        if (stack.visible.length === 0 && expiryTimer !== undefined) {
          clearInterval(expiryTimer);
          expiryTimer = undefined;
        }
      }
    }, 1000);
  }

  async function handleOpen(item: WidgetStackItem): Promise<void> {
    // Drop any stale reply-hold for this row so ids never hold forever.
    setReplyHold(item.id, false);
    // Hydrated history rows are display-only (US-015): deserializeRecent strips
    // the action surface, so an empty clickActionId must never reach the
    // privileged banner_action command — dismiss locally instead.
    if (!hasTauri() || !item.clickActionId) {
      applyStack(dismissItem(stack, item.id));
      if (stack.visible.length === 0) {
        setPointerHold(false);
      }
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // Mirror BannerNotification: banner_action re-emits notification:banner-action
      // for App.svelte to route DM/share/meeting/update surfaces.
      const payload: BannerPayloadLike = {
        kind: item.kind,
        title: item.actor ?? '',
        body: item.text,
        clickActionId: item.clickActionId,
        data: item.data,
        actionId: item.actionId,
        actionLabel: item.actionLabel,
      };
      await invoke('banner_action', { action: item.clickActionId, payload });
    } catch (err) {
      console.error('widget: open failed', err);
    } finally {
      applyStack(dismissItem(stack, item.id));
      // Opening the last row unmounts .stack without a pointerleave —
      // clear the pointer hold so the next notification still auto-hides.
      if (stack.visible.length === 0) {
        setPointerHold(false);
      }
    }
  }

  /**
   * Dismiss pill inside the pinned popup / hover list. Removes the row from
   * recent + visible; when the LAST row goes, the panel unmounts without a
   * pointerleave — close it fully (clears the pointer hold, restores the
   * non-activating window, and resets pinned/hoverOpen) so auto-hide and
   * window sizing never wedge on an empty invisible panel.
   */
  function handleHoverDismiss(id: string): void {
    setReplyHold(id, false);
    applyStack(dismissRecent(stack, id));
    if (hoverItems(stack).length === 0) {
      closePinned();
    }
  }

  function handleDismiss(id: string): void {
    // Drop any stale reply-hold for this row so ids never hold forever.
    setReplyHold(id, false);
    applyStack(dismissItem(stack, id));
    // Dismissing the last row unmounts .stack without a pointerleave —
    // clear the pointer hold so the next notification still auto-hides.
    if (stack.visible.length === 0) {
      setPointerHold(false);
    }
    void setWidgetFocusable(false);
  }

  /**
   * Mirror NotificationFeed.replyDm: real `send_dm` to the message author.
   * DmEvent serializes camelCase; peer is `fromPersonUid` on `item.data`.
   * Only meaningful when Tauri is present; no-ops otherwise. Errors log only
   * — the row stays visible.
   */
  async function replyDm(item: WidgetStackItem, text: string): Promise<void> {
    if (!hasTauri()) return;
    const peer = (item.data as { fromPersonUid?: string } | null)?.fromPersonUid;
    if (!peer || !text.trim()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('send_dm', { toPersonUid: peer, body: text.trim() });
    } catch (err) {
      console.error('widget: send_dm failed', err);
    } finally {
      void setWidgetFocusable(false);
    }
  }

  /** No per-event reaction API — send the emoji as a DM reply body (same as feed). */
  async function reactDm(item: WidgetStackItem, emoji: string): Promise<void> {
    await replyDm(item, emoji);
  }

  onMount(() => {
    syncExpiryTimer();

    function handleClickAway(e: PointerEvent): void {
      // Don't dismiss while a reply is focused / has a draft.
      if (replyHolds.size > 0) return;
      if (!pinned) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.hover-list') || target?.closest?.('.wm')) return;
      closePinned();
    }

    function handleWindowBlur(): void {
      // Never collapse mid-reply — focusing the quick-reply input toggles the
      // native window focusable, which makes blur events likely during exactly
      // the flow US-012 protects (match the click-away guards).
      if (replyHolds.size > 0) return;
      if (pinned) closePinned();
    }

    document.addEventListener('pointerdown', handleClickAway, true);
    window.addEventListener('blur', handleWindowBlur);

    if (!hasTauri()) {
      return () => {
        document.removeEventListener('pointerdown', handleClickAway, true);
        window.removeEventListener('blur', handleWindowBlur);
        if (expiryTimer !== undefined) clearInterval(expiryTimer);
        if (hoverCloseTimer !== undefined) clearTimeout(hoverCloseTimer);
      };
    }

    let unlistenNotif: (() => void) | undefined;
    let unlistenOcc: (() => void) | undefined;
    let unlistenClickAway: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;

      unlistenNotif = await listen<BannerPayloadLike>('widget:notification', (e) => {
        const now = Date.now();
        const id = `wn-${now}-${++idSeq}`;
        const item = bannerToStackItem(e.payload, now, id);
        applyStack(addItem(stack, item));
      });

      unlistenOcc = await listen<{ visible: boolean }>('widget:occlusion', (e) => {
        // Backend emits window visibility; occluded when not visible.
        const visible = e.payload?.visible !== false;
        applyStack(setOccluded(stack, !visible, Date.now()));
      });

      // Native click-away: the non-focusable widget window never blurs and
      // clicks in other apps never reach `document`, so Rust runs a global
      // NSEvent mouse-down monitor and emits widget:click-away (US-010).
      unlistenClickAway = await listen('widget:click-away', () => {
        // Don't dismiss while a reply is focused / has a draft.
        if (replyHolds.size > 0) return;
        if (pinned) closePinned();
      });

      const { invoke } = await import('@tauri-apps/api/core');
      if (cancelled) return;
      // Ready-handshake: Rust replies with the initial widget:occlusion.
      await invoke('widget_ready').catch((err: unknown) => {
        console.error('widget: widget_ready failed', err);
      });
    })();

    return () => {
      cancelled = true;
      document.removeEventListener('pointerdown', handleClickAway, true);
      window.removeEventListener('blur', handleWindowBlur);
      unlistenNotif?.();
      unlistenOcc?.();
      unlistenClickAway?.();
      if (expiryTimer !== undefined) {
        clearInterval(expiryTimer);
        expiryTimer = undefined;
      }
      if (hoverCloseTimer !== undefined) {
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = undefined;
      }
    };
  });

  // Grow/shrink the native window with the visible stack / hover list
  // (lower-right anchor stays fixed in Rust). Only when Tauri is present and
  // size actually changed.
  $effect(() => {
    let size: { width: number; height: number };
    if (hoverOpen) {
      const items = hoverItems(stack);
      // Pinned-open with no recent rows: grow for the empty-state panel so a
      // wordmark click always produces visible feedback (US-010). Hover-only
      // with zero items stays idle-sized — no empty panel flash.
      if (items.length === 0 && pinned) {
        size = widgetEmptyHoverWindowSize();
      } else {
        const rows = hoverRows(items, Date.now());
        size = widgetHoverWindowSize(
          items,
          rows.filter((r) => r.separator).length,
        );
      }
    } else {
      size = widgetWindowSize(stack);
    }
    if (!hasTauri()) return;
    if (
      lastSent &&
      lastSent.width === size.width &&
      lastSent.height === size.height
    ) {
      return;
    }
    lastSent = size;
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('resize_widget', {
        width: size.width,
        height: size.height,
      }).catch((err: unknown) => {
        console.error('widget: resize_widget failed', err);
      });
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="wg"
  onpointerdowncapture={handlePointerDownCapture}
  onfocusincapture={handleFocusInCapture}
  onpointerenter={cancelHoverClose}
  onpointerleave={() => {
    scheduleHoverClose();
    // Typing must survive transient hover-out — keep focusable while reply holds.
    if (replyHolds.size === 0) {
      void setWidgetFocusable(false);
    }
  }}
>
  {#if hoverOpen && (hoverList.length > 0 || pinned)}
    <div
      class="hover-list frost-panel"
      data-testid="widget-hover-list"
      onpointerenter={() => setPointerHold(true)}
      onpointerleave={() => setPointerHold(false)}
    >
      {#if hoverList.length === 0}
        <div class="hl-empty" data-testid="widget-empty-state">No recent notifications</div>
      {:else}
        {#each hoverList as row (row.item.id)}
          {#if row.separator}<div class="hl-sep">{row.separator}</div>{/if}
          <div class="hl-row">
            <NotificationRow
              type={row.item.type as NotificationRowType}
              actor={row.item.actor}
              text={row.item.text}
              ts={row.item.ts}
              unread={row.item.unread ?? false}
              actionLabel={row.item.actionLabel ?? undefined}
              textDismiss
              onopen={() => void handleOpen(row.item)}
              ondismiss={() => handleHoverDismiss(row.item.id)}
              onreply={row.item.kind === 'dm'
                ? (text) => void replyDm(row.item, text)
                : undefined}
              onreact={row.item.kind === 'dm'
                ? (emoji) => void reactDm(row.item, emoji)
                : undefined}
              onholdchange={(h) => setReplyHold(row.item.id, h)}
            />
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if stack.visible.length > 0 && !hoverOpen}
    <div
      class="stack"
      data-testid="widget-stack"
      onpointerenter={() => setPointerHold(true)}
      onpointerleave={() => setPointerHold(false)}
    >
      {#each stack.visible as item (item.id)}
        <div class="frost" data-kind={item.kind}>
          <NotificationRow
            type={item.type as NotificationRowType}
            actor={item.actor}
            text={item.text}
            ts={item.ts}
            onopen={() => void handleOpen(item)}
            ondismiss={() => handleDismiss(item.id)}
            onreply={item.kind === 'dm' ? (text) => void replyDm(item, text) : undefined}
            onreact={item.kind === 'dm' ? (emoji) => void reactDm(item, emoji) : undefined}
            onholdchange={(h) => setReplyHold(item.id, h)}
          />
        </div>
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="wm"
    role="button"
    tabindex="0"
    aria-label="HQ notifications"
    onmouseenter={openHoverList}
    onclick={togglePinned}
    onkeydown={handleWordmarkKeydown}
  >
    <!-- Flat monochrome HQ wordmark (src/assets/hq-mark.svg, inlined so it
         inherits `currentColor` and needs no bundler asset wiring). -->
    <svg
      viewBox="0 0 280 161"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="HQ"
    >
      <path
        d="M85.7251 3.66162H118.034V154.434H85.7251V89.8176H32.3085V154.434H0V3.66162H32.3085V57.5091H85.7251V3.66162Z"
      />
      <path
        d="M257.169 160.035L241.014 144.096C235.343 147.973 229.096 150.988 222.276 153.142C215.527 155.296 208.419 156.373 200.952 156.373C190.757 156.373 181.172 154.363 172.197 150.342C163.223 146.25 155.325 140.65 148.505 133.542C141.684 126.362 136.335 118.07 132.458 108.664C128.581 99.187 126.642 89.0278 126.642 78.1865C126.642 67.417 128.581 57.3296 132.458 47.9242C136.335 38.4471 141.684 30.1187 148.505 22.939C155.325 15.7593 163.223 10.1592 172.197 6.1386C181.172 2.0462 190.757 0 200.952 0C211.219 0 220.84 2.0462 229.814 6.1386C238.789 10.1592 246.686 15.7593 253.507 22.939C260.328 30.1187 265.641 38.4471 269.446 47.9242C273.323 57.3296 275.261 67.417 275.261 78.1865C275.261 86.0123 274.184 93.5151 272.031 100.695C269.948 107.803 267.077 114.444 263.415 120.618L280 137.203L257.169 160.035ZM200.952 124.065C203.896 124.065 206.732 123.741 209.46 123.095C212.26 122.449 214.952 121.552 217.537 120.403L208.491 111.357L231.322 88.5252L239.291 96.4946C240.512 93.6946 241.409 90.7509 241.984 87.6637C242.63 84.5764 242.953 81.4173 242.953 78.1865C242.953 71.8684 241.84 65.9452 239.614 60.4168C237.461 54.8885 234.445 50.0422 230.568 45.878C226.691 41.642 222.204 38.3394 217.106 35.9701C212.08 33.529 206.696 32.3085 200.952 32.3085C195.208 32.3085 189.788 33.529 184.69 35.9701C179.664 38.3394 175.213 41.642 171.336 45.878C167.459 50.0422 164.407 54.8885 162.182 60.4168C160.028 65.9452 158.951 71.8684 158.951 78.1865C158.951 84.5046 160.028 90.4637 162.182 96.0639C164.407 101.592 167.459 106.474 171.336 110.71C175.213 114.875 179.664 118.141 184.69 120.511C189.788 122.88 195.208 124.065 200.952 124.065Z"
      />
    </svg>
    {#if badgeCount > 0}
      <span class="qd" data-testid="widget-unread-badge">{badgeCount}</span>
    {/if}
  </span>
</div>

<style>
  /* Per-window body rules — see src/main.ts data-window comment. */
  :global(html[data-window='widget']),
  :global(html[data-window='widget'] body) {
    background: transparent;
    margin: 0;
    overflow: hidden;
  }

  .wg {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: flex-end;
    /* Headroom above/right of the mark for the queued-count superscript. */
    padding: 10px 10px 0 0;
    box-sizing: border-box;
    background: transparent;
    overflow: hidden;
    /* Stack/row appearance tokens — light default; dark overrides below. */
    --row-bg: rgba(250, 250, 252, 0.6);
    --row-bg-hover: rgba(250, 250, 252, 0.92);
    --row-border: rgba(255, 255, 255, 0.6);
    --row-fg: #1d1d1f;
    --row-muted: rgba(0, 0, 0, 0.45);
    --row-shadow: 0 8px 22px rgba(20, 22, 40, 0.16);
    --row-highlight: rgba(255, 255, 255, 0.75);
    --row-hover-bg: rgba(0, 0, 0, 0.06);
    --reply-bg: rgba(0, 0, 0, 0.05);
    --reply-border: rgba(0, 0, 0, 0.14);
    --qd-fg: #0064d6;
  }

  /* Notification stack — column of one-line rows ABOVE the wordmark. */
  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  /* Frosted glass shell around NotificationRow (mockup .row chrome). */
  .frost {
    width: 244px;
    border-radius: 9px;
    background: var(--row-bg);
    -webkit-backdrop-filter: blur(26px) saturate(1.7);
    backdrop-filter: blur(26px) saturate(1.7);
    border: 0.5px solid var(--row-border);
    box-shadow: var(--row-shadow), inset 0 1px 0 var(--row-highlight);
    animation: widget-slide 0.4s cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
    box-sizing: border-box;
    overflow: hidden;
    /* Bridge NotificationRow's popover tokens onto the widget scheme. */
    --popover-text: var(--row-fg);
    --popover-text-muted: var(--row-muted);
    --popover-action-hover: var(--row-hover-bg);
    --popover-unread: var(--qd-fg, #0064d6);
    --popover-surface: var(--reply-bg);
    --popover-divider: var(--reply-border);
  }

  /* Hover recent-notification list — single frosted panel above the mark. */
  .hover-list {
    width: 264px;
    border-radius: 12px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--row-bg);
    -webkit-backdrop-filter: blur(30px) saturate(1.8);
    backdrop-filter: blur(30px) saturate(1.8);
    border: 0.5px solid var(--row-border);
    box-shadow: var(--row-shadow), inset 0 1px 0 var(--row-highlight);
    margin-bottom: 12px;
    transform-origin: bottom right;
    animation: widget-bloom 0.32s cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
    box-sizing: border-box;
    flex-shrink: 0;
    /* Bridge NotificationRow's popover tokens (same as .frost). */
    --popover-text: var(--row-fg);
    --popover-text-muted: var(--row-muted);
    --popover-action-hover: var(--row-hover-bg);
    --popover-unread: var(--qd-fg, #0064d6);
    --popover-surface: var(--reply-bg);
    --popover-divider: var(--reply-border);
  }

  .hl-sep {
    padding: 7px 11px 3px;
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.9px;
    text-transform: uppercase;
    color: var(--row-muted);
  }

  /* Empty pinned list — one row of muted copy so a wordmark click always shows feedback. */
  .hl-empty {
    min-height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 11px;
    font-size: 12px;
    color: var(--row-muted);
    box-sizing: border-box;
  }

  .hl-row :global(.nr) {
    min-height: 28px;
    font-size: 12px;
    border-radius: 7px;
    background: transparent;
    color: var(--row-fg);
    width: 100%;
    box-sizing: border-box;
  }

  .hl-row :global(.nr:not(.nr-message):hover),
  .hl-row :global(.nr:not(.nr-message):focus-within),
  .hl-row :global(.nr-message.nr-expanded) {
    background: var(--row-hover-bg);
  }

  .hl-row :global(.nr-open),
  .hl-row :global(.nr-dismiss),
  .hl-row :global(.nr-react) {
    background: var(--row-hover-bg);
    color: var(--row-fg);
  }

  .hl-row :global(.nr-reply) {
    background: var(--reply-bg);
    border-color: var(--reply-border);
    color: var(--row-fg);
  }

  /* Row sits transparent on the frost; hover uses row-bg-hover. */
  .frost :global(.nr) {
    background: transparent;
    color: var(--row-fg);
    width: 100%;
    box-sizing: border-box;
  }

  .frost :global(.nr-message.nr-expanded) {
    background: var(--row-bg-hover);
  }

  .frost :global(.nr:not(.nr-message):hover),
  .frost :global(.nr:not(.nr-message):focus-within) {
    background: var(--row-bg-hover);
  }

  .frost :global(.nr-open),
  .frost :global(.nr-dismiss),
  .frost :global(.nr-react) {
    background: var(--row-hover-bg);
    color: var(--row-fg);
  }

  .frost :global(.nr-reply) {
    background: var(--reply-bg);
    border-color: var(--reply-border);
    color: var(--row-fg);
  }

  @keyframes widget-slide {
    from {
      transform: translateY(10px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes widget-bloom {
    from {
      transform: scale(0.92) translateY(8px);
      opacity: 0;
    }
    to {
      transform: scale(1) translateY(0);
      opacity: 1;
    }
  }

  .wm {
    position: relative;
    display: inline-flex;
    color: var(--wm-fg);
    opacity: 0.38;
    transition: opacity 0.18s ease;
    flex-shrink: 0;
    cursor: pointer;
    /* Light default; dark overrides below. */
    --wm-fg: #1d1d1f;
    --wm-shadow: drop-shadow(0 1px 4px rgba(255, 255, 255, 0.5));
    --qd-fg: #0064d6;
  }

  .wg:hover .wm {
    opacity: 1;
  }

  .wm :global(svg) {
    width: 56px;
    height: auto;
    display: block;
    filter: var(--wm-shadow);
  }

  /* Plain superscript — no background, border, or border-radius. */
  .qd {
    position: absolute;
    top: -9px;
    right: -9px;
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--qd-fg);
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) {
    .wg {
      --row-bg: rgba(30, 30, 34, 0.55);
      --row-bg-hover: rgba(38, 38, 42, 0.85);
      --row-border: rgba(255, 255, 255, 0.14);
      --row-fg: #fff;
      --row-muted: rgba(255, 255, 255, 0.48);
      --row-shadow: 0 8px 22px rgba(0, 0, 0, 0.32);
      --row-highlight: rgba(255, 255, 255, 0.16);
      --row-hover-bg: rgba(255, 255, 255, 0.1);
      --reply-bg: rgba(255, 255, 255, 0.08);
      --reply-border: rgba(255, 255, 255, 0.18);
      --qd-fg: #6cb2ff;
    }

    .wm {
      --wm-fg: #fff;
      --wm-shadow: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.45));
      --qd-fg: #6cb2ff;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .frost {
      animation: none;
    }

    .hover-list {
      animation: none;
    }
  }
</style>
