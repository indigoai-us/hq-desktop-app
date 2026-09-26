import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  TITLEBAR_HEIGHT_CSS_VAR,
  TITLEBAR_HEIGHT_PX,
  TITLEBAR_LEADING_INSET_CSS_VAR,
  TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX,
} from "../home/titlebar-layout.js";

const SRC = join(import.meta.dirname, "..");

const BACK_HEADER_PAGES = [
  "library/LibraryOverlay.svelte",
  "settings/ShellSettings.svelte",
  "settings/SettingsPage.svelte",
  "meetings/MeetingsPage.svelte",
  "inbox/NotificationsView.svelte",
  "inbox/SharedFilesOverlay.svelte",
  "chat/DmRequestsPanel.svelte",
] as const;

const PAGE_BACK_TESTIDS = [
  "library-back",
  "settings-back",
  "meetings-back",
  "notifications-back",
  "shared-files-back",
  "dm-requests-back",
] as const;

/** In-app history Back lives in the title bar / unavailable view, not PageHeader. */
const NON_PAGE_HEADER_BACK = [
  "home/V4TitleBar.svelte",
  "shell/DesktopApp.svelte",
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
      if ((NON_PAGE_HEADER_BACK as readonly string[]).includes(rel)) continue;
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

/**
 * Interface size zooms `.desktop-shell` (WebKit `zoom`), but the native macOS
 * traffic lights are drawn by AppKit and do not zoom. The overlay titlebar
 * tokens therefore have to be divided by the same factor so the bar still
 * renders at its real height and gutter — otherwise the sub-page Back pill
 * slides under the green light at Compact.
 */
describe("Interface-size zoom compensates the overlay titlebar tokens", () => {
  const source = read("shell/DesktopApp.svelte");
  const UI_SIZES = ["compact", "large"] as const;

  function zoomFactor(size: string): number {
    const rule = new RegExp(
      `:global\\(html\\[data-ui-size="${size}"\\]\\)\\s*\\.desktop-shell\\s*\\{[^}]*?zoom:\\s*([0-9.]+)\\s*;`,
    ).exec(source);
    expect(rule, `no zoom rule for data-ui-size="${size}"`).not.toBeNull();
    return Number(rule![1]);
  }

  function compensationRule(size: string): string {
    const rule = new RegExp(
      `:global\\(html\\[data-ui-size="${size}"\\][\\s\\S]*?\\)\\s*\\.desktop-shell\\.has-window-controls\\s*\\{([^}]*)\\}`,
    ).exec(source);
    expect(
      rule,
      `no .has-window-controls compensation rule for data-ui-size="${size}"`,
    ).not.toBeNull();
    return rule![1];
  }

  it.each(UI_SIZES)(
    "%s divides both titlebar tokens by its own zoom factor",
    (size) => {
      const factor = zoomFactor(size);
      const body = compensationRule(size);
      expect(body, size).toContain(
        `${TITLEBAR_HEIGHT_CSS_VAR}: calc(${TITLEBAR_HEIGHT_PX}px / ${factor})`,
      );
      expect(body, size).toContain(
        `${TITLEBAR_LEADING_INSET_CSS_VAR}: calc(${TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX}px / ${factor})`,
      );
    },
  );

  it("only compensates where the window controls are overlaid", () => {
    for (const size of UI_SIZES) {
      const scoped = new RegExp(
        `:global\\(html\\[data-ui-size="${size}"\\][\\s\\S]*?\\)\\s*\\.desktop-shell\\.has-window-controls`,
      );
      expect(scoped.test(source), size).toBe(true);
    }
    // The plain zoom rules must not carry the compensated tokens themselves;
    // web and Windows keep the tokens.css values.
    for (const size of UI_SIZES) {
      const plain = new RegExp(
        `:global\\(html\\[data-ui-size="${size}"\\]\\)\\s*\\.desktop-shell\\s*\\{([^}]*)\\}`,
      ).exec(source);
      expect(plain, size).not.toBeNull();
      expect(plain![1], size).not.toContain(TITLEBAR_HEIGHT_CSS_VAR);
      expect(plain![1], size).not.toContain(TITLEBAR_LEADING_INSET_CSS_VAR);
    }
  });
});
