// Owner feedback: the titlebar Core popout must use the same surface as the
// Launch popout. The Core panel used --panel-bg (a slate rgba(44,44,54)) while
// the Launch menu uses --v4-popover-strong, so the two read as different
// colours. These source contracts pin the shared tokens, the no-blur rule, the
// vertical-only scroll, and the absence of colour literals in the stylesheet.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), "utf8");

function styleOf(source: string): string {
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  if (!match) throw new Error("no <style> block");
  return match[1].replace(/\/\*[\s\S]*?\*\//g, "");
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule ${selector} not found`);
  return match[1];
}

function decl(body: string, prop: string): string | undefined {
  const match = body.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;]+);`));
  return match?.[1].trim();
}

const coreCss = styleOf(read("CorePopover.svelte"));
const launchCss = styleOf(read("V4TitleBar.svelte"));
const core = rule(coreCss, ".core-popover");
const launch = rule(launchCss, ".v4-launch-menu");

describe("Core popout surface matches the Launch popout", () => {
  it.each(["background", "border", "border-radius", "box-shadow"])(
    "uses the same token chain for %s",
    (prop) => {
      expect(decl(launch, prop)).toBeDefined();
      expect(decl(core, prop)?.split(",")[0]).toBe(decl(launch, prop)?.split(",")[0]);
    },
  );

  it("does not fall back to the slate --panel-bg as its primary surface", () => {
    expect(decl(core, "background")).toMatch(/^var\(--v4-popover-strong,/);
  });

  it("carries no backdrop-filter", () => {
    expect(coreCss).not.toMatch(/backdrop-filter/);
  });

  it("scrolls vertically only, so nothing is clipped behind a horizontal scrollbar", () => {
    expect(decl(core, "overflow-x")).toBe("hidden");
    expect(decl(core, "overflow-y")).toBe("auto");
    expect(decl(core, "overflow")).toBeUndefined();
    expect(decl(core, "box-sizing")).toBe("border-box");
  });

  it("uses tokens for inner cards instead of the bare legacy --raised", () => {
    expect(coreCss).not.toMatch(/background:\s*var\(--raised\)/);
    expect(coreCss).toMatch(/var\(--v4-raised, var\(--raised\)\)/);
  });

  it("has no hardcoded colour literals in its stylesheet", () => {
    expect(coreCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(coreCss).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
  });
});
