// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatShortcut,
  hasShortcutListener,
  isEditableTarget,
  listShortcuts,
  matchesShortcut,
  registerShortcuts,
  runShortcut,
} from "./keyboard-shortcuts";

function fire(
  init: KeyboardEventInit & { target?: EventTarget },
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (init.target ?? window).dispatchEvent(event);
  return event;
}

const unregisters: Array<() => void> = [];
function register(...args: Parameters<typeof registerShortcuts>) {
  const off = registerShortcuts(...args);
  unregisters.push(off);
  return off;
}

afterEach(() => {
  while (unregisters.length) unregisters.pop()!();
  document.body.innerHTML = "";
});

describe("matchesShortcut", () => {
  it("resolves Mod to meta on mac and ctrl elsewhere", () => {
    const meta = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    const ctrl = new KeyboardEvent("keydown", { key: "k", ctrlKey: true });
    expect(matchesShortcut("Mod+K", meta, true)).toBe(true);
    expect(matchesShortcut("Mod+K", ctrl, true)).toBe(false);
    expect(matchesShortcut("Mod+K", ctrl, false)).toBe(true);
    expect(matchesShortcut("Mod+K", meta, false)).toBe(false);
  });

  it("requires the exact modifier set", () => {
    const shifted = new KeyboardEvent("keydown", {
      key: "K",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+K", shifted, true)).toBe(false);
    expect(matchesShortcut("Mod+Shift+K", shifted, true)).toBe(true);
    const alt = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      altKey: true,
    });
    expect(matchesShortcut("Mod+K", alt, true)).toBe(false);
  });

  it("matches brackets via event.code when WebKit reports { / }", () => {
    const braceViaCode = new KeyboardEvent("keydown", {
      key: "}",
      code: "BracketRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+]", braceViaCode, true)).toBe(true);
    const braceNoCode = new KeyboardEvent("keydown", {
      key: "{",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+[", braceNoCode, true)).toBe(true);
    const plain = new KeyboardEvent("keydown", {
      key: "]",
      code: "BracketRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+]", plain, true)).toBe(true);
    expect(matchesShortcut("Mod+Shift+[", plain, true)).toBe(false);
  });

  it("matches unmodified named keys", () => {
    const esc = new KeyboardEvent("keydown", { key: "Escape" });
    expect(matchesShortcut("Escape", esc, true)).toBe(true);
    const escMeta = new KeyboardEvent("keydown", { key: "Escape", metaKey: true });
    expect(matchesShortcut("Escape", escMeta, true)).toBe(false);
  });
});

describe("registerShortcuts", () => {
  it("attaches one listener on first register and detaches on last unregister", () => {
    const spyAdd = vi.spyOn(window, "addEventListener");
    const spyRemove = vi.spyOn(window, "removeEventListener");
    expect(hasShortcutListener()).toBe(false);
    const a = register([{ id: "a", keys: "Mod+K", label: "A", group: "g", run: () => {} }]);
    const b = register([{ id: "b", keys: "Mod+J", label: "B", group: "g", run: () => {} }]);
    expect(hasShortcutListener()).toBe(true);
    expect(spyAdd.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    expect(spyAdd.mock.calls.find(([type]) => type === "keydown")?.[2]).toBe(true);
    a();
    expect(hasShortcutListener()).toBe(true);
    b();
    expect(hasShortcutListener()).toBe(false);
    expect(spyRemove.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    spyAdd.mockRestore();
    spyRemove.mockRestore();
  });

  it("runs the matching binding and prevents default", () => {
    const run = vi.fn();
    register([{ id: "k", keys: "Mod+K", label: "K", group: "g", run }]);
    const hit = fire({ key: "k", metaKey: isMacHere(), ctrlKey: !isMacHere() });
    expect(run).toHaveBeenCalledTimes(1);
    expect(hit.defaultPrevented).toBe(true);
    const miss = fire({ key: "j", metaKey: isMacHere(), ctrlKey: !isMacHere() });
    expect(run).toHaveBeenCalledTimes(1);
    expect(miss.defaultPrevented).toBe(false);
  });

  it("honours defaultPrevented", () => {
    const run = vi.fn();
    register([{ id: "k", keys: "Mod+K", label: "K", group: "g", run }]);
    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: isMacHere(),
      ctrlKey: !isMacHere(),
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips editable targets unless allowInInput", () => {
    const run = vi.fn();
    const allowed = vi.fn();
    register([
      { id: "k", keys: "Mod+K", label: "K", group: "g", run },
      { id: "e", keys: "Escape", label: "E", group: "g", allowInInput: true, run: allowed },
    ]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fire({ key: "k", metaKey: isMacHere(), ctrlKey: !isMacHere(), target: input });
    expect(run).not.toHaveBeenCalled();
    fire({ key: "Escape", target: input });
    expect(allowed).toHaveBeenCalledTimes(1);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);
  });

  it("lets a binding decline by returning false", () => {
    register([{ id: "e", keys: "Escape", label: "E", group: "g", run: () => false }]);
    const event = fire({ key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
  });

  it("later registrations shadow earlier ones and listShortcuts keeps order", () => {
    const first = vi.fn();
    const second = vi.fn();
    register([{ id: "k", keys: "Mod+K", label: "First", group: "g", run: first }]);
    register([{ id: "k2", keys: "Mod+K", label: "Second", group: "g", run: second }]);
    fire({ key: "k", metaKey: isMacHere(), ctrlKey: !isMacHere() });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(listShortcuts().map((b) => b.label)).toEqual(["First", "Second"]);
  });

  it("runShortcut dispatches by id with a null event", () => {
    const run = vi.fn();
    register([{ id: "conversation.next", keys: "Mod+Shift+]", label: "N", group: "g", run }]);
    expect(runShortcut("conversation.next")).toBe(true);
    expect(run).toHaveBeenCalledWith(null);
    expect(runShortcut("nope")).toBe(false);
  });
});

describe("non-US keyboard layouts", () => {
  // German QWERTZ: the key labelled `]` is AltGr+9 — it reports
  // `code: "Digit9"` with `key: "]"`. The physical US-`]` position
  // (`code: "BracketRight"`) is `+` there. Matching on `code` ALONE fired the
  // shortcut from the unlabelled `+` key and left the labelled `]` dead.
  it("matches the key the user's layout actually labels", () => {
    const germanBracket = new KeyboardEvent("keydown", {
      key: "]",
      code: "Digit9",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+]", germanBracket, true)).toBe(true);

    const germanBracketLeft = new KeyboardEvent("keydown", {
      key: "[",
      code: "Digit8",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+[", germanBracketLeft, true)).toBe(true);

    const germanSlash = new KeyboardEvent("keydown", {
      key: "/",
      code: "Digit7",
      metaKey: true,
    });
    expect(matchesShortcut("Mod+/", germanSlash, true)).toBe(true);
  });

  it("still matches the US physical position via code", () => {
    const usBracket = new KeyboardEvent("keydown", {
      // WebKit reports the shifted glyph in `key`; `code` carries the truth.
      key: "}",
      code: "BracketRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+]", usBracket, true)).toBe(true);
  });

  it("does not match an unrelated key that merely shares a code family", () => {
    const digit = new KeyboardEvent("keydown", {
      key: "9",
      code: "Digit9",
      metaKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut("Mod+Shift+]", digit, true)).toBe(false);
  });
});

describe("IME composition", () => {
  // Mid-composition every keystroke belongs to the input method; `key`/`code`
  // describe the raw key, so a shortcut would steal it from the IME.
  it("ignores keydown while composing", () => {
    const run = vi.fn();
    register([
      { id: "palette", keys: "Mod+K", label: "P", group: "g", run },
    ]);
    const composing = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "k",
      metaKey: isMacHere(),
      ctrlKey: !isMacHere(),
      isComposing: true,
    });
    window.dispatchEvent(composing);
    expect(run).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);

    // Same keystroke, composition finished → the binding runs.
    fire({ key: "k", metaKey: isMacHere(), ctrlKey: !isMacHere() });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("formatShortcut", () => {
  it("renders mac glyphs in the canonical order", () => {
    expect(formatShortcut("Mod+Shift+]", true)).toBe("⌘⇧]");
    expect(formatShortcut("Mod+K", true)).toBe("⌘K");
    expect(formatShortcut("Mod+/", true)).toBe("⌘/");
    expect(formatShortcut("Escape", true)).toBe("Esc");
    expect(formatShortcut("Ctrl+Alt+Shift+Mod+P", true)).toBe("⌃⌥⌘⇧P");
  });

  it("renders Ctrl+ text elsewhere", () => {
    expect(formatShortcut("Mod+Shift+]", false)).toBe("Ctrl+Shift+]");
    expect(formatShortcut("Mod+,", false)).toBe("Ctrl+,");
    expect(formatShortcut("Escape", false)).toBe("Esc");
  });
});

function isMacHere(): boolean {
  return /Mac OS X|Macintosh/i.test(navigator.userAgent);
}
