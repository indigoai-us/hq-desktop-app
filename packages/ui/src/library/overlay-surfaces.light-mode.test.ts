// Regression: the Library, Shared files and DM requests pages painted
// `var(--v4-bg, var(--desktop-bg, #0c0c0c))`. Neither token is defined in the
// shell, so all three always fell through to #0c0c0c: a black page under the
// light theme's near-black text. A first fix used `--v4-surface-solid`, which
// is a popover surface (#ffffff light, #1e1e24 blue-grey dark) and so did not
// match the shell around it. They must paint the shell's own ground token,
// `--v4-ground` (what `.desktop-shell` / `.desktop-main` paint), with a light
// literal fallback so an undefined token can never turn the page black.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

const pages = [
  // On the console-rail beta the Library overlay is the Marketplace page
  // (`.marketplace-page`, still LibraryOverlay.svelte).
  { file: "./LibraryOverlay.svelte", selector: ".marketplace-page" },
  { file: "../inbox/SharedFilesOverlay.svelte", selector: ".shared-files" },
  { file: "../chat/DmRequestsPanel.svelte", selector: ".dm-requests" },
];

const ruleBody = (css: string, selector: string) => {
  const escaped = selector.replace(/[.]/g, "\\.");
  return css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
};

const backgroundOf = (block: string) =>
  block.match(/background:\s*([^;]*);/)?.[1].replace(/\s+/g, " ").trim();

describe("full-page overlays paint the shell ground in both themes", () => {
  for (const { file, selector } of pages) {
    it(`${file} paints ${selector} with the shell's --v4-ground token`, () => {
      const css = read(file).split("<style>")[1] ?? "";
      const block = ruleBody(css, selector);
      expect(block).toBeDefined();
      const bg = backgroundOf(block!);
      expect(bg).toBeDefined();
      // The visible (top) layer is the shell ground with a light fallback.
      expect(bg).toMatch(/^(?:linear-gradient\()?var\(--v4-ground,\s*#f2f2f2\)/);
      // Not the popover surface as the visible colour, never the old dead tokens.
      expect(bg).not.toMatch(/^var\(--v4-surface-solid\b/);
      expect(css).not.toMatch(/background:[^;]*var\(--v4-bg\b/);
      expect(css).not.toMatch(/--desktop-bg/);
      expect(css).not.toMatch(/background:[^;]*#0c0c0c/);
      // No dark literal anywhere in the background stack.
      for (const hex of bg!.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
        expect(hex.toLowerCase()).toBe("#f2f2f2");
      }
    });
  }

  it("the library (Marketplace) page stays opaque over whatever is under it", () => {
    const css = read("./LibraryOverlay.svelte").split("<style>")[1] ?? "";
    const bg = backgroundOf(ruleBody(css, ".marketplace-page")!)!;
    // Ground on top, opaque surface underneath so a translucent ground (window
    // transparency) cannot let the view below bleed through.
    expect(bg).toMatch(
      /^linear-gradient\(var\(--v4-ground, #f2f2f2\), var\(--v4-ground, #f2f2f2\)\), var\(--v4-surface-solid, #f2f2f2\)$/,
    );
  });

  it("the shell paints the same --v4-ground token these pages use", () => {
    const shell = read("../shell/DesktopApp.svelte").split("<style>")[1] ?? "";
    expect(ruleBody(shell, ".desktop-shell")).toMatch(
      /background:\s*var\(--v4-ground\b/,
    );
  });

  for (const tokens of ["../home/tokens.css", "../chat/tokens.css"]) {
    it(`${tokens} pins the opaque ground: #f2f2f2 light, #111111 dark`, () => {
      const css = read(tokens);
      const light = css.match(
        /:root\[data-window-transparency="0"\],\s*:root:not\(\[data-window-transparency\]\)\s*\{([^}]*)\}/,
      )?.[1];
      expect(light).toMatch(/--v4-ground:\s*#f2f2f2;/);
      const dark = css.match(
        /:root:not\(\[data-window-transparency\]\)\[data-force-theme="dark"\],[^{]*\{([^}]*)\}/,
      )?.[1];
      expect(dark).toMatch(/--v4-ground:\s*#111111;/);
    });
  }
});
