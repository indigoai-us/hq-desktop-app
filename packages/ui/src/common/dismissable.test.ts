// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissable } from "./dismissable.js";

function surface(label: string): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", label);
  const a = document.createElement("button");
  a.textContent = `${label} first`;
  const b = document.createElement("button");
  b.textContent = `${label} last`;
  node.append(a, b);
  document.body.append(node);
  return node;
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe("dismissable (QA-003)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("closes on Escape and returns focus to the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const node = surface("Add connection");
    const onclose = vi.fn();
    const action = dismissable(node, { onclose });
    expect(node.contains(document.activeElement)).toBe(true);
    const event = key("Escape");
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    action.destroy();
    expect(document.activeElement).toBe(opener);
  });

  it("closes only the topmost surface", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const a = dismissable(surface("sheet"), { onclose: outer });
    const b = dismissable(surface("picker"), { onclose: inner });
    key("Escape");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    b.destroy();
    key("Escape");
    expect(outer).toHaveBeenCalledTimes(1);
    a.destroy();
  });

  it("leaves Escape alone when another handler already claimed it", () => {
    const onclose = vi.fn();
    const action = dismissable(surface("sheet"), { onclose });
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onclose).not.toHaveBeenCalled();
    action.destroy();
  });

  it("closes on an outside pointerdown only when asked", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const node = surface("sheet");
    const onclose = vi.fn();
    const action = dismissable(node, { onclose });
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(onclose).not.toHaveBeenCalled();
    action.update({ onclose, outside: true });
    node.querySelector("button")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(onclose).not.toHaveBeenCalled();
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
    action.destroy();
  });

  it("wraps Tab inside the surface", () => {
    const node = surface("sheet");
    const action = dismissable(node, { onclose: () => {} });
    const [first, last] = Array.from(node.querySelectorAll("button"));
    last.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    first.focus();
    expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    action.destroy();
  });
});
