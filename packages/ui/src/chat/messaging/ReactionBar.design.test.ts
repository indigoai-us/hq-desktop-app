// @vitest-environment happy-dom

// Design contract for the reaction pills (PR #772 port): your own reaction
// reads as a selected control in the shell's ice tint, the pills are the
// design's smaller 22px size, and the OS `title` tooltip no longer draws a
// second copy of the attribution the in-app tooltip already shows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ReactionBar from "./ReactionBar.svelte";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ReactionBar.svelte"),
  "utf8",
);
const css = src.slice(src.indexOf("<style>"));

/** Body of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
}

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ReactionBar, {
    target: host,
    props: {
      messageId: "m1",
      reactions: [
        {
          emoji: "👍",
          count: 2,
          reactedByMe: true,
          reactors: [
            { personUid: "me", displayName: "Lizzie" },
            { personUid: "p2", displayName: "Jacob" },
          ],
        },
        { emoji: "🎉", count: 1, reactedByMe: false },
      ],
      ontoggle: () => {},
      selfPersonUid: "me",
      displayNameByUid: { p2: "Jacob" },
    },
  });
  flushSync();
  return host;
}

describe("ReactionBar design", () => {
  it("drops the OS title tooltip but keeps an accessible name on every pill", () => {
    const el = render();
    const pills = el.querySelectorAll<HTMLButtonElement>(".reaction-pill");
    expect(pills.length).toBe(2);
    for (const pill of pills) {
      expect(pill.hasAttribute("title")).toBe(false);
      expect(pill.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
    }
    expect(pills[0].classList.contains("reacted")).toBe(true);
    expect(pills[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("tints your own reaction with the theme's ice tokens, count in ice ink", () => {
    const reacted = rule(".reaction-pill.reacted");
    expect(reacted).toMatch(/background:\s*var\(--ice-tile\b/);
    expect(reacted).toMatch(/border-color:[^;]*--ice-ink/);
    expect(rule(".reaction-pill.reacted .reaction-count")).toMatch(
      /color:\s*var\(--ice-ink\b/,
    );
    // Tokens only: no hard-coded dark-theme colours on the selected state.
    expect(reacted).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("sizes the main-timeline pill at 22px with 7px sides, 11px emoji and a 10px muted count", () => {
    const pill = rule(".reaction-pill");
    expect(pill).toMatch(/\bheight:\s*22px/);
    expect(pill).toMatch(/padding:\s*0 7px/);
    expect(pill).not.toMatch(/min-height:\s*1\.75rem/);
    expect(rule(".reaction-emoji")).toMatch(/font-size:\s*11px/);
    const count = rule(".reaction-count");
    expect(count).toMatch(/font-size:\s*10px/);
    expect(count).toMatch(/font-weight:\s*500/);
    expect(count).toMatch(/color:\s*var\(--pop-muted\)/);
    // The add button matches the pill it sits beside.
    expect(rule(".reaction-add")).toMatch(/\bheight:\s*22px/);
  });
});
