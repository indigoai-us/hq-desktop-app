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
import { LINE_ICONS } from "./button/rail-icons.js";

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
  it("is the Phosphor CaretDown, ink centred in its viewBox, not a text glyph", () => {
    const caret = mountCaret();
    expect(caret).toBeTruthy();
    expect(caret.tagName.toLowerCase()).toBe("svg");
    expect(caret.getAttribute("data-rail-icon")).toBe("chevron-down");
    // Verbatim Phosphor Regular path from the shared registry.
    expect(caret.querySelector("path")?.getAttribute("d")).toBe(
      LINE_ICONS["chevron-down"],
    );
    // Phosphor's caret ink spans x 40-216, y 88-184 (centre 128, 136). The
    // viewBox is shifted down by 8 so the ink centre lands on the box centre.
    // Verified in a browser against the real pill: a box-centred caret lands
    // on the label's ink centre; an ink centre below the box centre reads low.
    expect(caret.getAttribute("viewBox")).toBe("0 8 256 256");
    const [minX, minY, w, h] = caret
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number) as [number, number, number, number];
    const [inkTop, inkBottom, inkLeft, inkRight] = [88, 184, 40, 216];
    expect(minY + h / 2).toBe((inkTop + inkBottom) / 2);
    expect(minX + w / 2).toBe((inkLeft + inkRight) / 2);
    // No text content: a glyph would reintroduce the original defect.
    expect(caret.textContent?.trim()).toBe("");
  });

  it("fills with currentColor so dark and light need no override", () => {
    const caret = mountCaret({ tone: "var(--t3)" });
    expect(caret.querySelector("path")?.getAttribute("fill")).toBe(
      "currentColor",
    );
    expect(caret.querySelector("path")?.getAttribute("stroke")).toBeNull();
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
