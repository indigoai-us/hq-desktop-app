/**
 * Last notifications feed the shell painted. The titlebar popover reads this
 * and never starts its own fetch.
 */

import type { NotificationItem } from "./notifications-model.js";

let items = $state<NotificationItem[]>([]);
let ready = $state(false);
let loading = $state(false);
const hidden = new Set<string>();
let hiddenVersion = $state(0);

export function publishNotificationsCache(next: {
  items: readonly NotificationItem[];
  ready: boolean;
  loading: boolean;
}): void {
  items = [...next.items];
  ready = next.ready;
  loading = next.loading;
}

export function notificationsCacheSnapshot(): {
  items: NotificationItem[];
  ready: boolean;
  loading: boolean;
} {
  void hiddenVersion;
  return {
    items: items.filter((item) => !hidden.has(item.id)),
    ready,
    loading,
  };
}

/**
 * Optimistic "Mark all read" for the titlebar popover. Returns a restore
 * function that puts the previous rows back if the server call fails. The
 * Inbox view republishes the cache on its next fetch, which then carries the
 * server's read state.
 */
export function markAllCachedNotificationsRead(): () => void {
  const previous = items;
  items = items.map((item) =>
    item.status === "unread" ? { ...item, status: "read" as const } : item,
  );
  return () => {
    items = previous;
  };
}

/**
 * Optimistic read for one row (a revealed badge card). Returns a restore
 * function for a failed server call, like `markAllCachedNotificationsRead`.
 */
export function markCachedNotificationRead(id: string): () => void {
  const previous = items;
  items = items.map((item) =>
    item.id === id && item.status === "unread" ? { ...item, status: "read" as const } : item,
  );
  return () => {
    items = previous;
  };
}

/** Drop a row immediately. A failed grant puts it back. */
export function hideNotification(id: string): void {
  hidden.add(id);
  hiddenVersion += 1;
}

export function restoreNotification(id: string): void {
  hidden.delete(id);
  hiddenVersion += 1;
}

/** Test helper. Session hides must not leak across popover mounts. */
export function clearHiddenNotifications(): void {
  hidden.clear();
  hiddenVersion += 1;
}
