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
    expect(selectedRule).toContain("var(--v4-control-border)");
    expect(selectedRule).toContain("var(--v4-text-1)");
    expect(selectedRule).not.toMatch(
      /purple|violet|indigo|#[456789a-f][0-9a-f]{5}/i,
    );
  });

  it("starts a Tauri window drag from the titlebar with the window label", () => {
    const windowDrag = readFileSync(
      new URL("./window-drag.ts", import.meta.url),
      "utf8",
    );
    expect(titleBar).toContain("startWindowDrag");
    expect(windowDrag).toContain("plugin:window|start_dragging");
    expect(windowDrag).toContain("{ label }");
    const css = titleBar.split("<style>")[1] ?? "";
    expect(css).not.toMatch(/-webkit-app-region:\s*drag/);
  });

  it("paints the sign-out confirm on an opaque card", () => {
    expect(confirmDialog).toContain("--v4-surface-solid");
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
      "--v4-ground: rgb(17 17 17 / clamp(0.35, calc(0.86 + 0.65 - var(--hq-window-transparency-factor, 0.65)), 1));";
    for (const source of [tokens, chatTokens]) {
      // Both the system-dark and forced-dark blocks.
      expect(source.split(darkGround).length - 1).toBe(2);
      expect(source).not.toContain(
        "--v4-ground: rgb(255 255 255 / clamp(0.02,",
      );
    }
  });

  it("keeps detached menus legible with the PR772 reference material", () => {
    expect(tokens).toContain(
      "--v4-glass-filter-popover: blur(40px) saturate(124%) contrast(104%);",
    );
    expect(tokens).toContain(
      "--v4-popover-strong: rgb(252 252 253 / clamp(0.90, calc(0.96 + 0.65 - var(--hq-window-transparency-factor, 0.65)), 1));",
    );
    expect(tokens).toContain(
      "--v4-popover-strong: rgb(44 44 54 / clamp(0.90, calc(0.94 + 0.65 - var(--hq-window-transparency-factor, 0.65)), 1));",
    );
  });
});
