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

  it("keeps detached menus legible with the refreshed neutral material", () => {
    expect(tokens).toContain(
      "--v4-glass-filter-popover: blur(40px) saturate(124%) contrast(104%);",
    );
    expect(tokens).toContain(
      "--v4-popover-strong: rgb(252 252 252 / clamp(0.90, calc(0.96 + 0.65 - var(--hq-window-transparency-factor, 0.65)), 1));",
    );
    expect(tokens).toContain(
      "--v4-popover-strong: rgb(44 44 44 / clamp(0.90, calc(0.94 + 0.65 - var(--hq-window-transparency-factor, 0.65)), 1));",
    );
  });
});
