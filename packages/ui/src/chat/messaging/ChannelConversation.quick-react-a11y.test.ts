import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression: keyboard reachability of the message quick-react / reply toolbar.
 *
 * The perf branch hid `.dm-quick-react` with `visibility: hidden` at rest so the
 * large `box-shadow` would not be rasterized on every row. `visibility: hidden`
 * also removes every descendant from the tab order, so keyboard-only and
 * screen-reader users could no longer reach react/reply on rows that have no
 * other focusable descendant (plain-text messages, burst-continuation rows) —
 * `:focus-within` could never fire there.
 *
 * The rest state must stay `opacity: 0` only (which keeps the buttons
 * focusable); the paint cost is avoided with `box-shadow: none` at rest instead.
 */

const channelConversation = readFileSync(
  new URL("./ChannelConversation.svelte", import.meta.url),
  "utf8",
);

/** The top-level (rest state) declarations for `.<selector> { … }`. */
function restRuleFor(source: string, selector: string): string | undefined {
  const match = source.match(
    new RegExp(`\\n {2}\\.${selector} \\{([\\s\\S]*?)\\n {2}\\}`),
  );
  return match?.[1] === undefined ? undefined : stripComments(match[1]);
}

/** Assert on declarations only — prose in a comment is not a style. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The reveal rule keyed on `.dm-msg:hover` / `.dm-msg:focus-within`. */
function revealRule(source: string): string | undefined {
  const match = source.match(
    /\n {2}\.dm-msg:hover \.dm-quick-react,[\s\S]*?\{([\s\S]*?)\n {2}\}/,
  );
  return match?.[1] === undefined ? undefined : stripComments(match[1]);
}

describe("quick-react toolbar keyboard reachability", () => {
  it("does not remove the resting toolbar from the tab order", () => {
    const rest = restRuleFor(channelConversation, "dm-quick-react");
    expect(rest).toBeDefined();
    // `visibility: hidden` (and `collapse`) strip descendants from the tab
    // order — the buttons inside become keyboard-unreachable.
    expect(rest).not.toMatch(/visibility:\s*(hidden|collapse)/);
  });

  it("avoids the resting shadow raster with box-shadow instead", () => {
    const rest = restRuleFor(channelConversation, "dm-quick-react");
    expect(rest).toMatch(/box-shadow:\s*none/);
    // …and restores the floating-bar shadow when the row is hovered/focused.
    expect(revealRule(channelConversation)).toMatch(/box-shadow:\s*var\(/);
  });
});
