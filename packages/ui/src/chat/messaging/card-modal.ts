/**
 * The modal a card can open: its types and its dialog mechanics.
 *
 * The mechanics are the ones the keyboard shortcut sheet uses
 * (common/ShortcutCheatSheet.svelte): keep Tab inside the dialog, make
 * everything outside it inert, and give focus back to where it was. They are
 * plain functions here so the modal component stays markup and so they are
 * testable without it.
 */

import { SHELL_FOCUS_FALLBACK } from "../../common/keyboard-shortcuts.js";

/** The small step indicator under a card modal's title. */
export interface CardModalSteps {
  /** One short label per step, in order. */
  labels: readonly string[];
  /** The step the person is on, counted from 0. */
  current: number;
}

/** What a step in a card modal's body looks like. */
export type CardModalStepState = "done" | "current" | "todo";

/** What an inline status line in a card modal says is happening. */
export type CardModalStatusKind = "working" | "done" | "problem";

/** The step the indicator shows, kept inside the list. */
export function cardModalStepIndex(steps: CardModalSteps): number {
  const last = Math.max(0, steps.labels.length - 1);
  const at = Number.isFinite(steps.current) ? Math.trunc(steps.current) : 0;
  return Math.min(Math.max(at, 0), last);
}

/** What a screen reader hears for the indicator: "Step 2 of 3: Add the app". */
export function cardModalStepText(steps: CardModalSteps): string {
  const count = steps.labels.length;
  if (count === 0) return "";
  const at = cardModalStepIndex(steps);
  const label = steps.labels[at]?.trim() ?? "";
  return `Step ${at + 1} of ${count}${label ? `: ${label}` : ""}`;
}

/** Put this attribute on the control that should take focus when the modal opens. */
export const CARD_MODAL_AUTOFOCUS = "data-card-modal-autofocus";

/** How long after opening a press on the backdrop is ignored (ms). */
export const CARD_MODAL_BACKDROP_GUARD_MS = 350;

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The controls Tab can reach inside `root`, in order. */
export function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Move focus into the dialog: the control marked {@link CARD_MODAL_AUTOFOCUS},
 * else the first control, else the panel itself.
 */
export function focusIntoDialog(panel: HTMLElement | null): void {
  if (!panel) return;
  const marked = panel.querySelector<HTMLElement>(`[${CARD_MODAL_AUTOFOCUS}]:not([disabled])`);
  const first = marked ?? focusablesIn(panel)[0] ?? panel;
  first.focus();
  if (document.activeElement !== first) panel.focus();
}

/**
 * Keep Tab inside the dialog. `aria-modal` alone does not do this in any
 * engine the app ships on. Returns true when the key press was handled.
 */
export function trapTab(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  if (event.key !== "Tab" || !panel) return false;
  const items = focusablesIn(panel);
  const active = document.activeElement as HTMLElement | null;
  if (items.length === 0) {
    // Nothing to tab to: hold focus on the panel.
    event.preventDefault();
    panel.focus();
    return true;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (!active || !panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Make everything that is not the dialog inert: out of the tab order, out of
 * the accessibility tree, and not clickable. Walks from the dialog's layer up
 * to <body> and marks each ancestor's other children. Returns the undo.
 */
export function inertOutside(layer: HTMLElement | null): () => void {
  if (!layer || typeof document === "undefined") return () => {};
  const touched: HTMLElement[] = [];
  let node: HTMLElement | null = layer;
  while (node && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of [...parent.children]) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
      touched.push(sibling);
    }
    if (parent === document.body) break;
    node = parent;
  }
  return () => {
    for (const el of touched) {
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    }
  };
}

/**
 * Give focus back: to the control that opened the dialog, or to the shell
 * when that control is gone (the conversation changed while it was open).
 */
export function restoreFocus(opener: HTMLElement | null): void {
  if (typeof document === "undefined") return;
  const candidates = [opener, document.querySelector<HTMLElement>(SHELL_FOCUS_FALLBACK)];
  for (const candidate of candidates) {
    if (!candidate || !candidate.isConnected) continue;
    candidate.focus();
    if (document.activeElement === candidate) return;
  }
}
