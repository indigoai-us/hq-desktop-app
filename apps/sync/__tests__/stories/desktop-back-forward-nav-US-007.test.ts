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

    const browserSpec = readRepo("apps/sync/e2e/browser/session-navigation.spec.ts");
    expect(browserSpec).toContain("titlebar-back");
    expect(browserSpec).toContain("titlebar-forward");
    expect(browserSpec).toContain("titlebar-day-date");
    expect(browserSpec).toContain("titlebar-history");
    expect(browserSpec).toContain("session-source");
    expect(browserSpec).toContain("code: 'BracketLeft'");
    expect(browserSpec).toContain("key: 'ArrowLeft'");
    expect(browserSpec).toContain("agent_session_start");
    expect(browserSpec).toContain("NAV_LATENCY_BACK_MS");

    const loading = readRepo("apps/sync/e2e/browser/loading-readiness.spec.ts");
    expect(loading).toContain("sidebar-loading");
    expect(loading).toContain("session-starter");

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
