import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  TITLEBAR_HEIGHT_CSS_VAR,
  TITLEBAR_LEADING_INSET_CSS_VAR,
} from "../home/titlebar-layout.js";

const SRC = join(import.meta.dirname, "..");

const BACK_HEADER_PAGES = [
  "library/LibraryOverlay.svelte",
  "settings/ShellSettings.svelte",
  "settings/SettingsPage.svelte",
  "meetings/MeetingsPage.svelte",
  "inbox/NotificationsView.svelte",
  "inbox/SharedFilesOverlay.svelte",
] as const;

const PAGE_BACK_TESTIDS = [
  "library-back",
  "settings-back",
  "meetings-back",
  "notifications-back",
  "shared-files-back",
] as const;

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) svelteFiles(full, out);
    else if (entry.name.endsWith(".svelte")) out.push(full);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("sub-page Back headers share PageHeader + titlebar inset", () => {
  it("every known Back-header page imports the shared PageHeader", () => {
    for (const rel of BACK_HEADER_PAGES) {
      const source = read(rel);
      expect(source, rel).toContain('from "../shell/PageHeader.svelte"');
      expect(source, rel).toContain("<PageHeader");
    }
  });

  it("no Back-header page hardcodes its own top-left padding or header height", () => {
    for (const rel of BACK_HEADER_PAGES) {
      const source = read(rel);
      expect(source, rel).not.toMatch(/padding-left:\s*\d+px/);
      expect(source, rel).not.toMatch(/height:\s*52px/);
      expect(source, rel).not.toMatch(/flex:\s*0\s+0\s+52px/);
    }
  });

  it("PageHeader and V4TitleBar both consume the shared CSS variables", () => {
    const header = read("shell/PageHeader.svelte");
    const titleBar = read("home/V4TitleBar.svelte");
    const tokens = read("home/tokens.css");
    expect(tokens).toContain(`${TITLEBAR_HEIGHT_CSS_VAR}:`);
    expect(tokens).toContain(`${TITLEBAR_LEADING_INSET_CSS_VAR}:`);
    expect(header).toContain(`var(${TITLEBAR_HEIGHT_CSS_VAR}`);
    expect(header).toContain(`var(${TITLEBAR_LEADING_INSET_CSS_VAR}`);
    expect(titleBar).toContain(`var(${TITLEBAR_HEIGHT_CSS_VAR}`);
    expect(titleBar).toContain(`var(${TITLEBAR_LEADING_INSET_CSS_VAR}`);
    expect(titleBar).not.toMatch(/padding-left:\s*78px/);
    expect(titleBar).not.toMatch(/height:\s*48px/);
  });

  it("does not leave a page-chrome Back testid outside PageHeader consumers", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === "shell/PageHeader.svelte") continue;
      const source = readFileSync(file, "utf8");
      const usesPageHeader = source.includes("<PageHeader");
      for (const testid of PAGE_BACK_TESTIDS) {
        if (source.includes(`data-testid="${testid}"`) && !usesPageHeader) {
          offenders.push(`${rel} (${testid})`);
        }
      }
    }
    expect(offenders, `Back testid without PageHeader: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("does not let a new full-window Back header skip PageHeader", () => {
    const inPanelBack = /Back to (team list|knowledge tree|goals list|search|queue)/;
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === "shell/PageHeader.svelte") continue;
      if ((BACK_HEADER_PAGES as readonly string[]).includes(rel)) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/<!--[\s\S]*?-->/g, "");
      if (inPanelBack.test(source)) continue;
      const hasHeader = /<header\b/.test(source);
      const hasPageBack =
        /aria-label="Back"/.test(source) ||
        />\s*←?\s*Back\s*</.test(source) ||
        /<span[^>]*>←<\/span>\s*Back/.test(source);
      if (hasHeader && hasPageBack && !source.includes("<PageHeader")) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `new Back header without PageHeader: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
