// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  consumeNavigationShortcut,
  detectNavigationShortcutPlatform,
  resolveNavigationShortcut,
  type NavigationShortcutEvent,
} from "./navigation-shortcuts.js";

function event(
  overrides: Partial<NavigationShortcutEvent> &
    Pick<NavigationShortcutEvent, "key">,
): NavigationShortcutEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    target: null,
    ...overrides,
  };
}

describe("navigation shortcuts", () => {
  it("maps Cmd+[ / Cmd+] on macOS and ignores Windows Alt chords there", () => {
    expect(
      resolveNavigationShortcut(
        event({ key: "[", metaKey: true }),
        "macos",
      ),
    ).toBe("back");
    expect(
      resolveNavigationShortcut(
        event({ key: "]", metaKey: true }),
        "macos",
      ),
    ).toBe("forward");
    expect(
      resolveNavigationShortcut(
        event({ key: "ArrowLeft", altKey: true }),
        "macos",
      ),
    ).toBeNull();
  });

  it("maps Alt+Left / Alt+Right on Windows and ignores Cmd brackets there", () => {
    expect(
      resolveNavigationShortcut(
        event({ key: "ArrowLeft", altKey: true }),
        "windows",
      ),
    ).toBe("back");
    expect(
      resolveNavigationShortcut(
        event({ key: "ArrowRight", altKey: true }),
        "windows",
      ),
    ).toBe("forward");
    expect(
      resolveNavigationShortcut(
        event({ key: "[", metaKey: true }),
        "windows",
      ),
    ).toBeNull();
  });

  it("does not steal from text editing, IME, or an embedded editor", () => {
    const input = document.createElement("input");
    expect(
      resolveNavigationShortcut(
        event({ key: "[", metaKey: true, target: input }),
        "macos",
      ),
    ).toBeNull();

    const textarea = document.createElement("textarea");
    expect(
      resolveNavigationShortcut(
        event({ key: "ArrowLeft", altKey: true, target: textarea }),
        "windows",
      ),
    ).toBeNull();

    expect(
      resolveNavigationShortcut(
        event({ key: "[", metaKey: true, isComposing: true }),
        "macos",
      ),
    ).toBeNull();

    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    const inner = document.createElement("div");
    monaco.appendChild(inner);
    expect(
      resolveNavigationShortcut(
        event({ key: "[", metaKey: true, target: inner }),
        "macos",
      ),
    ).toBeNull();
  });

  it("does not treat Escape as navigation", () => {
    expect(
      resolveNavigationShortcut(event({ key: "Escape", metaKey: true }), "macos"),
    ).toBeNull();
    expect(
      resolveNavigationShortcut(event({ key: "Escape" }), "windows"),
    ).toBeNull();
  });

  it("consumeNavigationShortcut preventDefaults only when it matches", () => {
    const prevented: string[] = [];
    const calls: string[] = [];
    const matched = consumeNavigationShortcut(
      event({
        key: "[",
        metaKey: true,
        preventDefault: () => prevented.push("yes"),
      }),
      {
        platform: "macos",
        onBack: () => calls.push("back"),
        onForward: () => calls.push("forward"),
      },
    );
    expect(matched).toBe(true);
    expect(prevented).toEqual(["yes"]);
    expect(calls).toEqual(["back"]);

    const skipped = consumeNavigationShortcut(
      event({
        key: "[",
        metaKey: true,
        target: document.createElement("input"),
        preventDefault: () => prevented.push("stolen"),
      }),
      {
        platform: "macos",
        onBack: () => calls.push("back"),
        onForward: () => calls.push("forward"),
      },
    );
    expect(skipped).toBe(false);
    expect(prevented).toEqual(["yes"]);
    expect(calls).toEqual(["back"]);
  });

  it("detects Windows from data-platform and defaults to macOS", () => {
    document.documentElement.removeAttribute("data-platform");
    expect(detectNavigationShortcutPlatform()).toBe("macos");
    document.documentElement.setAttribute("data-platform", "windows");
    expect(detectNavigationShortcutPlatform()).toBe("windows");
    document.documentElement.removeAttribute("data-platform");
  });
});
