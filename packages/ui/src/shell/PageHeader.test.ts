// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import PageHeader from "./PageHeader.svelte";
import {
  TITLEBAR_HEIGHT_CSS_VAR,
  TITLEBAR_LEADING_INSET_CSS_VAR,
} from "../home/titlebar-layout.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function scopedCss(root: Element): string {
  const scope = [...root.classList].find((name) => name.startsWith("svelte-"));
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => (scope ? css.includes(scope) : false))
    .join("\n");
}

describe("PageHeader", () => {
  it("renders Back, title, subtitle and a Tauri drag region", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let clicked = false;
    component = mount(PageHeader, {
      target: host,
      props: {
        title: "Library",
        subtitle: "skills available to you, and packs",
        titleTestId: "library-overlay-title",
        backTestId: "library-back",
        onback: () => {
          clicked = true;
        },
      },
    });
    const header = host.querySelector("[data-testid='page-header']");
    expect(header).not.toBeNull();
    expect(header?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(header?.classList.contains("window")).toBe(true);
    expect(
      host.querySelector("[data-testid='library-overlay-title']")?.textContent,
    ).toBe("Library");
    const back = host.querySelector<HTMLButtonElement>(
      "[data-testid='library-back']",
    );
    expect(back?.textContent?.replace(/\s+/g, " ").trim()).toBe("Back");
    expect(back?.getAttribute("data-tauri-drag-region")).toBe("false");
    back?.click();
    expect(clicked).toBe(true);
  });

  it("omits the Back control when onback is not provided", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PageHeader, {
      target: host,
      props: { title: "Meetings", variant: "embedded" },
    });
    expect(host.querySelector("[data-testid='page-header-back']")).toBeNull();
    expect(
      host.querySelector("[data-testid='page-header']")?.classList.contains(
        "embedded",
      ),
    ).toBe(true);
  });
});

describe("PageHeader window chrome", () => {
  it("starts a window drag from the header and not from Back", () => {
    const invoke = vi.fn();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke,
      metadata: { currentWindow: { label: "library" } },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PageHeader, {
      target: host,
      props: { title: "Library", onback: () => {} },
    });
    const header = host.querySelector<HTMLElement>("[data-testid='page-header']");
    header?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging", { label: "library" });
    invoke.mockClear();
    host
      .querySelector("[data-testid='page-header-back']")
      ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sizes from the titlebar height and insets to the shared page edge", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PageHeader, { target: host, props: { title: "Library" } });
    const header = host.querySelector("[data-testid='page-header']");
    expect(header).not.toBeNull();
    const css = scopedCss(header!);
    expect(css).toContain(`var(${TITLEBAR_HEIGHT_CSS_VAR}`);
    // Pages sit right of the rail, under the top bar: no traffic-light gutter.
    expect(css).not.toContain(`var(${TITLEBAR_LEADING_INSET_CSS_VAR}`);
    expect(css).toContain("var(--page-edge-inset");
    expect(css).not.toMatch(/padding-left:\s*\d+px/);
    expect(css).not.toMatch(/height:\s*52px/);
  });
});
