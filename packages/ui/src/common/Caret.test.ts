// @vitest-environment happy-dom

// The shared dropdown caret. Every caret in the app used to be the text
// character U+2304 DOWN ARROWHEAD, whose ink is drawn low inside its em box —
// flex centring aligned the glyph's line box, not its ink, so the arrow hung
// below its label. Six controls had independently inherited that defect.
// These tests lock what replaced it — a Phosphor CaretDown centred by its
// wrapper, matching the V2 concept — plus the source-level guard that stops
// the text glyph coming back.

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
  return host.querySelector<HTMLElement>('[data-testid="caret"]')!;
}

describe("Caret geometry", () => {
  it("draws a Phosphor icon, not a text glyph", () => {
    const caret = mountCaret();
    expect(caret).toBeTruthy();
    const svg = caret.querySelector("svg");
    // Phosphor's grid. The point of the assertion is that the caret is an
    // icon from the shared set — the original defect was a font glyph.
    expect(svg?.getAttribute("viewBox")).toBe("0 0 256 256");
    // No text content: a glyph would reintroduce the original defect.
    expect(caret.textContent?.trim()).toBe("");
  });

  it("centres the icon box inside the wrapper", () => {
    // Phosphor's ink sits marginally below its own box centre; the wrapper
    // centring is what keeps the caret on the label's optical centre. If this
    // ever regresses to baseline-aligned inline layout, the arrow hangs low
    // again — the exact defect this component exists to prevent.
    const caret = mountCaret();
    const style = getComputedStyle(caret);
    expect(style.display).toBe("inline-flex");
    expect(style.alignItems).toBe("center");
    expect(style.justifyContent).toBe("center");
  });

  it("takes its colour from the caller so dark and light need no override", () => {
    const caret = mountCaret({ tone: "var(--t3)" });
    expect(caret.getAttribute("style")).toContain("var(--t3)");
    expect(caret.querySelector("svg")?.getAttribute("fill")).toBe(
      "currentColor",
    );
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
