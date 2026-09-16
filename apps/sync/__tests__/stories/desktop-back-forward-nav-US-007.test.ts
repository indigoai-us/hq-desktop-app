/**
 * US-007: Accept the full matrix in browser, native preview, and Windows keyboard.
 *
 * Named separately from the existing widget US-007.test.ts.
 */
// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNavigationController } from "../../../../packages/ui/src/shell/navigation-controller";
import {
  NAVIGATION_HANDLER_MATRIX,
  handlerUsesNavigateBoundary,
  inScopeUserHandler,
} from "../../../../packages/ui/src/shell/navigation-handler-matrix";
import { consumeNavigationShortcut } from "../../../../packages/ui/src/shell/navigation-shortcuts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("US-007: Accept the full matrix in browser, native preview, and Windows keyboard", () => {
  it("Given the acceptance matrix, when Chromium and WebKit desktop-alt suites run, then every in-scope row is covered and green", () => {
    const playwright = readRepo("apps/sync/playwright.config.ts");
    expect(playwright).toContain("testDir: './e2e/browser'");
    expect(playwright).toContain("name: 'chromium'");
    expect(playwright).toContain("name: 'webkit'");
    const shortcuts = readRepo("packages/ui/src/shell/navigation-shortcuts.ts");
    expect(shortcuts).toContain("An explicit non-Windows");
    expect(shortcuts).toContain('if (event.key === "ArrowLeft") return "back";');

    // session-navigation.spec.ts became shell-navigation.spec.ts when the
    // Sessions removal took the thing it navigated between. The matrix rows
    // that survive are the ones about navigation itself: the title-bar
    // controls, both platforms' chords, and the editor keeping the chord.
    const browserSpec = readRepo("apps/sync/e2e/browser/shell-navigation.spec.ts");
    expect(browserSpec).toContain("titlebar-back");
    expect(browserSpec).toContain("titlebar-forward");
    expect(browserSpec).toContain("titlebar-day-date");
    expect(browserSpec).toContain("titlebar-history");
    // The browser-level chord retrace needed two destinations to move between,
    // and the persona harness paints one conversation now that sessions are
    // gone. Both platforms' chords and the rule that an editor keeps them are
    // asserted at unit level instead; what no longer has end-to-end proof is
    // the shell wiring that module to real navigation.
    const shortcutSpec = readRepo(
      "packages/ui/src/shell/navigation-shortcuts.test.ts",
    );
    expect(shortcutSpec).toContain('key: "ArrowLeft", altKey: true');
    expect(shortcutSpec).toContain("does not steal from text editing");

    const loading = readRepo("apps/sync/e2e/browser/loading-readiness.spec.ts");
    expect(loading).toContain("sidebar-loading");

    const sources = new Map<string, string>();
    const read = (file: string) => {
      const cached = sources.get(file);
      if (cached) return cached;
      const next = readRepo(file);
      sources.set(file, next);
      return next;
    };
    const inScope = NAVIGATION_HANDLER_MATRIX.filter(inScopeUserHandler);
    expect(inScope.length).toBeGreaterThan(20);
    for (const row of inScope) {
      expect(
        handlerUsesNavigateBoundary(read(row.file), row.needle),
        `${row.id} is not covered by navigate()`,
      ).toBe(true);
    }
  });

  it("Given the final matrix review, when any in-scope handler still assigns view state directly, then the story fails", () => {
    const sources = new Map<string, string>();
    const read = (file: string) => {
      const cached = sources.get(file);
      if (cached) return cached;
      const next = readRepo(file);
      sources.set(file, next);
      return next;
    };
    const shell = read("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).not.toContain("onclick={() => (agentSurface = t.id)}");
    expect(shell).not.toContain("onselect={(id) => (companyTab = id)}");
    expect(shell).not.toContain("onclick={() => (tab = t.id)}");
    expect(shell).not.toContain('onOpenInChannel={() => (tab = "chat")}');
    expect(shell).not.toContain("onnavigatetab={(next) => (libraryTab = next)}");
    expect(shell).not.toContain("window.history.back()");
    expect(shell).not.toContain("history.back()");

    for (const row of NAVIGATION_HANDLER_MATRIX) {
      expect(read(row.file), `${row.id} needle missing`).toContain(row.needle);
      if (!inScopeUserHandler(row)) continue;
      expect(
        handlerUsesNavigateBoundary(read(row.file), row.needle),
        `${row.id} still bypasses navigate(): ${row.needle}`,
      ).toBe(true);
    }
  });
});
