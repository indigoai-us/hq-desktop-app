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
 * another, fix the harness and add the assertion in the same commit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const harness = readFileSync(
  new URL("./+page.svelte", import.meta.url),
  "utf8",
);

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
    // it is missing: WEB_CAPABILITIES silently drops the Launch pill, the HQ
    // folder and Console buttons, the Core popover and the local-only rails.
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
    expect(harness).toMatch(
      /fetchChannel:[\s\S]*?fixtureConversation\.fetchChannel/,
    );
  });

  it("keeps the window scrollbar at the shell's width", () => {
    // The shell-wide rule lives in packages/ui/src/chat/scrollbars.css; the
    // window-level one has to agree or the same app shows two bars.
    const shellScrollbars = readFileSync(
      new URL(
        "../../../../../../packages/ui/src/chat/scrollbars.css",
        import.meta.url,
      ),
      "utf8",
    );
    const widthOf = (css: string): string | undefined =>
      css.match(/::-webkit-scrollbar\s*\{[^}]*?width:\s*(\d+px)/)?.[1];
    expect(widthOf(shellScrollbars)).toBe("4px");
    expect(widthOf(desktopWindowCss)).toBe(widthOf(shellScrollbars));
  });

  it("never sets scrollbar-width alongside a webkit scrollbar rule", () => {
    // `scrollbar-width` is a standard property that BEATS `::-webkit-scrollbar`
    // in current Chromium and WebKit: `thin` rendered an 11px bar straight
    // through the 4px rule beneath it. `none` (hiding a bar) stays legal.
    const declarationsOnly = (css: string): string =>
      css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [label, css] of [
      ["shell", readFileSync(
        new URL(
          "../../../../../../packages/ui/src/chat/scrollbars.css",
          import.meta.url,
        ),
        "utf8",
      )],
      ["window", desktopWindowCss],
    ] as const) {
      const offenders =
        declarationsOnly(css).match(/scrollbar-width:\s*(?!none)[\w-]+/g) ?? [];
      expect(offenders, `${label} stylesheet`).toEqual([]);
    }
  });
});

describe("shell control spacing", () => {
  const shellSources = (): string[] => {
    const out: string[] = [];
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(
          `${entry.name}${entry.isDirectory() ? "/" : ""}`,
          dir,
        );
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".svelte")) out.push(readFileSync(child, "utf8"));
      }
    };
    walk(new URL("../../../../../../packages/ui/src/", import.meta.url));
    return out;
  };

  it("gives every small-button cluster the same gap", () => {
    // One value for a row of labelled small buttons. Production had drifted to
    // 2, 4, 6, 8, 9 and 10px across thirty-odd clusters, so no two button rows
    // in the app measured the same. Icon-only rails are deliberately tighter
    // and are named here rather than silently excluded.
    const iconRails = ["chat-header-actions", "v4-title-actions"];
    const cluster =
      /^[ \t]*\.([-\w]*(?:actions|action-row|btn-row|buttons|btns)[-\w]*)[^{\n]*\{([^}]*)\}/gm;
    const offenders: string[] = [];
    for (const src of shellSources()) {
      for (const [, name, body] of src.matchAll(cluster)) {
        if (iconRails.includes(name)) continue;
        if (!body.includes("display: flex")) continue;
        const gap = /gap:\s*([^;]+);/.exec(body)?.[1]?.trim();
        if (gap && !gap.startsWith("var(--control-gap")) {
          offenders.push(`${name}: ${gap}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
