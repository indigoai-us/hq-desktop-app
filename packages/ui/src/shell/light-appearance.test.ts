/**
 * US-038: Home, Atlas, Projects, Meetings, the rail, and the titlebar must
 * follow the light appearance through the shared tokens (home/tokens.css,
 * chat/chat-tokens.css). A raw white text/fill or a dark-only surface color
 * written straight into one of these components would survive the switch and
 * leave a dark-only surface behind in light mode.
 *
 * Asserted against the style blocks because appearance is pure CSS here.
 * Allowed: literals inside a var() fallback, modal scrims (black at 45%,
 * correct in both appearances), and soft black drop shadows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILES = [
  "./AppRail.svelte",
  "./CompanySidepane.svelte",
  "../home/V4TitleBar.svelte",
  "../home/HomePage.svelte",
  "../atlas/AtlasView.svelte",
  "../atlas/AtlasMap.svelte",
  "../atlas/AtlasInspector.svelte",
  "../atlas/AtlasScrubber.svelte",
  "../projects/CompanyProjectsPage.svelte",
  "../projects/BoardCard.svelte",
  "../meetings/MeetingsPage.svelte",
  "../meetings/MeetingsAgenda.svelte",
  "../meetings/MeetingsSidepane.svelte",
];

/** Dark-only literals: white ink/fills and the dark elevated surfaces. */
const DARK_ONLY =
  /#fff\b|#ffffff\b|rgba?\(\s*255\s*,\s*255\s*,\s*255|#1e1e24|#111111\b|#0d0d0d|#303030|#2c3d52/i;

function style(path: string): string {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const start = source.lastIndexOf("<style");
  return start === -1 ? "" : source.slice(start);
}

/** Drop `var(--x, fallback)` fallbacks so only bare literals remain. */
function withoutFallbacks(css: string): string {
  let out = css;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/var\(\s*--[\w-]+\s*,[^()]*(\([^()]*\)[^()]*)*\)/g, "VAR");
  }
  return out;
}

describe("light appearance on the console rail screens", () => {
  for (const file of FILES) {
    it(`${file} has no dark-only color literal`, () => {
      const offending = withoutFallbacks(style(file))
        .split("\n")
        .filter((line) => DARK_ONLY.test(line));
      expect(offending).toEqual([]);
    });
  }
});
