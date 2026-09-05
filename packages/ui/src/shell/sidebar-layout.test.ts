import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SIDEBAR_OVERLAY_MAX_PX, sidebarLayout } from "./sidebar-layout.js";

const chatSidebar = readFileSync(
  new URL("../chat/ChatSidebar.svelte", import.meta.url),
  "utf8",
);
const desktopApp = readFileSync(
  new URL("./DesktopApp.svelte", import.meta.url),
  "utf8",
);

describe("sidebarLayout", () => {
  it.each([
    [320, "overlay"],
    [390, "overlay"],
    [SIDEBAR_OVERLAY_MAX_PX, "overlay"],
    [SIDEBAR_OVERLAY_MAX_PX + 1, "column"],
    [1280, "column"],
  ])("resolves %ipx to %s", (width, expected) => {
    expect(sidebarLayout(width)).toBe(expected);
  });
});

describe("the breakpoint has one value, not two", () => {
  /**
   * The overlay itself has to be CSS — a component cannot lay itself out — but
   * the shell's "start closed" decision has to be TypeScript. That splits one
   * breakpoint across two languages, and the failure when they drift is silent
   * and narrow: between the two widths the list would either sit closed as a
   * useless column or open as a screen-covering overlay nobody asked for.
   */
  it("uses the constant's value in the sidebar's own media query", () => {
    expect(chatSidebar).toContain(
      `@media (max-width: ${SIDEBAR_OVERLAY_MAX_PX}px)`,
    );
  });

  it("positions the shell body so the overlay has something to anchor to", () => {
    // `position: absolute` without a positioned ancestor escapes to the
    // viewport and renders behind the title bar.
    const narrow = desktopApp.match(
      new RegExp(
        `@media \\(max-width: ${SIDEBAR_OVERLAY_MAX_PX}px\\) \\{[\\s\\S]*?\\n {2}\\}`,
      ),
    );
    expect(narrow?.[0], "DesktopApp has no narrow-viewport block").toBeDefined();
    expect(narrow?.[0]).toContain(".desktop-body");
    expect(narrow?.[0]).toContain("position: relative;");
  });

  it("drives the shell's collapsed default from the same module", () => {
    expect(desktopApp).toContain("SIDEBAR_OVERLAY_MAX_PX");
  });
});
