// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
});

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

describe("PageHeader source contract", () => {
  const source = readFileSync(join(import.meta.dirname, "PageHeader.svelte"), "utf8");

  it("sizes and insets from the shared titlebar CSS variables", () => {
    expect(source).toContain(`var(${TITLEBAR_HEIGHT_CSS_VAR}`);
    expect(source).toContain(`var(${TITLEBAR_LEADING_INSET_CSS_VAR}`);
    expect(source).toContain("data-tauri-drag-region");
    expect(source).toContain("startWindowDrag");
    expect(source).not.toMatch(/padding-left:\s*\d+px/);
    expect(source).not.toMatch(/height:\s*52px/);
  });
});
