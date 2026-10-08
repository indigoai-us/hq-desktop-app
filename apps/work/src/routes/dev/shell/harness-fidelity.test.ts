/**
 * The design harness has to lay out the way the shipping desktop window lays
 * out, or it sends you to fix components that were never broken.
 *
 * The failure mode is silent. `apps/sync/src/desktop-alt/styles/desktop-alt.css`
 * applies window-level global CSS that the work app does not; while the
 * `box-sizing` reset was missing here, every `width: 100%` element with padding
 * overflowed its container in the harness and nowhere else, which read as a
 * layout bug in `@hq/ui`.
 *
 * Each assertion below is a pair that has actually bitten. When you find
 * another, fix the harness and add the assertion in the same change.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const harness = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

const desktopWindowCss = readFileSync(
  new URL(
    "../../../../../sync/src/desktop-alt/styles/desktop-alt.css",
    import.meta.url,
  ),
  "utf8",
);

const harnessStyle = harness.split("<style>")[1] ?? "";

describe("design harness fidelity", () => {
  it("reproduces the window's box-sizing reset", () => {
    // The shipping window resets every descendant.
    expect(desktopWindowCss).toMatch(
      /html\[data-window='desktop-alt'\] \*,[\s\S]*?\{\s*box-sizing: border-box;/,
    );
    // So must the stage. Scoped to `.harness-root` so the rest of the work app
    // keeps its own defaults.
    expect(harnessStyle).toMatch(
      /\.harness-root :global\(\*\)\s*\{\s*box-sizing: border-box;\s*\}/,
    );
  });

  it("declares desktop capabilities, not web ones", () => {
    // Half the window chrome is capability-gated and none of it announces that
    // it is missing: WEB_CAPABILITIES silently drops the window-control
    // gutter, the Launch pill, the Core popover and the local-only rails.
    expect(harness).toContain("TAURI_CAPABILITIES");
    expect(harness).not.toContain("WEB_CAPABILITIES");
    // `isAvailable` has to agree with the table — several controls ask through
    // it rather than reading `capabilities` directly.
    expect(harness).toMatch(
      /isAvailable:\s*\([\s\S]*?\)\s*=>\s*\n?\s*TAURI_CAPABILITIES\[capability\]/,
    );
  });

  it("answers timeline fetches from the fixtures it seeded", () => {
    // An adapter that returned an empty page wiped the seeded thread a beat
    // after it painted — the conversation flashed in and fell back to the
    // empty state.
    expect(harness).toContain("createFixtureConversationApi");
    expect(harness).toMatch(/fetchChannel:[\s\S]*?fixtureConversation\.fetchChannel/);
  });

  it("draws the stand-in traffic lights from the titlebar's own metrics", () => {
    // Hard-coded geometry drifted once already (the gutter grew 78 → 96px).
    expect(harness).toContain("home.TITLEBAR_TRAFFIC_LIGHT_X_PX");
    expect(harness).toContain("home.TITLEBAR_HEIGHT_PX");
  });

  it("loads the faces the desktop window ships", () => {
    expect(harness).toContain("@fontsource-variable/geist-mono/wght.css");
    // Module-graph URLs, not CSS url(): SvelteKit's dev server answers 403 for
    // files outside apps/work that are not imported, and type silently falls
    // back to the system face.
    for (const weight of [400, 500, 600]) {
      expect(harness).toContain(
        `sync/src/assets/fonts/geist-sans-${weight}.woff2?url`,
      );
    }
    expect(harness).toContain('new FontFace("Geist"');
    expect(harnessStyle).not.toMatch(/url\([^)]*sync\/src\/assets\/fonts/);
  });
});
