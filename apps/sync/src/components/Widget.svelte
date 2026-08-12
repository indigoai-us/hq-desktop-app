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
  import { onMount, tick, untrack } from 'svelte';
  import NotificationRow from './NotificationRow.svelte';
  import type { NotificationRowType } from './NotificationRow.svelte';
  import {
    type BannerPayloadLike,
    type WidgetStackItem,
    type WidgetStackState,
    WIDGET_RECENT_STORAGE_KEY,
    addItem,
    bannerToStackItem,
    channelToStackItem,
    compactHoverItems,
    deserializeRecent,
    dismissItem,
    dismissRecent,
    expireItems,
    historyFeedItemToStackItem,
    hoverRows,
    markQueueSeen,
    markRecentRead,
    mergeRecentWithHistory,
    serializeRecent,
    setHeld,
    setOccluded,
    unreadRecentCount,
    widgetEmptyHoverWindowSize,
    widgetHoverWindowSize,
    widgetWindowSize,
  } from '../stores/widgetNotifications';
  import {
    getLastReadTs,
    loadNotificationTimeline,
  } from '../lib/notificationFeedData';
  import type { Channel } from '../lib/channels';
  import { safeUnlisten } from '../lib/listener-registry';
  import {
    DESKTOP_ZOOM_CHANGE_EVENT,
    normalizeDesktopZoom,
    scaleDesktopWindowSize,
  } from '../lib/desktopZoom';

  let {
    /** Initial/test seed for the queued superscript when the stack is empty. */
    queued = 0,
    /** Seed visible rows for happy-dom tests (no Tauri). */
    initialItems = [],
  }: {
    queued?: number;
    initialItems?: WidgetStackItem[];
  } = $props();

  function currentDesktopZoom(): number {
    if (typeof document === 'undefined') return 1;
    return normalizeDesktopZoom(
      Number(document.documentElement.dataset.desktopZoom) / 100,
    );
  }

  function createActionRequestId(): string {
    const nativeId = globalThis.crypto?.randomUUID?.();
    return nativeId ??
      `widget-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  let desktopZoom = $state(untrack(currentDesktopZoom));

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
  /** Secondary actions currently in flight; prevents duplicate install taps. */
  let actioningIds = $state(new Set<string>());
  /** Window jumps stay visible and disabled until their native invoke settles. */
  let navigationPending = $state<'inbox' | 'desktop' | null>(null);
  /** Native history hydration is distinct from a trusted, genuinely empty inbox. */
  let historyHydration = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  /** Keeps the explicit history Retry action mounted with progress feedback. */
  let historyRetryPending = $state(false);
  /** A double desktop-open failure remains visible until retry or dismissal. */
  let desktopNavigationError = $state<string | null>(null);
  /** Last-request-wins guard for history/update hydration across native events. */
  let historyLoadGeneration = 0;

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
  let lastSent: { width: number; height: number; zoom: number } | null = null;

  /** Hover recent-list open state + collapse delay timer. */
  let hoverOpen = $state(false);
  /** Click-pinned open — survives pointerleave until click-away or re-click. */
  let pinned = $state(false);
  /** Wordmark right-click menu (Inbox + Open desktop view). */
  let contextMenuOpen = $state(false);
  let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let wordmarkElement = $state<HTMLElement | null>(null);
  let contextMenuElement = $state<HTMLElement | null>(null);
  let hoverListElement = $state<HTMLElement | null>(null);

  /** Tracks native focusable state (non-reactive — avoids effect loops). */
  let widgetFocusable = false;

  const hoverDisplayItems = $derived(hoverOpen ? compactHoverItems(stack) : []);
  const hoverList = $derived(hoverRows(hoverDisplayItems, Date.now()));
  const hoverMessageRows = $derived(
    hoverOpen
      ? hoverRows(
          hoverDisplayItems.filter((item) => isConversationItem(item)),
          Date.now(),
        )
      : [],
  );
  const hoverActivityRows = $derived(
    hoverOpen
      ? hoverRows(
          hoverDisplayItems.filter((item) => !isConversationItem(item)),
          Date.now(),
        )
      : [],
  );
  const hoverConversationUnread = $derived(
    hoverDisplayItems.filter(
      (item) => isConversationItem(item) && item.unread === true,
    ).length,
  );

  function isConversationItem(item: WidgetStackItem): boolean {
    return item.kind === 'dm' || item.kind === 'channel';
  }

  function conversationUnreadFor(item: WidgetStackItem): number {
    if (item.kind === 'dm' && item.compactGroupCount) {
      return Math.max(0, item.compactGroupUnreadCount ?? 0);
    }
    if (
      item.kind !== 'channel' ||
      !item.data ||
      typeof item.data !== 'object'
    ) {
      return 0;
    }
    const unread = (item.data as { unread?: unknown }).unread;
    return typeof unread === 'number' && Number.isFinite(unread)
      ? Math.max(0, Math.round(unread))
      : 0;
  }

  function hasTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  function notificationSourceLabel(item: WidgetStackItem): string {
    switch (item.kind) {
      case 'dm':
        return item.compactGroupCount && item.compactGroupCount > 1
          ? `${item.compactGroupCount} recent messages`
          : 'Direct message';
      case 'channel': {
        const scope =
          item.data && typeof item.data === 'object' && 'scope' in item.data
            ? String((item.data as { scope?: unknown }).scope ?? '')
            : '';
        const company =
          item.data && typeof item.data === 'object' && 'companyName' in item.data
            ? String((item.data as { companyName?: unknown }).companyName ?? '').trim()
            : '';
        if (scope === 'group') return 'Group DM';
        return company ? `Channel · ${company}` : 'Channel';
      }
      case 'share':
        return 'Shared';
      case 'new-file':
        return item.compactGroupCount && item.compactGroupCount > 1
          ? `Activity · ${item.compactGroupCount} updates`
          : 'Activity';
      case 'update':
        return 'Update';
      case 'meeting':
        return 'Meeting';
      default:
        return item.type === 'sync'
          ? item.compactGroupCount && item.compactGroupCount > 1
            ? `Activity · ${item.compactGroupCount} updates`
            : 'Activity'
          : 'Notice';
    }
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

  function focusSoon(element: HTMLElement | null): void {
    void tick().then(() => element?.focus());
  }

  async function focusFirstContextItem(): Promise<void> {
    await tick();
    contextMenuElement
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }

  function openHoverList(): void {
    if (hoverCloseTimer !== undefined) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
    if (hoverOpen) return;
    // Right-click menu owns the chrome slot — don't steal it with hover.
    if (contextMenuOpen) return;
    // A reply is focused / has a draft on a stack row. Switching surfaces
    // would unmount that row and destroy the draft — never hide a
    // notification mid-reply (US-012), so ignore the wordmark hover.
    if (replyHolds.size > 0) return;
    hoverOpen = true;
    hoverSeen = true;
    applyStack(markQueueSeen(stack));
  }

  /** Close a click-pinned list and clear unread (mark-on-leave watermark). */
  function closePinned(restoreFocus = false): void {
    pinned = false;
    hoverOpen = false;
    contextMenuOpen = false;
    desktopNavigationError = null;
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
    if (restoreFocus) focusSoon(wordmarkElement);
  }

  /**
   * Pin-open the mini inbox (hover/click notification + message list).
   * Used by wordmark click, update Open, and the context-menu Inbox action.
   */
  function openMiniInbox(): void {
    // Don't pin (and unmount a drafting stack row) mid-reply — see
    // openHoverList's reply-hold guard.
    if (replyHolds.size > 0) return;
    contextMenuOpen = false;
    desktopNavigationError = null;
    pinned = true;
    openHoverList();
    void setWidgetFocusable(true).then(() => focusSoon(hoverListElement));
  }

  function togglePinned(): void {
    if (pinned) {
      closePinned();
    } else {
      openMiniInbox();
    }
  }

  function closeContextMenu(restoreFocus = false): void {
    contextMenuOpen = false;
    desktopNavigationError = null;
    void setWidgetFocusable(false);
    if (restoreFocus) focusSoon(wordmarkElement);
  }

  function handleWordmarkContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    // Don't open the menu mid-reply (would unmount the draft surface).
    if (replyHolds.size > 0) return;
    // Context menu replaces the hover list while open (same chrome slot).
    hoverOpen = false;
    pinned = false;
    desktopNavigationError = null;
    contextMenuOpen = true;
    void setWidgetFocusable(true).then(() => focusFirstContextItem());
  }

  function handleWordmarkKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePinned();
    } else if (e.key === 'Escape' && (contextMenuOpen || pinned)) {
      e.preventDefault();
      if (contextMenuOpen) closeContextMenu(true);
      else closePinned(true);
    }
  }

  function handleContextMenuKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu(true);
      return;
    }
    if (
      e.key !== 'ArrowDown' &&
      e.key !== 'ArrowUp' &&
      e.key !== 'Home' &&
      e.key !== 'End'
    ) {
      return;
    }
    const items = [
      ...(contextMenuElement?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function handleHoverListKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !pinned) return;
    e.preventDefault();
    e.stopPropagation();
    closePinned(true);
  }

  /**
   * Open the two-pane communications window (side pane + detail/reply canvas).
   * Used by context menu + mini-popup footer icons.
   */
  async function menuOpenInbox(): Promise<void> {
    if (navigationPending) return;
    navigationPending = 'inbox';
    if (!hasTauri()) {
      closeContextMenu();
      openMiniInbox();
      navigationPending = null;
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_communications_window');
      if (pinned || hoverOpen) closePinned();
      else closeContextMenu();
    } catch (err) {
      console.error('widget: open_communications_window failed', err);
      openMiniInbox();
    } finally {
      navigationPending = null;
    }
  }

  /** Open the full desktop app (tray "Open desktop view" path). */
  async function menuOpenDesktop(): Promise<void> {
    if (navigationPending) return;
    navigationPending = 'desktop';
    if (!hasTauri()) {
      closeContextMenu();
      navigationPending = null;
      return;
    }
    let opened = false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_desktop_alt_window');
      opened = true;
    } catch (err) {
      console.error('widget: open_desktop_alt_window failed', err);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('show_main_window');
        opened = true;
      } catch (err2) {
        console.error('widget: show_main_window fallback failed', err2);
        desktopNavigationError =
          'Couldn’t open HQ. Check that the desktop app is available, then retry.';
      }
    } finally {
      if (opened) {
        if (pinned || hoverOpen) closePinned();
        else closeContextMenu();
      }
      navigationPending = null;
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
    if (!hasTauri()) {
      setReplyHold(item.id, false);
      applyStack(dismissItem(stack, item.id));
      if (stack.visible.length === 0) {
        setPointerHold(false);
      }
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const explicitClickAction =
        item.clickActionId !== '' &&
        item.clickActionId !== 'open' &&
        !item.clickActionId.startsWith('open-');
      // Route Open by kind + source data. Prefer direct open_* invokes so the
      // widget does not depend on the (often hidden) main webview's
      // notification:banner-action listener. Kind-based fallbacks keep
      // localStorage-hydrated rows (action surface stripped) usable.
      if (explicitClickAction) {
        const payload: BannerPayloadLike = {
          kind: item.kind,
          title: item.actor ?? '',
          body: item.text,
          clickActionId: item.clickActionId,
          data: item.data,
          actionId: item.actionId,
          actionLabel: item.actionLabel,
        };
        await invoke('banner_action', {
          requestId: createActionRequestId(),
          action: item.clickActionId,
          payload,
        });
      } else if (item.kind === 'dm' && item.data) {
        await invoke('open_dm_detail', { event: item.data });
      } else if (item.kind === 'channel') {
        await invoke('open_communications_window', { channel: item.data });
      } else if (item.kind === 'share' && item.data) {
        await invoke('open_share_detail', { events: [item.data] });
      } else if (item.kind === 'new-file' || item.type === 'sync') {
        const company =
          item.data && typeof item.data === 'object' && item.data !== null
            ? (item.data as { company?: string }).company
            : undefined;
        if (company) {
          await invoke('open_desktop_alt_window', {
            // US-020: the Activity page is gone — land on the company Overview digest.
            route: `company:${company}`,
          });
        } else {
          // No company slug — open the two-pane communications window.
          await invoke('open_communications_window');
        }
      } else if (item.kind === 'update') {
        // The row body is navigation, never a surprise restart. Updates have a
        // first-class destination; never strand this notification in a generic
        // Inbox that may not have updater history hydrated yet.
        await invoke('open_desktop_alt_window', { route: 'settings:updates' });
      } else if (item.kind === 'meeting') {
        await invoke('show_main_window');
      } else if (item.clickActionId) {
        const payload: BannerPayloadLike = {
          kind: item.kind,
          title: item.actor ?? '',
          body: item.text,
          clickActionId: item.clickActionId,
          data: item.data,
          actionId: item.actionId,
          actionLabel: item.actionLabel,
        };
        await invoke('banner_action', {
          requestId: createActionRequestId(),
          action: item.clickActionId,
          payload,
        });
      } else {
        // Display-only / unknown — two-pane communications, not full desktop.
        await invoke('open_communications_window');
      }
      // A failed native open leaves the draft-owning row mounted. Release its
      // parent hold only after the destination has actually acknowledged.
      setReplyHold(item.id, false);
      applyStack(dismissItem(stack, item.id));
      // Opening the last row unmounts .stack without a pointerleave —
      // clear the pointer hold so the next notification still auto-hides.
      if (stack.visible.length === 0) {
        setPointerHold(false);
      }
    } catch (err) {
      console.error('widget: open failed', err);
      throw err;
    }
  }

  async function handleAction(item: WidgetStackItem): Promise<void> {
    if (!item.actionId || actioningIds.has(item.id)) {
      if (!item.actionId) await handleOpen(item);
      return;
    }
    if (!hasTauri()) return;

    actioningIds = new Set(actioningIds).add(item.id);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const payload: BannerPayloadLike = {
        kind: item.kind,
        title: item.actor ?? '',
        body: item.text,
        clickActionId: item.clickActionId || 'open',
        data: item.data,
        actionId: item.actionId,
        actionLabel: item.actionLabel,
      };
      await invoke('banner_action', {
        requestId: createActionRequestId(),
        action: item.actionId,
        payload,
      });
      const completedIds = new Set(item.compactGroupIds ?? [item.id]);
      const dismissed = dismissItem(stack, item.id);
      applyStack({
        ...dismissed,
        recent: dismissed.recent.map((recentItem) =>
          completedIds.has(recentItem.id)
            ? {
                ...recentItem,
                actionId: undefined,
                actionLabel: undefined,
              }
            : recentItem
        ),
      });
      if (stack.visible.length === 0) setPointerHold(false);
    } catch (err) {
      console.error('widget: action failed', err);
      throw err;
    } finally {
      const next = new Set(actioningIds);
      next.delete(item.id);
      actioningIds = next;
    }
  }

  /**
   * Seed/refresh recent from trusted notification history and pending updater
   * state. Confirmed native absence removes stale persisted update rows; an IPC
   * failure preserves their safe display-only form.
   */
  async function refreshRecentFromHistory(): Promise<void> {
    if (!hasTauri()) return;
    const generation = ++historyLoadGeneration;
    historyHydration = 'loading';
    try {
      const timeline = await loadNotificationTimeline();
      if (generation !== historyLoadGeneration) return;
      if (timeline.historyState === 'failed') {
        throw new Error('Native notification history is unavailable');
      }
      const items = timeline.items;
      const lastRead = getLastReadTs();
      const historyRows = items.map((it) => historyFeedItemToStackItem(it, lastRead));
      let channelRows: WidgetStackItem[] | null = null;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const response = await invoke<{ channels?: Channel[] } | null>('list_channels');
        channelRows = (response?.channels ?? [])
          .filter((channel) => (channel.unread ?? 0) > 0)
          .map((channel) => channelToStackItem(channel, Date.now()));
      } catch (err) {
        // Keep the last trusted channel rows if this independent fetch fails.
        console.error('widget: list_channels failed', err);
      }
      if (generation !== historyLoadGeneration) return;
      const updatesAuthoritative = timeline.updateState === 'resolved';
      const hasPendingUpdate = items.some((it) => it.kind === 'update');
      const mergedHistory = mergeRecentWithHistory(stack.recent, historyRows, {
        updatesAuthoritative,
      });
      const mergedRecent =
        channelRows === null
          ? mergedHistory
          : [
              ...channelRows,
              ...mergedHistory.filter((item) => item.kind !== 'channel'),
            ]
              .sort((a, b) => b.ts - a.ts)
              .slice(0, 20);
      applyStack({
        ...stack,
        visible:
          updatesAuthoritative && !hasPendingUpdate
            ? stack.visible.filter((it) => it.kind !== 'update')
            : stack.visible,
        queued:
          updatesAuthoritative && !hasPendingUpdate
            ? stack.queued.filter((it) => it.kind !== 'update')
            : stack.queued,
        recent: mergedRecent,
      });
      historyHydration = 'ready';
    } catch (err) {
      console.error('widget: fetch_notification_history failed', err);
      if (generation === historyLoadGeneration) {
        historyHydration = 'error';
      }
    }
  }

  async function retryRecentHistory(): Promise<void> {
    if (historyRetryPending || historyHydration === 'loading') return;
    historyRetryPending = true;
    try {
      await refreshRecentFromHistory();
    } finally {
      historyRetryPending = false;
    }
  }

  /**
   * Dismiss pill inside the pinned popup / hover list. Removes the row from
   * recent + visible; when the LAST row goes, the panel unmounts without a
   * pointerleave — close it fully (clears the pointer hold, restores the
   * non-activating window, and resets pinned/hoverOpen) so auto-hide and
   * window sizing never wedge on an empty invisible panel.
   */
  function handleHoverDismiss(item: WidgetStackItem): void {
    const ids = item.compactGroupIds ?? [item.id];
    let next = stack;
    for (const id of ids) {
      setReplyHold(id, false);
      next = dismissRecent(next, id);
    }
    applyStack(next);
    if (compactHoverItems(stack).length === 0) {
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
   * Failures propagate to NotificationRow so the draft stays visible and can
   * be retried. The native window remains focusable after failure.
   */
  async function replyDm(item: WidgetStackItem, text: string): Promise<void> {
    if (!hasTauri()) throw new Error('Quick reply requires the HQ desktop bridge');
    const peer = (item.data as { fromPersonUid?: string } | null)?.fromPersonUid;
    if (!peer || !text.trim()) {
      throw new Error('Quick reply is missing a recipient or message');
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('send_dm', { toPersonUid: peer, body: text.trim() });
      void setWidgetFocusable(false);
    } catch (err) {
      console.error('widget: send_dm failed', err);
      throw err;
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
      const target = e.target as HTMLElement | null;
      if (contextMenuOpen) {
        if (target?.closest?.('.ctx-menu') || target?.closest?.('.wm')) return;
        closeContextMenu();
        return;
      }
      if (!pinned) return;
      if (target?.closest?.('.hover-list') || target?.closest?.('.wm')) return;
      closePinned();
    }

    function handleWindowBlur(): void {
      // Never collapse mid-reply — focusing the quick-reply input toggles the
      // native window focusable, which makes blur events likely during exactly
      // the flow US-012 protects (match the click-away guards).
      if (replyHolds.size > 0) return;
      if (contextMenuOpen) closeContextMenu();
      if (pinned) closePinned();
    }

    function handleDesktopZoomChange(event: Event): void {
      const detail = (event as CustomEvent<{ zoom?: unknown }>).detail;
      desktopZoom = normalizeDesktopZoom(detail?.zoom);
    }

    document.addEventListener('pointerdown', handleClickAway, true);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener(DESKTOP_ZOOM_CHANGE_EVENT, handleDesktopZoomChange);

    if (!hasTauri()) {
      historyHydration = 'ready';
      return () => {
        document.removeEventListener('pointerdown', handleClickAway, true);
        window.removeEventListener('blur', handleWindowBlur);
        window.removeEventListener(
          DESKTOP_ZOOM_CHANGE_EVENT,
          handleDesktopZoomChange,
        );
        if (expiryTimer !== undefined) clearInterval(expiryTimer);
        if (hoverCloseTimer !== undefined) clearTimeout(hoverCloseTimer);
      };
    }

    historyHydration = 'loading';
    let unlistenNotif: (() => void) | undefined;
    let unlistenOcc: (() => void) | undefined;
    let unlistenClickAway: (() => void) | undefined;
    let unlistenDm: (() => void) | undefined;
    let unlistenSync: (() => void) | undefined;
    let unlistenUpdate: (() => void) | undefined;
    let unlistenUpdateCleared: (() => void) | undefined;
    let unlistenChannelMessage: (() => void) | undefined;
    let unlistenChannelUpdated: (() => void) | undefined;
    let historyReloadTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const scheduleHistoryRefresh = () => {
      // Invalidate an in-flight response as soon as the native state changes;
      // the debounced replacement load will receive a newer generation.
      historyLoadGeneration += 1;
      historyHydration = 'loading';
      if (historyReloadTimer !== undefined) clearTimeout(historyReloadTimer);
      historyReloadTimer = setTimeout(() => {
        historyReloadTimer = undefined;
        void refreshRecentFromHistory();
      }, 300);
    };

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
        if (contextMenuOpen) closeContextMenu();
        if (pinned) closePinned();
      });

      // Keep recent history in sync with the real notification feed and native
      // pending updater state.
      unlistenDm = await listen('dm:unread-summary', scheduleHistoryRefresh);
      unlistenSync = await listen('sync:complete', scheduleHistoryRefresh);
      unlistenUpdate = await listen('update:available', scheduleHistoryRefresh);
      unlistenUpdateCleared = await listen('update:cleared', scheduleHistoryRefresh);
      unlistenChannelMessage = await listen('channel:new-message', scheduleHistoryRefresh);
      unlistenChannelUpdated = await listen('channel:updated', scheduleHistoryRefresh);

      const { invoke } = await import('@tauri-apps/api/core');
      if (cancelled) return;
      // Ready-handshake: Rust replies with the initial widget:occlusion.
      await invoke('widget_ready').catch((err: unknown) => {
        console.error('widget: widget_ready failed', err);
      });
      // Seed ~10 openable history rows (US-015 + Lizzie inbox mockup).
      if (!cancelled) await refreshRecentFromHistory();
    })();

    return () => {
      cancelled = true;
      historyLoadGeneration += 1;
      document.removeEventListener('pointerdown', handleClickAway, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener(
        DESKTOP_ZOOM_CHANGE_EVENT,
        handleDesktopZoomChange,
      );
      safeUnlisten(unlistenNotif)();
      safeUnlisten(unlistenOcc)();
      safeUnlisten(unlistenClickAway)();
      safeUnlisten(unlistenDm)();
      safeUnlisten(unlistenSync)();
      safeUnlisten(unlistenUpdate)();
      safeUnlisten(unlistenUpdateCleared)();
      safeUnlisten(unlistenChannelMessage)();
      safeUnlisten(unlistenChannelUpdated)();
      if (historyReloadTimer !== undefined) {
        clearTimeout(historyReloadTimer);
        historyReloadTimer = undefined;
      }
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

  // Grow/shrink the native window with the visible stack / hover list /
  // context menu (lower-right anchor stays fixed in Rust). Only when Tauri is
  // present and size actually changed.
  $effect(() => {
    let size: { width: number; height: number };
    if (contextMenuOpen) {
      // Two-row menu + chrome — same width as hover panel; slightly taller
      // than the empty-state panel so both items have full hit targets.
      size = widgetEmptyHoverWindowSize();
      size = {
        width: size.width,
        height: size.height + 28 + (desktopNavigationError ? 48 : 0),
      };
    } else if (hoverOpen) {
      const items = compactHoverItems(stack);
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
        if (historyHydration === 'loading' || historyHydration === 'error') {
          size = { width: size.width, height: size.height + 46 };
        }
      }
      if (desktopNavigationError) {
        size = { width: size.width, height: size.height + 48 };
      }
    } else {
      size = widgetWindowSize(stack);
    }
    size = scaleDesktopWindowSize(size, desktopZoom);
    if (!hasTauri()) return;
    if (
      lastSent &&
      lastSent.width === size.width &&
      lastSent.height === size.height &&
      lastSent.zoom === desktopZoom
    ) {
      return;
    }
    lastSent = { ...size, zoom: desktopZoom };
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('resize_widget', {
        width: size.width,
        height: size.height,
        zoom: desktopZoom,
      }).catch((err: unknown) => {
        console.error('widget: resize_widget failed', err);
      });
    });
  });
</script>

{#snippet miniCommunicationRow(row: { separator: string | null; item: WidgetStackItem })}
  {#if row.separator}<div class="hl-sep">{row.separator}</div>{/if}
  <div class="hl-row" data-kind={row.item.kind}>
    <NotificationRow
      type={row.item.type as NotificationRowType}
      actor={row.item.actor}
      sourceLabel={notificationSourceLabel(row.item)}
      text={row.item.text}
      ts={row.item.ts}
      unread={row.item.unread ?? false}
      badgeCount={conversationUnreadFor(row.item)}
      comfortable
      hoverExpand={row.item.kind === 'dm' && !row.item.compactGroupCount}
      actionLabel={row.item.actionLabel ?? undefined}
      actionDisabled={actioningIds.has(row.item.id)}
      textDismiss
      onopen={() => handleOpen(row.item)}
      onaction={row.item.actionId ? () => handleAction(row.item) : undefined}
      ondismiss={() => handleHoverDismiss(row.item)}
      onreply={row.item.kind === 'dm' && !row.item.compactGroupCount
        ? (text) => replyDm(row.item, text)
        : undefined}
      onreact={row.item.kind === 'dm' && !row.item.compactGroupCount
        ? (emoji) => reactDm(row.item, emoji)
        : undefined}
      onholdchange={(h) => setReplyHold(row.item.id, h)}
    />
  </div>
{/snippet}

{#snippet historyFeedback(compact = false)}
  <div
    class="hl-history-feedback"
    class:hl-history-feedback-compact={compact}
    data-testid={historyHydration === 'error'
      ? 'widget-history-error'
      : 'widget-history-loading'}
    role={historyHydration === 'error' ? 'alert' : 'status'}
    aria-live="polite"
  >
    <div class="hl-history-message">
      {#if historyHydration === 'loading'}
        <span class="widget-nav-spinner" aria-hidden="true"></span>
      {/if}
      <span>
        <strong>
          {historyHydration === 'error'
            ? 'Couldn’t refresh messages'
            : historyRetryPending
              ? 'Retrying message refresh'
              : 'Checking for messages'}
        </strong>
        <small>
          {historyHydration === 'error'
            ? 'Saved activity is still available.'
            : compact
              ? 'Showing saved activity while HQ checks for newer items.'
              : 'HQ is loading conversations and recent activity.'}
        </small>
      </span>
    </div>
    {#if historyHydration === 'error' || historyRetryPending}
      <button
        class="hl-inline-retry"
        type="button"
        data-testid="widget-history-retry"
        aria-busy={historyRetryPending}
        disabled={historyRetryPending}
        onclick={() => void retryRecentHistory()}
      >
        {#if historyRetryPending}
          <span class="widget-nav-spinner" aria-hidden="true"></span>
          Retrying…
        {:else}
          Retry
        {/if}
      </button>
    {/if}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="wg"
  class:surface-open={hoverOpen || contextMenuOpen}
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
  {#if contextMenuOpen}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="ctx-menu frost-panel"
      data-testid="widget-context-menu"
      role="menu"
      tabindex="-1"
      aria-label="HQ widget"
      bind:this={contextMenuElement}
      onkeydown={handleContextMenuKeydown}
      onpointerenter={() => setPointerHold(true)}
      onpointerleave={() => setPointerHold(false)}
    >
      <button
        class="ctx-item"
        type="button"
        role="menuitem"
        data-testid="widget-menu-inbox"
        aria-busy={navigationPending === 'inbox'}
        disabled={navigationPending !== null}
        onclick={() => void menuOpenInbox()}
      >
        {#if navigationPending === 'inbox'}
          <span class="widget-nav-spinner" data-testid="widget-navigation-spinner" aria-hidden="true"></span>
          Opening messages…
        {:else}
          Messages
        {/if}
      </button>
      <button
        class="ctx-item"
        type="button"
        role="menuitem"
        data-testid="widget-menu-desktop"
        aria-busy={navigationPending === 'desktop'}
        disabled={navigationPending !== null}
        onclick={() => void menuOpenDesktop()}
      >
        {#if navigationPending === 'desktop'}
          <span class="widget-nav-spinner" data-testid="widget-navigation-spinner" aria-hidden="true"></span>
          Opening desktop…
        {:else if desktopNavigationError}
          Retry desktop
        {:else}
          Open desktop view
        {/if}
      </button>
      {#if desktopNavigationError}
        <div
          class="ctx-error"
          data-testid="widget-desktop-error"
          role="alert"
          aria-live="assertive"
        >
          {desktopNavigationError}
        </div>
      {/if}
    </div>
  {:else if hoverOpen && (hoverList.length > 0 || pinned)}
    <div
      class="hover-list frost-panel"
      data-testid="widget-hover-list"
      role="dialog"
      aria-label="Messages and notifications"
      tabindex="-1"
      bind:this={hoverListElement}
      onkeydown={handleHoverListKeydown}
      onpointerenter={() => setPointerHold(true)}
      onpointerleave={() => setPointerHold(false)}
    >
      <div class="hl-header">
        <div class="hl-heading">
          <span class="hl-title">Messages</span>
          <span class="hl-summary">
            {#if hoverConversationUnread > 0}
              {hoverConversationUnread} new {hoverConversationUnread === 1 ? 'conversation' : 'conversations'}
            {:else}
              Conversations and recent activity
            {/if}
          </span>
        </div>
        {#if pinned}
          <button class="hl-close" type="button" aria-label="Close messages" onclick={() => closePinned(true)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
            </svg>
          </button>
        {/if}
      </div>
      <div class="hl-body">
        {#if hoverList.length === 0}
          {#if historyHydration === 'loading' || historyHydration === 'error'}
            {@render historyFeedback()}
          {:else}
            <div class="hl-empty" data-testid="widget-empty-state">
              <span class="hl-empty-title">You’re caught up</span>
              <span class="hl-empty-copy">New messages, channel activity, and shared work will appear here.</span>
            </div>
          {/if}
        {:else}
          {#if historyHydration === 'loading' || historyHydration === 'error'}
            {@render historyFeedback(true)}
          {/if}
          {#if hoverMessageRows.length > 0}
            <section class="hl-section" aria-labelledby="widget-conversations-label">
              <div class="hl-section-label" id="widget-conversations-label">Conversations</div>
              {#each hoverMessageRows as row (row.item.id)}
                {@render miniCommunicationRow(row)}
              {/each}
            </section>
          {/if}
          {#if hoverActivityRows.length > 0}
            <section class="hl-section" aria-labelledby="widget-activity-label">
              <div class="hl-section-label" id="widget-activity-label">Activity</div>
              {#each hoverActivityRows as row (row.item.id)}
                {@render miniCommunicationRow(row)}
              {/each}
            </section>
          {/if}
        {/if}
      </div>
      {#if desktopNavigationError}
        <div
          class="hl-desktop-error"
          data-testid="widget-desktop-error"
          role="alert"
          aria-live="assertive"
        >
          <span>{desktopNavigationError}</span>
          <button
            class="hl-inline-retry"
            type="button"
            aria-busy={navigationPending === 'desktop'}
            disabled={navigationPending !== null}
            onclick={() => void menuOpenDesktop()}
          >
            {#if navigationPending === 'desktop'}
              <span class="widget-nav-spinner" aria-hidden="true"></span>
              Retrying…
            {:else}
              Retry
            {/if}
          </button>
        </div>
      {/if}
      <div class="hl-footer" data-testid="widget-hover-footer" role="toolbar" aria-label="Message destinations">
        <button
          class="hl-open-messages"
          type="button"
          data-testid="widget-hover-inbox"
          aria-label="Open messages"
          aria-busy={navigationPending === 'inbox'}
          disabled={navigationPending !== null}
          onclick={() => void menuOpenInbox()}
        >
          {#if navigationPending === 'inbox'}
            <span class="widget-nav-spinner" data-testid="widget-navigation-spinner" aria-hidden="true"></span>
            Opening…
          {:else}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3.5 2.6V11h0a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
            </svg>
            Open messages
          {/if}
        </button>
        <button
          class="hl-open-desktop"
          type="button"
          data-testid="widget-hover-desktop"
          aria-label={desktopNavigationError ? 'Retry opening HQ' : 'Open HQ'}
          aria-busy={navigationPending === 'desktop'}
          disabled={navigationPending !== null}
          onclick={() => void menuOpenDesktop()}
        >
          {#if navigationPending === 'desktop'}
            <span class="widget-nav-spinner" data-testid="widget-navigation-spinner" aria-hidden="true"></span>
            Opening HQ…
          {:else}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="1.75"
                y="2.5"
                width="12.5"
                height="8.5"
                rx="1.25"
                stroke="currentColor"
                stroke-width="1.35"
              />
              <path
                d="M5 13.5h6M8 11v2.5"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
              />
            </svg>
            Open HQ
          {/if}
        </button>
      </div>
    </div>
  {/if}

  {#if stack.visible.length > 0 && !hoverOpen}
    <div
      class="stack"
      class:stack-single={stack.visible.length === 1}
      class:stack-grouped={stack.visible.length > 1}
      data-testid="widget-stack"
      onpointerenter={() => setPointerHold(true)}
      onpointerleave={() => setPointerHold(false)}
    >
      {#each stack.visible as item (item.id)}
        <div class="frost" data-kind={item.kind}>
          <NotificationRow
            type={item.type as NotificationRowType}
            actor={item.actor}
            sourceLabel={notificationSourceLabel(item)}
            text={item.text}
            ts={item.ts}
            actionLabel={item.actionLabel ?? undefined}
            actionDisabled={actioningIds.has(item.id)}
            onopen={() => handleOpen(item)}
            onaction={item.actionId ? () => handleAction(item) : undefined}
            ondismiss={() => handleDismiss(item.id)}
            onreply={item.kind === 'dm' ? (text) => replyDm(item, text) : undefined}
            onreact={item.kind === 'dm' ? (emoji) => reactDm(item, emoji) : undefined}
            onholdchange={(h) => setReplyHold(item.id, h)}
          />
        </div>
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="wm"
    bind:this={wordmarkElement}
    role="button"
    tabindex="0"
    aria-label="HQ notifications"
    aria-haspopup="dialog"
    aria-expanded={contextMenuOpen || pinned || hoverOpen}
    onmouseenter={openHoverList}
    onclick={togglePinned}
    oncontextmenu={handleWordmarkContextMenu}
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
    padding: 8px 8px 2px 0;
    box-sizing: border-box;
    background: transparent;
    overflow: hidden;
    /* Stack/row appearance tokens — light default; dark overrides below. */
    --row-bg: rgb(245 245 245 / clamp(0.82, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.277), 1));
    --row-bg-hover: rgb(250 250 250 / clamp(0.94, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.092), 1));
    --row-border: rgba(255, 255, 255, 0.82);
    --row-fg: #171717;
    --row-muted: rgba(0, 0, 0, 0.66);
    --row-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
    --row-highlight: rgba(255, 255, 255, 0.9);
    --row-hover-bg: rgba(0, 0, 0, 0.08);
    --reply-bg: rgba(0, 0, 0, 0.07);
    --reply-border: rgba(0, 0, 0, 0.18);
    --qd-fg: #333333;
    /* The widget has no window-sized native material because that would turn
       its transparent click-through canvas into a visible rectangle. Keep the
       stronger pre-redesign sampling local to its actual glass shells. */
    --glass-filter: blur(30px) saturate(175%) contrast(103%);
    --glass-filter-soft: blur(16px) saturate(145%) contrast(102%);
  }

  /* Notification stack — column of one-line rows ABOVE the wordmark. */
  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0;
    margin-bottom: 10px;
    flex-shrink: 0;
  }

  /* A single transient alert is a real toast card. When two or more alerts are
     live, `.stack-grouped` owns ONE glass material and its NotificationRows
     become flat divided children — never a pile of rounded glass boxes. */
  .stack-grouped,
  .stack-single .frost {
    border: 0.5px solid var(--row-border);
    border-radius: var(--radius-popover, 8px);
    background: var(--row-bg);
    -webkit-backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    box-shadow: var(--row-shadow), inset 0 1px 0 var(--row-highlight);
  }

  .stack-grouped {
    width: 348px;
    overflow: hidden;
    box-sizing: border-box;
  }

  .frost {
    width: 348px;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    animation: widget-arrive 180ms cubic-bezier(0.23, 1, 0.32, 1) backwards;
    box-sizing: border-box;
    overflow: hidden;
    /* Bridge NotificationRow's popover tokens onto the widget scheme. */
    --popover-text: var(--row-fg);
    --popover-text-muted: var(--row-muted);
    --popover-action-hover: var(--row-hover-bg);
    --popover-unread: var(--qd-fg, #333333);
    --popover-surface: var(--reply-bg);
    --popover-divider: var(--reply-border);
  }

  .stack-grouped .frost {
    width: 100%;
  }

  .stack-grouped .frost + .frost {
    border-top: 0.5px solid color-mix(in srgb, var(--row-border) 78%, transparent);
  }

  /* Hover recent-notification list — single frosted panel above the mark. */
  .hover-list {
    width: 364px;
    max-height: calc(100vh - 61px);
    border-radius: var(--radius-popover, 8px);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: var(--row-bg);
    -webkit-backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    border: 0.5px solid var(--row-border);
    box-shadow: var(--row-shadow), inset 0 1px 0 var(--row-highlight);
    margin-bottom: 14px;
    transform-origin: bottom right;
    animation: widget-panel-in 110ms cubic-bezier(0.23, 1, 0.32, 1) backwards;
    box-sizing: border-box;
    flex-shrink: 0;
    overflow: hidden;
    /* Bridge NotificationRow's popover tokens (same as .frost). */
    --popover-text: var(--row-fg);
    --popover-text-muted: var(--row-muted);
    --popover-action-hover: var(--row-hover-bg);
    --popover-unread: var(--qd-fg, #333333);
    --popover-surface: var(--reply-bg);
    --popover-divider: var(--reply-border);
  }

  .hl-body {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-color: var(--row-border) transparent;
    scrollbar-width: thin;
  }

  .hl-header {
    min-height: 60px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px 10px 16px;
    border-bottom: 0.5px solid var(--row-border);
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .hl-heading {
    min-width: 0;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
  }

  .hl-title {
    color: var(--row-fg);
    font-size: 14.5px;
    font-weight: 680;
    letter-spacing: -0.012em;
  }

  .hl-summary {
    overflow: hidden;
    color: var(--row-muted);
    font-size: 11px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hl-close {
    width: 28px;
    height: 28px;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-radius: var(--radius-button, 6px);
    background: transparent;
    color: var(--row-muted);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .hl-close:hover {
    background: var(--row-hover-bg);
    color: var(--row-fg);
  }

  .hl-close:focus-visible {
    background: var(--row-hover-bg);
    color: var(--row-fg);
    outline: 2px solid var(--row-fg);
    outline-offset: -2px;
  }

  .hl-section {
    padding: 0 8px;
  }

  .hl-section + .hl-section {
    margin-top: 7px;
    padding-top: 7px;
    border-top: 0.5px solid var(--row-border);
  }

  .hl-section-label {
    padding: 10px 8px 5px;
    color: var(--row-muted);
    font-size: 9.5px;
    font-weight: 680;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  /* The compact window has two visible destinations: Messages and full HQ. */
  .hl-footer {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 7px 10px;
    border-top: 0.5px solid var(--row-border);
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .hl-open-messages,
  .hl-open-desktop {
    min-width: 0;
    height: 32px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-button, 6px);
    background: transparent;
    color: var(--row-fg);
    font: inherit;
    font-size: 11.5px;
    font-weight: 650;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .hl-open-messages {
    flex: 1;
  }

  .hl-open-desktop {
    flex: 0 0 auto;
    color: var(--row-muted);
    padding-inline: 9px;
  }

  .hl-open-messages:hover,
  .hl-open-desktop:hover {
    background: var(--row-hover-bg);
    color: var(--row-fg);
  }

  .hl-open-messages:focus-visible,
  .hl-open-desktop:focus-visible {
    background: var(--row-hover-bg);
    color: var(--row-fg);
    outline: 2px solid var(--row-fg);
    outline-offset: -2px;
  }

  .hl-close:active:not(:disabled),
  .hl-open-messages:active:not(:disabled),
  .hl-open-desktop:active:not(:disabled) {
    transform: scale(0.97);
  }

  .hl-open-desktop:disabled,
  .hl-open-messages:disabled,
  .ctx-item:disabled {
    cursor: progress;
    opacity: 0.62;
  }

  .widget-nav-spinner {
    width: 11px;
    height: 11px;
    flex: 0 0 auto;
    border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: widget-nav-spin 0.7s linear infinite;
  }

  /* Wordmark right-click menu — same frost chrome as the mini inbox. */
  .ctx-menu {
    width: 224px;
    border-radius: var(--radius-popover, 8px);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--row-bg);
    -webkit-backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    border: 0.5px solid var(--row-border);
    box-shadow: var(--row-shadow), inset 0 1px 0 var(--row-highlight);
    margin-bottom: 12px;
    transform-origin: bottom right;
    animation: widget-panel-in 110ms cubic-bezier(0.23, 1, 0.32, 1) backwards;
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .ctx-item {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--row-fg);
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    text-align: left;
    padding: 8px 12px;
    border-radius: var(--radius-button, 6px);
    cursor: pointer;
    line-height: 1.25;
    display: flex;
    align-items: center;
    gap: 8px;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  @keyframes widget-nav-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .ctx-item:hover {
    background: var(--row-hover-bg);
  }

  .ctx-item:focus-visible {
    background: var(--row-hover-bg);
    outline: 2px solid var(--row-fg);
    outline-offset: -2px;
  }

  .ctx-item:active:not(:disabled) {
    transform: scale(0.98);
  }

  .ctx-error {
    padding: 6px 12px 9px;
    color: var(--row-muted);
    font-size: 10.5px;
    line-height: 1.4;
  }

  .hl-sep {
    padding: 7px 8px 3px 31px;
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.9px;
    text-transform: uppercase;
    color: var(--row-muted);
  }

  /* Empty pinned list — one row of muted copy so a wordmark click always shows feedback. */
  .hl-empty {
    min-height: 116px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 5px;
    padding: 20px 24px;
    color: var(--row-muted);
    box-sizing: border-box;
  }

  .hl-empty-title {
    color: var(--row-fg);
    font-size: 13px;
    font-weight: 650;
  }

  .hl-empty-copy {
    max-width: 28ch;
    font-size: 11.5px;
    line-height: 1.45;
  }

  .hl-history-feedback,
  .hl-desktop-error {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    color: var(--row-muted);
    font-size: 10.5px;
    line-height: 1.35;
    box-sizing: border-box;
  }

  .hl-history-feedback {
    min-height: 116px;
    justify-content: space-between;
  }

  .hl-history-feedback-compact {
    min-height: 46px;
    border-bottom: 0.5px solid var(--row-border);
  }

  .hl-desktop-error {
    min-height: 48px;
    border-top: 0.5px solid var(--row-border);
    flex-shrink: 0;
  }

  .hl-desktop-error > span {
    min-width: 0;
    flex: 1;
  }

  .hl-history-message {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
  }

  .hl-history-message > span:last-child {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hl-history-message strong {
    color: var(--row-fg);
    font-size: 11.5px;
    font-weight: 650;
  }

  .hl-history-message small {
    color: var(--row-muted);
    font: inherit;
  }

  .hl-inline-retry {
    appearance: none;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 0 0 auto;
    padding: 0 9px;
    border: 0;
    border-radius: var(--radius-button, 6px);
    background: transparent;
    color: var(--row-fg);
    font: inherit;
    font-size: 10.5px;
    font-weight: 650;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .hl-inline-retry:hover {
    background: var(--row-hover-bg);
  }

  .hl-inline-retry:focus-visible {
    outline: 2px solid var(--row-fg);
    outline-offset: -2px;
  }

  .hl-inline-retry:active:not(:disabled) {
    transform: scale(0.97);
  }

  .hl-inline-retry:disabled {
    cursor: progress;
    opacity: 0.62;
  }

  .hl-row :global(.nr) {
    min-height: 58px;
    padding-inline: 8px;
    font-size: 12.5px;
    border-radius: 0;
    background: transparent;
    color: var(--row-fg);
    width: 100%;
    box-sizing: border-box;
  }

  .hl-row :global(.nr:not(.nr-message):hover),
  .hl-row :global(.nr:not(.nr-message):focus-within) {
    background: var(--row-hover-bg);
  }

  .hl-row :global(.nr-message.nr-expanded) {
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--row-border);
  }

  .hl-row + .hl-row {
    border-top: 0.5px solid color-mix(in srgb, var(--row-border) 70%, transparent);
  }

  .hl-row :global(.nr-primary-action),
  .hl-row :global(.nr-primary-content),
  .frost :global(.nr-primary-action),
  .frost :global(.nr-primary-content) {
    gap: 7px;
  }

  .hl-row :global(.nr-meta-type),
  .frost :global(.nr-meta-type) {
    max-width: 15ch;
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .hl-row :global(.nr-actor-pill),
  .frost :global(.nr-actor-pill) {
    max-width: min(16ch, 46%);
    padding-inline: 5px;
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
    padding-inline: 7px;
    font-size: 12.5px;
    box-sizing: border-box;
  }

  .frost :global(.nr-message.nr-expanded) {
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--row-border);
  }

  .frost :global(.nr:not(.nr-message):hover),
  .frost :global(.nr:not(.nr-message):focus-within) {
    background: var(--row-hover-bg);
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

  .hl-row :global(button),
  .frost :global(button) {
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .hl-row :global(.nr-primary-action:active:not(:disabled)),
  .frost :global(.nr-primary-action:active:not(:disabled)) {
    transform: scale(0.995);
  }

  .hl-row :global(.nr-open:active:not(:disabled)),
  .hl-row :global(.nr-dismiss:active:not(:disabled)),
  .hl-row :global(.nr-react:active:not(:disabled)),
  .hl-row :global(.nr-retry:active:not(:disabled)),
  .frost :global(.nr-open:active:not(:disabled)),
  .frost :global(.nr-dismiss:active:not(:disabled)),
  .frost :global(.nr-react:active:not(:disabled)),
  .frost :global(.nr-retry:active:not(:disabled)) {
    transform: scale(0.97);
  }

  .hl-row :global(button:focus-visible),
  .frost :global(button:focus-visible) {
    outline: 2px solid var(--row-fg);
    outline-offset: -2px;
  }

  @keyframes widget-arrive {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes widget-panel-in {
    from {
      transform: scale(0.98) translateY(4px);
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
    transition:
      opacity 120ms ease,
      transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
    flex-shrink: 0;
    cursor: pointer;
    /* Light default; dark overrides below. */
    --wm-fg: #1d1d1d;
    --wm-shadow: drop-shadow(0 1px 4px rgba(255, 255, 255, 0.5));
    --qd-fg: #333333;
  }

  .wg:hover .wm {
    opacity: 1;
  }

  .wg.surface-open .wm {
    margin-right: 4px;
    opacity: 0.58;
  }

  .wg.surface-open .wm:hover,
  .wg.surface-open .wm:focus-visible {
    opacity: 0.82;
  }

  .wg.surface-open .wm :global(svg) {
    width: 44px;
  }

  .wm:focus-visible {
    opacity: 1;
    outline: 2px solid currentColor;
    outline-offset: 3px;
  }

  .wm:active {
    transform: scale(0.97);
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
    top: -7px;
    right: -6px;
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--qd-fg);
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) {
    .wg {
      --row-bg: rgb(24 24 24 / clamp(0.78, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.338), 1));
      --row-bg-hover: rgb(32 32 32 / clamp(0.9, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.154), 1));
      --row-border: rgba(255, 255, 255, 0.22);
      --row-fg: #fff;
      --row-muted: rgba(255, 255, 255, 0.74);
      --row-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
      --row-highlight: rgba(255, 255, 255, 0.18);
      --row-hover-bg: rgba(255, 255, 255, 0.12);
      --reply-bg: rgba(255, 255, 255, 0.12);
      --reply-border: rgba(255, 255, 255, 0.22);
      --qd-fg: #d4d4d4;
    }

    .wm {
      --wm-fg: #fff;
      --wm-shadow: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.45));
      --qd-fg: #d4d4d4;
    }
  }

  /* The design harness can force either theme independently of the host OS.
     Override the whole material stack, not only the idle mark, so populated
     notification, mini-inbox, reply, and context-menu states stay coherent. */
  :global(html[data-force-theme='light']) .wg {
    --row-bg: rgb(245 245 245 / clamp(0.82, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.277), 1));
    --row-bg-hover: rgb(250 250 250 / clamp(0.94, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.092), 1));
    --row-border: rgba(255, 255, 255, 0.82);
    --row-fg: #171717;
    --row-muted: rgba(0, 0, 0, 0.66);
    --row-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
    --row-highlight: rgba(255, 255, 255, 0.9);
    --row-hover-bg: rgba(0, 0, 0, 0.08);
    --reply-bg: rgba(0, 0, 0, 0.07);
    --reply-border: rgba(0, 0, 0, 0.18);
    --qd-fg: #333333;
  }

  :global(html[data-force-theme='dark']) .wg {
    --row-bg: rgb(24 24 24 / clamp(0.78, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.338), 1));
    --row-bg-hover: rgb(32 32 32 / clamp(0.9, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.154), 1));
    --row-border: rgba(255, 255, 255, 0.22);
    --row-fg: #fff;
    --row-muted: rgba(255, 255, 255, 0.74);
    --row-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
    --row-highlight: rgba(255, 255, 255, 0.18);
    --row-hover-bg: rgba(255, 255, 255, 0.12);
    --reply-bg: rgba(255, 255, 255, 0.12);
    --reply-border: rgba(255, 255, 255, 0.22);
    --qd-fg: #d4d4d4;
  }

  :global(html[data-force-theme='light']) .wm {
    --wm-fg: #1d1d1d;
    --wm-shadow: drop-shadow(0 1px 4px rgba(255, 255, 255, 0.5));
    --qd-fg: #333333;
  }

  :global(html[data-force-theme='dark']) .wm {
    --wm-fg: #fff;
    --wm-shadow: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.45));
    --qd-fg: #d4d4d4;
  }

  @media (prefers-reduced-transparency: reduce) {
    .wg {
      --row-bg: rgb(245 245 245);
      --row-bg-hover: rgb(250 250 250);
      --glass-filter: none;
      --glass-filter-soft: none;
    }

    :global(html[data-force-theme='light']) .wg {
      --row-bg: rgb(245 245 245);
      --row-bg-hover: rgb(250 250 250);
    }

    :global(html[data-force-theme='dark']) .wg {
      --row-bg: rgb(24 24 24);
      --row-bg-hover: rgb(32 32 32);
    }

    .stack-grouped,
    .stack-single .frost,
    .hover-list,
    .ctx-menu {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
    .wg {
      --row-bg: rgb(24 24 24);
      --row-bg-hover: rgb(32 32 32);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .frost {
      animation: none;
    }

    .hover-list,
    .ctx-menu {
      animation: none;
    }

    .hl-close,
    .hl-open-messages,
    .hl-open-desktop,
    .hl-inline-retry,
    .ctx-item,
    .wm,
    .hl-row :global(button),
    .frost :global(button) {
      transition: none;
    }

    .wm:active,
    .ctx-item:active:not(:disabled),
    .hl-close:active:not(:disabled),
    .hl-open-messages:active:not(:disabled),
    .hl-open-desktop:active:not(:disabled),
    .hl-inline-retry:active:not(:disabled),
    .hl-row :global(.nr-primary-action:active:not(:disabled)),
    .hl-row :global(.nr-open:active:not(:disabled)),
    .hl-row :global(.nr-dismiss:active:not(:disabled)),
    .hl-row :global(.nr-react:active:not(:disabled)),
    .hl-row :global(.nr-retry:active:not(:disabled)),
    .frost :global(.nr-primary-action:active:not(:disabled)),
    .frost :global(.nr-open:active:not(:disabled)),
    .frost :global(.nr-dismiss:active:not(:disabled)),
    .frost :global(.nr-react:active:not(:disabled)),
    .frost :global(.nr-retry:active:not(:disabled)) {
      transform: none;
    }
  }
</style>
