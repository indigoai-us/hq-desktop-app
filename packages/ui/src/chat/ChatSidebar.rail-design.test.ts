// @vitest-environment happy-dom
/**
 * Design contract for the rail rows, the search palette shell and the rail
 * scrollbar (ported from the PR #772 design pass).
 *
 * - Rows: the row BOX (`.chat-conv-li`) carries the hover / selected fill so
 *   the pin and the unread count sit inside the highlight; the pin is hidden
 *   at rest, pinned or not, and shows on row hover or keyboard focus.
 * - Search palette: hangs 72px from the top on a lighter 0.28 scrim; a 12px
 *   card on the console-rail beta's one overlay surface (OWNER-006:
 *   --overlay-bg / -border / -shadow, both themes, no backdrop blur — the
 *   same as the Create modal); a `13px 16px` header with a 24px icon close.
 * - Rail scrollbar: one 4px bar — no `scrollbar-width` / `scrollbar-color`,
 *   which WebKit/Chromium let override the 4px `::-webkit-scrollbar` rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ChatSidebar.svelte"),
  "utf8",
);

/** The component's `<style>` block, comments stripped. */
const css = (() => {
  const open = src.lastIndexOf("<style>");
  const close = src.lastIndexOf("</style>");
  return src.slice(open + "<style>".length, close).replace(/\/\*[\s\S]*?\*\//g, "");
})();

type Rule = { selectors: string[]; body: string };

/** Flat list of `selector { body }` rules (inner rules of @media included). */
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]
    .split(",")
    .map((sel) => sel.replace(/\s+/g, " ").trim())
    .filter(Boolean),
  body: m[2],
}));

function rulesFor(selector: string): Rule[] {
  return rules.filter((rule) => rule.selectors.includes(selector));
}

