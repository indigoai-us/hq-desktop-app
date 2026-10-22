// @vitest-environment happy-dom

// A wide Markdown table in the Files viewers must scroll in its own box and
// keep words whole. Before this fix the vault note view made the table a
// block box under `overflow-wrap: anywhere`, so a 6-column table shrank to the
// reading column and cells broke mid-word. happy-dom does not lay out or
// compute scoped styles, so these assertions read the rendered structure and
// the stylesheet each mounted viewer injects.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import NoteView from "./explorer/NoteView.svelte";
import FilePreviewPane from "./FilePreviewPane.svelte";

const WIDE_TABLE = [
  "# Klaviyo keys",
  "",
  "| Key | Status | Owner | Last rotated | Scope | Notes |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Private API key | Active | joon@11.agency | 2026-10-01 | Read/write campaigns | Used by every flow; rotate after the agency handover finishes |",
  "| Public site key | Not started | — | — | Read only | Needed for the signup form embed |",
].join("\n");

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  document.head.querySelectorAll("style").forEach((node) => node.remove());
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    await tick();
  }
}

function injectedCss(marker: string): string {
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => css.includes(marker))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Declarations of every rule whose selector list ends in the given global. */
function rulesFor(css: string, selector: RegExp): string {
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1].split(",").map((s) => s.trim());
    if (selectors.some((s) => selector.test(s))) out.push(match[2]);
  }
  return out.join(";");
}

function expectWideTableLayout(root: Element, css: string): void {
  const table = root.querySelector("table");
  expect(table, "table rendered").not.toBeNull();
  expect(table!.querySelectorAll("thead th")).toHaveLength(6);
  const wrapper = table!.parentElement!;
  expect(wrapper.classList.contains("markdown-table-scroll")).toBe(true);

  const scroll = rulesFor(css, /\.markdown-table-scroll(\.svelte-[\w-]+)?$/);
  expect(scroll).toMatch(/overflow-x:\s*auto/);
  expect(scroll).toMatch(/max-width:\s*100%/);

  const tableRule = rulesFor(css, /(^|\s)table$/);
  // The table sizes to its content and may grow past the prose column.
  expect(tableRule).toMatch(/width:\s*max-content/);
  expect(tableRule).toMatch(/min-width:\s*100%/);
  expect(tableRule).not.toMatch(/display:\s*block/);

  const cells = rulesFor(css, /(^|\s)(td|th)$/);
  expect(cells).toMatch(/overflow-wrap:\s*normal/);
  expect(cells).toMatch(/word-break:\s*normal/);
  expect(cells).toMatch(/max-width:\s*\d+ch/);
  expect(css).not.toMatch(/break-all/);
}

describe("wide Markdown tables in the Files viewers", () => {
  it("vault note view scrolls the table and keeps words whole", async () => {
    component = mount(NoteView, {
      target: document.body,
      props: { path: "notes/klaviyo.md", source: WIDE_TABLE, links: {}, onopen: () => {} },
    });
    await settle();
    const body = document.querySelector('[data-testid="note-body"]')!;
    expectWideTableLayout(body, injectedCss("note-head"));
  });

  it("file preview scrolls the table and keeps words whole", async () => {
    const adapter = {
      isAvailable: () => false,
      files: {
        getFileContent: vi.fn(async () => ({ ok: true, value: WIDE_TABLE })),
        getAuthorizedPreview: vi.fn(async () => ({ ok: false, reason: "error", message: "n/a" })),
      },
    } as unknown as PlatformAdapter;
    component = mount(FilePreviewPane, {
      target: document.body,
      props: { adapter, path: "projects/x/keys.md", scopeRoot: "projects/x", onopenpath: () => {} },
    });
    await settle();
    const body = document.querySelector('[data-testid="file-preview-markdown"]')!;
    expect(body).not.toBeNull();
    expectWideTableLayout(body, injectedCss("preview-body"));
  });
});
