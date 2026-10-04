// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { isWindowDragBlocker, startWindowDrag } from "./window-drag";

type Internals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  metadata?: { currentWindow?: { label?: string } };
};

function setInternals(internals: Internals | undefined): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: internals,
  });
}

function pointer(target: EventTarget, button = 0): PointerEvent {
  const event = new PointerEvent("pointerdown", { button, bubbles: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

afterEach(() => {
  setInternals(undefined);
  document.body.replaceChildren();
});

describe("window drag", () => {
  it("starts a drag with the current window label, defaulting to main", () => {
    const invoke = vi.fn(async () => undefined);
    const surface = document.createElement("div");
    setInternals({
      invoke,
      metadata: { currentWindow: { label: "desktop-alt" } },
    });

    startWindowDrag(pointer(surface));

    expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging", {
      label: "desktop-alt",
    });

    setInternals({ invoke });
    startWindowDrag(pointer(surface));
    expect(invoke).toHaveBeenLastCalledWith("plugin:window|start_dragging", {
      label: "main",
    });
  });

  it("does not drag from a non-primary button or an interactive control", () => {
    const invoke = vi.fn(async () => undefined);
    setInternals({
      invoke,
      metadata: { currentWindow: { label: "main" } },
    });
    const button = document.createElement("button");
    const link = document.createElement("a");
    const field = document.createElement("input");
    const area = document.createElement("textarea");
    const menu = document.createElement("select");
    const marked = document.createElement("span");
    marked.setAttribute("data-no-drag", "");
    const plain = document.createElement("div");
    document.body.append(button, link, field, area, menu, marked, plain);

    startWindowDrag(pointer(plain, 2));
    for (const target of [button, link, field, area, menu, marked]) {
      expect(isWindowDragBlocker(target)).toBe(true);
      startWindowDrag(pointer(target));
    }

    expect(isWindowDragBlocker(plain)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
