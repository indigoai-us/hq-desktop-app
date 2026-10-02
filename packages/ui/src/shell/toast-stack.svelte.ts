/**
 * Shared toast layer store (console-rail US-011, OWNER-003).
 *
 * One store feeds the one `ToastStack` portal mounted at the app root.
 * Two kinds: `sticky` stays until dismissed or actioned; `quiet` dismisses
 * itself after QUIET_TOAST_MS and pauses while hovered. A `key` dedupes:
 * pushing a toast whose key is already shown replaces it in place, so a
 * notice that fires on every poll never stacks.
 */

export type ToastTone = "ok" | "err" | "neutral";
export type ToastKind = "sticky" | "quiet";

export interface ToastAction {
  label: string;
  onAction: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Keep the toast after the action runs (the caller updates or dismisses it). */
  keepOpen?: boolean;
  testId?: string;
  ariaLabel?: string;
  title?: string;
}

export interface ToastItem {
  id: string;
  key?: string;
  kind: ToastKind;
  title: string;
  detail: string;
  /** Optional error line under the detail. */
  error?: string | null;
  tone: ToastTone;
  actions?: ToastAction[];
  /** Legacy single action; the toast dismisses after it runs. */
  actionLabel?: string;
  onAction?: () => void;
  /** Runs when the person closes the toast with its close button. */
  onDismiss?: () => void;
  testId?: string;
  dismissLabel?: string;
}

export type ToastInput = Omit<ToastItem, "id" | "kind"> & { kind?: ToastKind };

export const QUIET_TOAST_MS = 5000;
export const MAX_VISIBLE_TOASTS = 3;

interface Timer {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

let items = $state<ToastItem[]>([]);
let seq = 0;
// One layer paints: the first mounted ToastStack owns it, later ones stay
// empty, so a host that mounts the layer at its root and a nested shell that
// also mounts it never double-paint.
let layerOwners = $state<symbol[]>([]);

export function claimToastLayer(token: symbol): void {
  layerOwners = [...layerOwners, token];
}

export function releaseToastLayer(token: symbol): void {
  layerOwners = layerOwners.filter((owner) => owner !== token);
}

export function ownsToastLayer(token: symbol): boolean {
  return layerOwners[0] === token;
}
const timers = new Map<string, Timer>();

export function toastItems(): readonly ToastItem[] {
  return items;
}

function startTimer(id: string, ms: number): void {
  clearTimer(id);
  timers.set(id, {
    handle: setTimeout(() => dismissToast(id), ms),
    remaining: ms,
    startedAt: Date.now(),
  });
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
}

/** Show a toast, or replace the one already shown under the same key. */
export function pushToast(toast: ToastInput): string {
  const kind: ToastKind = toast.kind ?? "quiet";
  const existing = toast.key ? items.find((item) => item.key === toast.key) : undefined;
  if (existing) {
    const next: ToastItem = { ...toast, kind, id: existing.id };
    items = items.map((item) => (item.id === existing.id ? next : item));
    if (kind === "quiet") startTimer(existing.id, QUIET_TOAST_MS);
    else clearTimer(existing.id);
    return existing.id;
  }
  const id = `toast-${++seq}`;
  items = [...items, { ...toast, kind, id }];
  if (kind === "quiet") startTimer(id, QUIET_TOAST_MS);
  return id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  if (!items.some((item) => item.id === id)) return;
  items = items.filter((item) => item.id !== id);
}

export function dismissToastByKey(key: string): void {
  const item = items.find((entry) => entry.key === key);
  if (item) dismissToast(item.id);
}

/** Hover pause: a quiet toast keeps its remaining time while hovered. */
export function pauseToast(id: string): void {
  const timer = timers.get(id);
  if (!timer?.handle) return;
  clearTimeout(timer.handle);
  timer.handle = null;
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
}

export function resumeToast(id: string): void {
  const timer = timers.get(id);
  if (!timer || timer.handle) return;
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

/** Test seam: drop every toast and timer. */
export function clearToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  items = [];
}
