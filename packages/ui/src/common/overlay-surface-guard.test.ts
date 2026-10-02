// OWNER-006: every sheet, dialog, popover, picker and context menu paints the
// one overlay token set measured from the titlebar Launch menu (--overlay-bg,
// --overlay-border, --overlay-shadow, --overlay-field-*, --overlay-hover).
// Overlays previously mixed --panel-bg (slate rgba(44,44,54)), --v4-surface-solid
// (#1e1e24), --v4-popover and literal hex fills, so New policy and New worker read
// blue next to the neutral Launch menu. The only place surface values may be
// written is the tokens files; this guard fails on any new per-overlay grey.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const OVERLAYS = [
  "agents/FolderPicker.svelte",
  "agents/SkillPicker.svelte",
  "chat/ChannelStatusPopover.svelte",
  "chat/CreateModal.svelte",
  "chat/NewChannelSheet.svelte",
  "chat/NewMessageSheet.svelte",
  "chat/PeoplePicker.svelte",
  "chat/ProjectAboutDialog.svelte",
  "chat/create-bot/CreateBotFlow.svelte",
  "chat/messaging/EmojiPicker.svelte",
  "chat/messaging/MentionPicker.svelte",
  "common/CommandPalette.svelte",
  "common/ConfirmDialog.svelte",
  "common/LinkContextMenu.svelte",
  "common/ShortcutCheatSheet.svelte",
  "company/brain/BrainPage.svelte",
  "files/explorer/QuickSwitcher.svelte",
  "files/explorer/ShareFileSheet.svelte",
  "goals/LinkPicker.svelte",
  "goals/NewGoalSheet.svelte",
  "home/CorePopover.svelte",
  "inbox/NotificationsPopover.svelte",
  "projects/NewProjectSheet.svelte",
  "shell/AccountMenu.svelte",
  "shell/MoreCompaniesPopover.svelte",
  "shell/new-company/NewCompanySheet.svelte",
  "shell/profile-panes/EditBotSheet.svelte",
];

const TOKEN_FILES = ["home/tokens.css", "chat/tokens.css"];

/** Surface tokens that are not the overlay standard, or carry violet/ice tint. */
const FORBIDDEN_TOKEN =
  /var\(--(panel-bg|v4-surface-solid|v4-popover|pop-bg|elevated|vio-[\w-]+|ice-[\w-]+)\b(?!-strong)/;
/** A background whose leading value is a raw colour literal. */
const LITERAL_FILL = /^\s*(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i;
/** Black scrims behind a modal are a dimming layer, not a surface. */
const SCRIM = /^\s*rgba\(0,\s*0,\s*0,\s*0?\.\d+\)\s*$/;

function styleOf(source: string): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function backgroundViolations(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/(?:^|[;{\s])background(?:-color)?\s*:\s*([^;}]+)/g)) {
    const value = m[1].trim();
    if (SCRIM.test(value)) continue;
    if (FORBIDDEN_TOKEN.test(value) || LITERAL_FILL.test(value)) out.push(`background: ${value}`);
  }
  return out;
}

describe("overlay surface guard (OWNER-006)", () => {
  it.each(TOKEN_FILES)("%s defines the overlay token set", (file) => {
    const css = readFileSync(join(src, file), "utf8");
    for (const token of ["--overlay-bg", "--overlay-border", "--overlay-shadow", "--overlay-field-bg", "--overlay-field-border", "--overlay-hover"]) {
      expect(css).toContain(`${token}:`);
    }
    expect(css).toMatch(/--overlay-bg:\s*var\(--v4-popover-strong\)/);
  });

  it.each(OVERLAYS)("%s paints no hardcoded or tinted surface", (file) => {
    const css = styleOf(readFileSync(join(src, file), "utf8"));
    expect(backgroundViolations(css)).toEqual([]);
  });

  it.each(OVERLAYS)("%s has no backdrop-filter blur on its rounded card", (file) => {
    const css = styleOf(readFileSync(join(src, file), "utf8"));
    expect(css.match(/backdrop-filter:(?!\s*none)[^;]+;/g) ?? []).toEqual([]);
  });

  it("the Launch menu reference itself paints the overlay tokens", () => {
    const css = styleOf(readFileSync(join(src, "home/V4TitleBar.svelte"), "utf8"));
    const block = css.match(/\.v4-launch-menu\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/background:\s*var\(--overlay-bg\);/);
    expect(block).toMatch(/border:\s*1px solid var\(--overlay-border\);/);
    expect(block).toMatch(/box-shadow:\s*var\(--overlay-shadow\);/);
  });

  it("the guard catches a slate panel, a literal fill and a violet tint", () => {
    expect(backgroundViolations(".a { background: var(--panel-bg); }")).toHaveLength(1);
    expect(backgroundViolations(".a { background: #1e1e24; }")).toHaveLength(1);
    expect(backgroundViolations(".a { background: var(--vio-soft); }")).toHaveLength(1);
    expect(backgroundViolations(".a { background: rgba(0, 0, 0, 0.45); }")).toEqual([]);
    expect(backgroundViolations(".a { background: var(--overlay-bg); }")).toEqual([]);
  });
});
