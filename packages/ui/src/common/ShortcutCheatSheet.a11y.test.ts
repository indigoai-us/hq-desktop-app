// @vitest-environment happy-dom

/**
 * Modal a11y regressions for the shortcut cheat sheet.
 *
 * The sheet already had role/aria-modal/aria-labelledby, autofocus and Escape,
 * but none of those constrain Tab, return focus, or hide the background — so a
 * keyboard user tabbed straight out of the "modal" into the covered app and was
 * dumped at the top of the document on close.
 */

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ShortcutCheatSheet from "./ShortcutCheatSheet.svelte";
import type { ShortcutBinding } from "./keyboard-shortcuts";

const BINDINGS: ShortcutBinding[] = [
  { id: "a", keys: "Mod+K", label: "Palette", group: "General", run: () => {} },
  { id: "b", keys: "Mod+/", label: "Shortcuts", group: "General", run: () => {} },
];

interface Harness {
  component: Record<string, unknown>;
  shell: HTMLElement;
  trigger: HTMLButtonElement;
  background: HTMLElement;
}

function open(props: Record<string, unknown> = {}): Harness {
  document.body.innerHTML = "";
  const shell = document.createElement("div");
  shell.setAttribute("data-shell-focus-fallback", "");
  shell.tabIndex = -1;
  const background = document.createElement("div");
  const trigger = document.createElement("button");
  trigger.id = "open-shortcuts";
  trigger.textContent = "Shortcuts";
  background.append(trigger);
  const host = document.createElement("div");
  shell.append(background, host);
  document.body.append(shell);
  trigger.focus();
  const component = mount(ShortcutCheatSheet, {
    target: host,
    props: { onclose: () => {}, bindings: BINDINGS, ...props },
  }) as Record<string, unknown>;
  flushSync();
  return { component, shell, trigger, background };
}

/** Svelte 5 defers teardown effects; flush so the cleanup has actually run. */
function close_sheet(h: Harness): void {
  void unmount(h.component as never, { outro: false });
  flushSync();
}

afterEach(() => {
  document.body.innerHTML = "";
});

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error("cheat sheet dialog not mounted");
  return el;
}

describe("ShortcutCheatSheet modal a11y", () => {
  it("marks background content inert and aria-hidden, and restores it on close", () => {
    const h = open();
    expect(h.background.hasAttribute("inert")).toBe(true);
    expect(h.background.getAttribute("aria-hidden")).toBe("true");
    close_sheet(h);
    expect(h.background.hasAttribute("inert")).toBe(false);
    expect(h.background.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps Tab inside the dialog", () => {
    const h = open();
    const close = panel().querySelector<HTMLButtonElement>("button");
    expect(close).not.toBeNull();

    // Forward from the panel wraps to the only focusable child.
    close!.focus();
    const forward = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    panel().dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the panel wraps backwards, never out to the trigger.
    panel().focus();
    const back = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    panel().dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(h.trigger);
    close_sheet(h);
  });

  it("returns focus to the element that opened it", () => {
    const h = open();
    expect(document.activeElement).toBe(panel());
    close_sheet(h);
    expect(document.activeElement).toBe(h.trigger);
  });

  // Policy indigo-app-wide-modal-focus-return-survives-trigger-unmount.
  it("falls back to a stable selector when the trigger unmounted", () => {
    const h = open({ returnFocusSelector: "#stable-return" });
    const stable = document.createElement("button");
    stable.id = "stable-return";
    h.shell.append(stable);
    h.trigger.remove();
    close_sheet(h);
    expect(document.activeElement).toBe(stable);
  });

  it("falls back to the shell when the trigger AND the selector are gone", () => {
    const h = open({ returnFocusSelector: "#never-rendered" });
    h.trigger.remove();
    close_sheet(h);
    expect(document.activeElement).toBe(h.shell);
  });
});
