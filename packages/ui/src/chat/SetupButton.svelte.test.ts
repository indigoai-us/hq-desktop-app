// @vitest-environment happy-dom

// SetupButton is the one button of the #welcome setup flow. Contract: the
// variant lands on `data-variant` (tests and hero styles select on it),
// `pressed` renders `aria-pressed` for multi-select chips, every other prop
// spreads onto the <button>, and the default type is "button" so a chip
// inside a form never submits it by accident.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";

import SetupButton from "./SetupButton.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown>, label = "Run Setup"): HTMLButtonElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupButton, {
    target: host,
    props: { children: createRawSnippet(() => ({ render: () => `<span>${label}</span>` })), ...props } as never,
  });
  flushSync();
  const button = host.querySelector("button");
  if (!button) throw new Error("SetupButton did not render a <button>");
  return button;
}

describe("SetupButton", () => {
  it("defaults to a secondary, type=button control and renders its children", () => {
    const button = render({});
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("secondary");
    expect(button.classList.contains("setup-btn")).toBe(true);
    expect(button.textContent).toContain("Run Setup");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
  });

  it("exposes the variant as data-variant", () => {
    expect(render({ variant: "primary" }).getAttribute("data-variant")).toBe("primary");
    host?.remove();
    expect(render({ variant: "quiet" }).getAttribute("data-variant")).toBe("quiet");
  });

  it("renders aria-pressed from `pressed` for multi-select choices", () => {
    expect(render({ pressed: true }).getAttribute("aria-pressed")).toBe("true");
    host?.remove();
    expect(render({ pressed: false }).getAttribute("aria-pressed")).toBe("false");
  });

  it("passes rest props through: data-testid, class, type, disabled, onclick", () => {
    const onclick = vi.fn();
    const button = render({ "data-testid": "setup-run", class: "choice", type: "submit", onclick });
    expect(button.getAttribute("data-testid")).toBe("setup-run");
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.classList.contains("choice")).toBe(true);
    expect(button.classList.contains("setup-btn")).toBe(true);
    button.click();
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onclick while disabled", () => {
    const onclick = vi.fn();
    const button = render({ disabled: true, onclick });
    expect(button.disabled).toBe(true);
    button.click();
    expect(onclick).not.toHaveBeenCalled();
  });
});
