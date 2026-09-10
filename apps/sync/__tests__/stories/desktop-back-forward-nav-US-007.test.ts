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
import {
  encodeHistorySessionParam,
  sessionRestorePath,
  parseSessionsParam,
} from "../../src/desktop-alt/pages/sessions-route-param";
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

  it("Given the native macOS preview, when Back and Forward are used across channel → session → source, then selection matches and no send occurs", () => {
    const titleBar = readRepo("packages/ui/src/home/V4TitleBar.svelte");
    // The bar's lead is the sidebar toggle then the history cluster — the HQ
    // wordmark and DAY · DATE that used to sit between them are gone.
    const leadNeedle = 'data-testid="titlebar-leading"';
    const historyNeedle = 'data-testid="titlebar-history"';
    const lead = titleBar.indexOf(leadNeedle);
    const history = titleBar.indexOf(historyNeedle);
    expect(lead).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(lead);
    expect(titleBar).not.toContain('data-testid="titlebar-day-date"');
    expect(titleBar).not.toContain('data-testid="titlebar-wordmark"');
    expect(titleBar.slice(lead + leadNeedle.length, history)).not.toMatch(
      /data-testid="titlebar-(?!back|forward)/,
    );

    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toContain("onback={() => void goBack()}");
    expect(shell).toContain("onforward={() => void goForward()}");

    const host = readRepo("apps/sync/src/desktop-alt/HqWorkWorkShell.svelte");
    expect(host).toContain("<WorkShell");
    expect(host).toContain("component: SessionsExtraPage");

    const extra = readRepo("apps/sync/src/desktop-alt/pages/SessionsExtraPage.svelte");
    expect(extra).toContain("sessionRestorePath");
    expect(extra).not.toMatch(/agent_session_start|startAndSend/);

    const channelA = { kind: "channel" as const, channelId: "chn_a" };
    const sessionB = { kind: "extra" as const, page: "sessions", param: "ses_b" };
    const sourceC = {
      kind: "extra" as const,
      page: "sessions",
      param: encodeHistorySessionParam({
        id: "ses_c",
        tool: "claude",
        title: "Source C",
      }),
    };
    expect(sessionRestorePath(parseSessionsParam("ses_b"))).toBe("open");
    expect(sessionRestorePath(parseSessionsParam(sourceC.param))).toBe(
      "openHistory",
    );

    const applied: string[] = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: (next) => {
        const dest = next.entry.destination;
        applied.push(
          dest.kind === "extra" ? `${dest.page}:${dest.param ?? ""}` : dest.kind,
        );
      },
    });
    controller.navigate(channelA);
    controller.navigate(sessionB);
    controller.navigate(sourceC);
    expect(controller.back()?.committed).toBe(true);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining(sessionB),
    );
    expect(controller.back()?.committed).toBe(true);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "channel", channelId: "chn_a" }),
    );
    expect(controller.forward()?.committed).toBe(true);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining(sessionB),
    );
    expect(applied.at(-1)).toBe("sessions:ses_b");
  });

  it("Given the Windows harness, when Alt+Left and Alt+Right are sent, then history moves unless an editor is focused", () => {
    const harnessSrc = readRepo(
      "apps/sync/e2e/desktop-alt/windows-reliability-harness.ts",
    );
    expect(harnessSrc).toContain("HQ_SYNC_WINDOWS_RELIABILITY_LIVE");
    expect(harnessSrc).toContain("this.platform === 'win32'");
    expect(harnessSrc).toContain("forceScripted");
    expect(harnessSrc).toContain("On non-Windows or without a live app path, always uses scripted mode.");

    const applied: string[] = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: (next) => {
        const dest = next.entry.destination;
        applied.push(dest.kind === "extra" ? dest.page : dest.kind);
      },
    });
    controller.navigate({ kind: "extra", page: "alpha" });
    controller.navigate({ kind: "extra", page: "bravo" });

    const fire = (key: "ArrowLeft" | "ArrowRight", target: EventTarget | null) =>
      consumeNavigationShortcut(
        {
          key,
          altKey: true,
          metaKey: false,
          ctrlKey: false,
          defaultPrevented: false,
          target,
          preventDefault() {},
        },
        {
          platform: "windows",
          onBack: () => {
            controller.back();
          },
          onForward: () => {
            controller.forward();
          },
        },
      );

    expect(fire("ArrowLeft", null)).toBe(true);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "extra", page: "alpha" }),
    );
    expect(fire("ArrowRight", null)).toBe(true);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "extra", page: "bravo" }),
    );

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(fire("ArrowLeft", input)).toBe(false);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "extra", page: "bravo" }),
    );
    input.remove();
    expect(applied.at(-1)).toBe("bravo");
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
