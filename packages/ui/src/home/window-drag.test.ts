// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { isWindowDragBlocker, startWindowDrag } from "./window-drag.js";

describe("window drag", () => {
  it("blocks drags that originate on interactive controls", () => {
    const button = document.createElement("button");
    const wrap = document.createElement("div");
    wrap.append(button);
    expect(isWindowDragBlocker(button)).toBe(true);
    expect(isWindowDragBlocker(wrap)).toBe(false);
    expect(isWindowDragBlocker(null)).toBe(false);
  });

  it("invokes start_dragging with the current window label", () => {
    const invoke = vi.fn();
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: typeof invoke;
          metadata: { currentWindow: { label: string } };
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke,
      metadata: { currentWindow: { label: "main" } },
    };
    const event = {
      button: 0,
      target: document.createElement("div"),
    } as unknown as PointerEvent;
    startWindowDrag(event);
    expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging", {
      label: "main",
    });
  });

  it("does not start a drag from a button", () => {
    const invoke = vi.fn();
    (
      window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }
    ).__TAURI_INTERNALS__ = { invoke };
    const event = {
      button: 0,
      target: document.createElement("button"),
    } as unknown as PointerEvent;
    startWindowDrag(event);
    expect(invoke).not.toHaveBeenCalled();
  });
});
