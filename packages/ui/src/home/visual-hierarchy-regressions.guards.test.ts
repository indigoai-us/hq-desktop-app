// desktop-alt port (subset): the VersionPopout assertions from the original
// desktop-alt suite stay with whichever area ports VersionPopout.svelte —
// this file keeps the V4TitleBar + tokens.css halves that live in home/.
//
// Sources are whitespace-normalized before matching because the monorepo runs
// Prettier over ported files (the desktop originals were hand-wrapped); the
// assertions still pin the exact token values, quotes-agnostic.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const normalize = (s: string) =>
  s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");

const titleBar = readFileSync(
  new URL("./V4TitleBar.svelte", import.meta.url),
  "utf8",
);
const tokens = normalize(
  readFileSync(new URL("./tokens.css", import.meta.url), "utf8"),
);
const confirmDialog = readFileSync(
  new URL("../common/ConfirmDialog.svelte", import.meta.url),
  "utf8",
);

describe("desktop visual hierarchy regressions", () => {
  it("keeps pressed global controls neutral while preserving aria-pressed selection", () => {
    expect(titleBar).toContain("aria-pressed={!sidebarCollapsed}");
    const selectedRule = titleBar.match(
      /\.v4-icon-btn\[aria-pressed=['"]true['"]\]\s*\{([\s\S]*?)\}/,
    )?.[1];
    // A soft fill, not a box: no outline ring or inset shadow (owner review 2026-10-08).
    expect(selectedRule).toMatch(/background:\s*var\(--hover\)/);
    expect(selectedRule).toContain("var(--v4-text-1)");
    expect(selectedRule).toMatch(/border-color:\s*transparent/);
    expect(selectedRule).not.toMatch(/box-shadow|outline|border-color:\s*var/);
    // The host's shared icon-button rule outlines hover/active; the titlebar's
    // own (scoped, so stronger) hover/active rule clears that border.
    const hoverRule = titleBar.match(/\.v4-icon-btn:hover,\s*\.v4-icon-btn\.active\s*\{([\s\S]*?)\}/)?.[1];
    expect(hoverRule).toMatch(/border-color:\s*transparent/);
    expect(selectedRule).not.toMatch(
      /purple|violet|indigo|#[456789a-f][0-9a-f]{5}/i,
    );
  });

  it("wires the titlebar to startWindowDrag and does not use a CSS drag region", () => {
    expect(titleBar).toContain("startWindowDrag");
    const css = titleBar.split("<style>")[1] ?? "";
    expect(css).not.toMatch(/-webkit-app-region:\s*drag/);
  });

  it("paints the sign-out confirm on an opaque card", () => {
    expect(confirmDialog).toContain("background: var(--overlay-bg)");
    expect(confirmDialog).not.toMatch(
      /\.confirm-card\s*\{[^}]*background:\s*var\(--raised/,
    );
  });

  it("paints a dark ground in dark mode instead of a white film (#807 regression)", () => {
    // The PR772 refresh set the dark ground to `rgb(255 255 255 / 0.02)`, which
    // paints nothing: the glass window then showed only blurred wallpaper and
    // white text became unreadable. Dark mode must tint its own ground.
    const chatTokens = normalize(
      readFileSync(new URL("../chat/tokens.css", import.meta.url), "utf8"),
    );
    const darkGround =
      "--v4-ground: rgb(17 17 17 / clamp(0.6, calc(1 - var(--hq-window-transparency-factor, 0) * 0.615385), 1));";
    for (const source of [tokens, chatTokens]) {
      // Both the system-dark and forced-dark blocks.
      expect(source.split(darkGround).length - 1).toBe(2);
      expect(source).not.toContain(
        "--v4-ground: rgb(255 255 255 / clamp(0.02,",
      );
    }
  });

  // OWNER-R16 (08f5424a2): detached menus use the neutral Core menu surface.
  // The PR772 tinted values (252 252 253 / 44 44 54) were replaced on purpose.
  // Owner review 2026-10-08: pop-ups carry no blur (OWNER-006), so their
  // surface is solid at every window-opacity setting; a translucent pop-up
  // without blur lets the content behind it read through its text.
  it("keeps detached menus legible on the neutral Core menu surface, solid at any opacity", () => {
    expect(tokens).toContain(
      "--v4-glass-filter-popover: blur(40px) saturate(124%) contrast(104%);",
    );
    expect(tokens).toContain("--v4-popover-strong: #fafafa;");
    expect(tokens).toContain("--v4-popover-strong: #242424;");
    expect(tokens).toContain("--v4-popover: #2a2a2a;");
    const chatTokens = normalize(readFileSync(new URL("../chat/tokens.css", import.meta.url), "utf8"));
    for (const source of [tokens, chatTokens]) {
      const values = [...source.matchAll(/--v4-popover(?:-strong)?:\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(tokens).not.toContain("rgb(44 44 54");
    expect(tokens).not.toContain("rgb(252 252 253");
  });

  it(
    "paints solid window surfaces before the opacity preference is available",
    () => {
      // Stylesheets load before installAppearancePreferences can hydrate the
      // persisted setting and set data-window-transparency on :root. A fresh
      // install must therefore start from the same opaque endpoint as 100%.
      const chatTokens = normalize(
        readFileSync(new URL("../chat/tokens.css", import.meta.url), "utf8"),
      );

      for (const source of [tokens, chatTokens]) {
        const lightDefault = source.match(
          /:root\[data-window-transparency="0"\], :root:not\(\[data-window-transparency\]\)\s*\{([^}]*)\}/,
        )?.[1];
        expect(lightDefault).toBeDefined();
        expect(lightDefault).toContain("--v4-ground: #f2f2f2;");
        expect(lightDefault).toContain("--v4-chrome: #e8e8e8;");
        expect(lightDefault).toContain("--v4-sidebar: #e0e0e0;");
        expect(lightDefault).toContain("--v4-secondary-sidebar: #eeeeee;");
        expect(lightDefault).toContain("--v4-glass-filter: none;");

        const darkDefault = source.match(
          /:root\[data-window-transparency="0"\]\.dark,[^{}]*:root:not\(\[data-window-transparency\]\)\.dark,[^{}]*\{([^}]*)\}/,
        )?.[1];
        expect(darkDefault).toBeDefined();
        expect(darkDefault).toContain("--v4-ground: #111111;");
        expect(darkDefault).toContain("--v4-chrome: #1e1e1e;");
        expect(darkDefault).toContain("--v4-sidebar: #181818;");
        expect(darkDefault).toContain("--v4-secondary-sidebar: #1a1a1a;");

        expect(source).toContain(
          ':root:not([data-window-transparency]):not([data-force-theme="light"])',
        );
      }
    },
  );

  it(
    "uses solid window surfaces at the 100% opacity endpoint in light and dark themes",
    () => {
      const chatTokens = normalize(
        readFileSync(new URL("../chat/tokens.css", import.meta.url), "utf8"),
      );

      for (const source of [tokens, chatTokens]) {
        const lightEndpoint = source.match(
          /:root\[data-window-transparency="0"\], :root:not\(\[data-window-transparency\]\)\s*\{([^}]*)\}/,
        )?.[1];
        expect(lightEndpoint).toBeDefined();
        expect(lightEndpoint).toContain("--v4-ground: #f2f2f2;");
        expect(lightEndpoint).toContain("--v4-chrome: #e8e8e8;");
        expect(lightEndpoint).toContain("--v4-sidebar: #e0e0e0;");
        expect(lightEndpoint).toContain("--v4-secondary-sidebar: #eeeeee;");
        expect(lightEndpoint).toContain("--v4-glass-filter: none;");

        const darkEndpoint = source.match(
          /:root\[data-window-transparency="0"\]\.dark,[^{}]*\{([^}]*)\}/,
        )?.[1];
        expect(darkEndpoint).toBeDefined();
        expect(darkEndpoint).toContain("--v4-ground: #111111;");
        expect(darkEndpoint).toContain("--v4-chrome: #1e1e1e;");
        expect(darkEndpoint).toContain("--v4-sidebar: #181818;");
        expect(darkEndpoint).toContain("--v4-secondary-sidebar: #1a1a1a;");
      }
    },
  );
});
