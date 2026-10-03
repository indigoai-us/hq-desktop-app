import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Shell chrome and overlays follow the Messages type grammar
 * (docs/design-standard-console-rail.md): 13px sans for UI text, weight at
 * most 500, no tracked mono caps headers, no emoji glyphs in chrome, and no
 * backdrop-filter on popovers.
 */
const FILES = [
  "../home/V4TitleBar.svelte",
  "../home/CorePopover.svelte",
  "../inbox/NotificationsPopover.svelte",
  "./MoreCompaniesPopover.svelte",
  "./AccountMenu.svelte",
  "../common/CommandPalette.svelte",
  "../chat/CreateModal.svelte",
  "../chat/NewMessageSheet.svelte",
  "../chat/NewChannelSheet.svelte",
  "../chat/PeoplePicker.svelte",
  "../chat/DmRequestsPanel.svelte",
  "../chat/messaging/ShareRequestCard.svelte",
];

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function styleOf(source: string): string {
  const start = source.lastIndexOf("<style>");
  return start >= 0 ? source.slice(start) : "";
}

/** Declarations only; comments mention the banned properties by name. */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("shell chrome type contract", () => {
  for (const rel of FILES) {
    describe(rel, () => {
      const css = declarations(styleOf(read(rel)));

      it("caps font weight at 500", () => {
        expect(css).not.toMatch(/font-weight:\s*(6|7|8|9)\d\d/);
        expect(css).not.toMatch(/font:\s*(6|7|8|9)\d\d\s/);
      });

      it("uses no tracked uppercase headers", () => {
        // `::first-letter { uppercase }` is sentence case, not caps.
        const caps = css.replace(/[^{}]*::first-letter\s*\{[^}]*\}/g, "");
        expect(caps).not.toMatch(/text-transform:\s*uppercase/);
        expect(css).not.toMatch(/letter-spacing:\s*0?\.\d*[1-9]/);
      });

      it("keeps sans UI text at 13px (mono code may be 12px)", () => {
        const bad: string[] = [];
        for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const mono = /font-mono|monospace/.test(body);
          // Avatar / monogram marks size their initials to the tile.
          const mark = /(mark|mono|mini|avatar|dot)\b|\.pp-li i/.test(selector);
          // Labelled button labels are 12px by the design standard (OWNER-007).
          const labelledButton = /\.v4-launch-change\b/.test(selector);
          for (const m of body.matchAll(/font(?:-size)?:[^;]*?\b(\d+)px/g)) {
            const px = Number(m[1]);
            if (px === 13 || px === 20) continue;
            if (mono && px === 12) continue;
            if (mark && px <= 11) continue;
            if (labelledButton && px === 12) continue;
            bad.push(`${selector.trim()} → ${m[0]}`);
          }
        }
        expect(bad).toEqual([]);
      });

      it("paints popovers without backdrop-filter", () => {
        const active = [...css.matchAll(/backdrop-filter:\s*([^;]+);/g)]
          .map((m) => m[1].trim())
          .filter((value) => value !== "none");
        expect(active).toEqual([]);
      });
    });
  }

  it("draws sidebar filter and create chrome with SVG, not emoji", () => {
    const sidebar = read("../chat/ChatSidebar.svelte");
    expect(sidebar).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(sidebar).toContain('placement: "bottom-start" }}');
  });

  it("does not let the Connection requests row grow into the empty list", () => {
    const css = declarations(styleOf(read("../chat/ChatSidebar.svelte")));
    expect(css).toMatch(/\.chat-requests-row\s*\{[^}]*flex:\s*0 0 auto/);
  });
});
