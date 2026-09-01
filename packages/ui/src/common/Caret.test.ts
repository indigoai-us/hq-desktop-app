// @vitest-environment happy-dom

// The shared dropdown caret. Every caret in the app used to be the text
// character U+2304 DOWN ARROWHEAD, whose ink is drawn low inside its em box —
// flex centring aligned the glyph's line box, not its ink, so the arrow hung
// below its label. Six controls had independently inherited that defect.
// These tests lock the geometry that replaced it, plus the source-level guard
// that stops the glyph coming back.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import Caret from "./Caret.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountCaret(props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Caret, { target: host, props: props as never });
  return host.querySelector<SVGElement>('[data-testid="caret"]')!;
}

describe("Caret geometry", () => {
  it("is SVG geometry centred in its viewBox, not a text glyph", () => {
    const caret = mountCaret();
    expect(caret).toBeTruthy();
    expect(caret.tagName.toLowerCase()).toBe("svg");
    expect(caret.getAttribute("viewBox")).toBe("0 0 10 10");
    // Ink spans x 2.5-7.5, y 3.75-6.25 — centred on 5, the box centre.
    // Verified in a browser against the real pill: a box-centred caret lands
    // on the label's ink centre (residual < 0.1px). An ink centre of 5.25
    // reads low; correcting further for "optical centre" reads high.
    expect(caret.querySelector("path")?.getAttribute("d")).toBe(
      "M2.5 3.75 5 6.25 7.5 3.75",
    );
    const [top, bottom] = [3.75, 6.25];
    expect((top + bottom) / 2).toBe(5);
    // No text content: a glyph would reintroduce the original defect.
    expect(caret.textContent?.trim()).toBe("");
  });

  it("strokes with currentColor so dark and light need no override", () => {
    const caret = mountCaret({ tone: "var(--t3)" });
    expect(caret.querySelector("path")?.getAttribute("stroke")).toBe(
      "currentColor",
    );
    expect(caret.getAttribute("style")).toContain("var(--t3)");
  });

  it("sizes in em by default so it tracks the label's font scale", () => {
    const caret = mountCaret();
    expect(caret.getAttribute("style")).toContain("0.85em");
  });

  it("accepts a caller size, still in em", () => {
    const caret = mountCaret({ size: "0.9em" });
    expect(caret.getAttribute("style")).toContain("0.9em");
  });

  it("is decorative — always aria-hidden", () => {
    expect(mountCaret().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Caret disclosure state", () => {
  it("points down by default (open menus do not flip)", () => {
    expect(mountCaret().classList.contains("closed")).toBe(false);
  });

  it("rotates to point right when closed", () => {
    expect(mountCaret({ open: false }).classList.contains("closed")).toBe(true);
  });
});

describe("no bare caret glyphs remain in markup", () => {
  // Walks the package source rather than mounting six components: this is the
  // guard that actually generalises to surfaces added later.
  function svelteFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) svelteFiles(full, out);
      else if (entry.name.endsWith(".svelte")) out.push(full);
    }
    return out;
  }

  it("uses the shared Caret component instead of U+2304 in any template", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(join(import.meta.dirname, ".."))) {
      const source = readFileSync(file, "utf8");
      // Strip block comments so prose describing the old glyph is allowed.
      const markup = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/<!--[\s\S]*?-->/g, "");
      if (markup.includes("⌄")) offenders.push(file);
    }
    expect(offenders, `bare ⌄ glyph in: ${offenders.join(", ")}`).toEqual([]);
  });
});
