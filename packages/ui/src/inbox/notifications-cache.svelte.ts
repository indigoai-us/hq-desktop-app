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

/** Drop a row immediately. A failed grant puts it back. */
export function hideNotification(id: string): void {
  hidden.add(id);
  hiddenVersion += 1;
}

export function restoreNotification(id: string): void {
  hidden.delete(id);
  hiddenVersion += 1;
}
