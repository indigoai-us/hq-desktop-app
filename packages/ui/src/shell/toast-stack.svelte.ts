/**
 * In-app toasts for the content column (console-rail US-011).
 * Callers paint a toast in the same turn as the click.
 */

export type ToastTone = "ok" | "err" | "neutral";

export interface ToastItem {
  id: string;
  title: string;
  detail: string;
  tone: ToastTone;
  actionLabel?: string;
}

let items = $state<ToastItem[]>([]);
let seq = 0;

export function toastItems(): readonly ToastItem[] {
  return items;
}

export function pushToast(toast: Omit<ToastItem, "id">): string {
  const id = `toast-${++seq}`;
  items = [...items, { ...toast, id }].slice(-4);
  return id;
}

export function dismissToast(id: string): void {
  items = items.filter((item) => item.id !== id);
}