/** Last declared value of `prop` across every rule naming `selector`. */
function decl(selector: string, prop: string): string | null {
  let value: string | null = null;
  for (const rule of rulesFor(selector)) {
    const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`, "g");
    for (const m of rule.body.matchAll(re)) value = m[1].trim();
  }
  return value;
}

const HOVER = ".chat-conv-li:hover";
const KEYBOARD = ".chat-conv-li:has(:global(:focus-visible))";

describe("rail rows: the highlight wraps the pin and the unread count", () => {
  it("puts the hover / selected fill on the row box, not the row button", () => {
    expect(decl(".chat-conv-li", "border-radius")).toBe("8px");
    expect(decl(".chat-conv-li:hover", "background")).toBe("var(--hover)");
    expect(decl(".chat-conv-li.active", "background")).toBe("var(--sel)");
    // The button inside the box draws no fill of its own, at rest, on hover,
    // when active or when selected — the tint is drawn once.
    for (const sel of [
      ".chat-conv-li .chat-row",
      ".chat-conv-li .chat-row:hover",
      ".chat-conv-li .chat-row.active",
      ".chat-conv-li .chat-row.selected",
    ]) {
      expect(decl(sel, "background"), sel).toBe("transparent");
    }
  });

  it("hides the pin at rest — pinned rows included — and shows it on row hover or keyboard focus", () => {
    expect(decl(".chat-pin-btn", "opacity")).toBe("0");
    // Every rule that brings the pin back is scoped to row hover or keyboard
    // focus inside the row; nothing reveals it just because it is pinned.
    const reveals = rules.filter(
      (rule) =>
        rule.selectors.some((sel) => sel.includes(".chat-pin-btn")) &&
        /(?:^|[;\s])opacity\s*:\s*1\s*;/.test(rule.body),
    );
    expect(reveals.length).toBeGreaterThan(0);
    const revealSelectors = reveals.flatMap((rule) => rule.selectors);
    expect(revealSelectors).toContain(`${HOVER} .chat-pin-btn`);
    expect(revealSelectors).toContain(`${KEYBOARD} .chat-pin-btn`);
    for (const sel of revealSelectors) {
      expect(sel.startsWith(HOVER) || sel.startsWith(KEYBOARD), sel).toBe(true);
    }
    expect(decl(".chat-pin-btn.pinned", "opacity")).toBeNull();
    expect(decl(".chat-pin-btn.pinned", "background")).toBeNull();
  });

  it("shows the company / email label only on row hover or keyboard focus", () => {
    expect(decl(".chat-row-scope", "display")).toBe("none");
    expect(decl(`${HOVER} .chat-row-scope`, "display")).toBe("inline");
    expect(decl(`${KEYBOARD} .chat-row-scope`, "display")).toBe("inline");
    expect(src).not.toMatch(/chat-row-reveal/);
  });

  // Hovering a row revealed the label and the row grew 31px -> 32px, pushing
  // every row below it down 1px. The label is baseline-aligned with the 13px
  // title; on the row's inherited 17px line height its baseline sits higher in
  // its box, so its box hung 1px below the title's. Contract: the row's text
  // line is fixed (7px + 17px + 7px), the label's own line box is short enough
  // to stay inside the title's line box once baselines align, but tall enough
  // that `overflow: hidden` does not clip its descenders, and the reveal only
  // toggles `display` — nothing that could change the box.
  it("reveals the label without growing the row", () => {
    expect(decl(".chat-row", "line-height")).toBe("17px");
    expect(decl(".chat-row", "padding")).toBe("7px 8px");
    expect(decl(".chat-row-copy", "align-items")).toBe("baseline");

    const fontSize = parseFloat(decl(".chat-row-scope", "font-size") ?? "");
    expect(fontSize).toBe(11);
    const lineHeight = decl(".chat-row-scope", "line-height");
    expect(lineHeight, "the label needs its own px line height").toMatch(/^\d+(?:\.\d+)?px$/);
    const lh = parseFloat(lineHeight!);
    // 17px title box minus the 2px the 11px baseline rides above the 13px one
    // on each side: anything above 13px hangs below the title box again.
    expect(lh).toBeLessThanOrEqual(13);
    // At 1x the glyph box (~1.15em) overflows and the clip eats descenders.
    expect(lh).toBeGreaterThanOrEqual(Math.ceil(fontSize * 1.15));

    for (const sel of [`${HOVER} .chat-row-scope`, `${KEYBOARD} .chat-row-scope`]) {
      const body = rulesFor(sel)
        .map((rule) => rule.body)
        .join(";");
      expect(body, sel).not.toMatch(
        /(?:^|[;\s])(?:line-height|font-size|font|padding|margin|border|height|min-height)\s*:/,
      );
    }
  });
});

describe("search palette shell", () => {
  it("hangs from the top at 72px on a lighter scrim", () => {
    expect(decl(".chat-overlay", "background")).toBe("rgba(0, 0, 0, 0.28)");
    expect(decl(".chat-overlay.top", "align-items")).toBe("flex-start");
    expect(decl(".chat-overlay.top", "padding-top")).toBe("72px");
  });

  it("is a 12px card on the overlay surface tokens in both themes", () => {
    expect(decl(".chat-switcher", "border-radius")).toBe("12px");
    expect(decl(".chat-switcher", "background")).toBe("var(--overlay-bg)");
    expect(decl(".chat-switcher", "border")).toBe("1px solid var(--overlay-border)");
    expect(decl(".chat-switcher", "box-shadow")).toBe("var(--overlay-shadow)");
    // No per-theme override repaints the card with a flat surface: the
    // tokens already carry light and dark.
    const overrides = rules.filter(
      (rule) =>
        rule.selectors.some((sel) => /\.chat-switcher$/.test(sel) && sel !== ".chat-switcher") &&
        /(?:^|[;\s])background\s*:/.test(rule.body),
    );
    expect(overrides).toEqual([]);
  });

  it("has a 13px 16px header and a 24px icon close button", () => {
    expect(decl(".chat-switcher-search", "padding")).toBe("13px 16px");
    expect(decl(".chat-switcher-close", "width")).toBe("24px");
    expect(decl(".chat-switcher-close", "height")).toBe("24px");
    expect(decl(".chat-switcher-close", "border-radius")).toBe("6px");
    expect(decl(".chat-switcher-close", "background")).toBe("transparent");
  });
});

describe("rail scrollbar", () => {
  it("is one 4px bar: no standard scrollbar properties override the 4px rule", () => {
    expect(decl(".chat-scroll", "scrollbar-width")).toBeNull();
    expect(decl(".chat-scroll", "scrollbar-color")).toBeNull();
    // `scrollbar-width: none` (hide outright) is fine; `thin` never is.
    expect(css).not.toMatch(/scrollbar-width\s*:\s*thin/);
    expect(decl(".chat-scroll::-webkit-scrollbar", "width")).toBe("4px");
    expect(decl(".chat-scroll::-webkit-scrollbar-track", "background")).toBe("transparent");
    expect(decl(".chat-scroll::-webkit-scrollbar-thumb", "background")).toBe("var(--line)");
    expect(decl(".chat-scroll::-webkit-scrollbar-thumb", "border-radius")).toBe("2px");
  });
});

// ---- Behaviour: the palette's close button --------------------------------

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_palette",
  type: "project",
  scope: "project",
  companyUid: "cmp_palette",
  name: "Palette test",
  lastActivityAt: new Date().toISOString(),
};

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [seedRow],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({
      homeChannelId: `chn_home_${companyUid}`,
    }),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

describe("search palette close button", () => {
  it("closes the palette and returns focus to the search button", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi(), seedDirectory: [seedRow] },
    });
    const trigger = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>('[data-testid="chat-search"]');
      expect(button).toBeTruthy();
      return button!;
    });
    trigger.click();
    await tick();

    const overlay = host.querySelector('[data-testid="chat-search-overlay"]');
    expect(overlay).toBeTruthy();
    const close = overlay!.querySelector<HTMLButtonElement>(
      '[data-testid="chat-search-close"]',
    );
    expect(close).toBeTruthy();
    expect(close!.getAttribute("aria-label")).toBe("Close search");
    // The close sits in the header, after the search field.
    expect(close!.closest(".chat-switcher-search")).toBeTruthy();

    close!.click();
    await tick();
    expect(host.querySelector('[data-testid="chat-search-overlay"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
