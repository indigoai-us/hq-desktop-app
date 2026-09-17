/**
 * US-002: Route all semantic navigation through one commit boundary.
 *
 * Named separately from the existing widget US-002.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  destinationFromEmbeddedTarget,
  type NavigationDestination,
} from "../../../../packages/ui/src/shell/navigation-history";
import {
  createNavigationController,
  type NavigationResolveOutcome,
} from "../../../../packages/ui/src/shell/navigation-controller";
import {
  createEmbeddedNavigationController,
  navigationDestinationFromRoute,
} from "../../src/desktop-alt/hq-work-host";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} missing`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const next = rest.search(/\n  (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("US-002: Route all semantic navigation through one commit boundary", () => {
  it("Given handlers for channel, extra page, settings, and native deep link, when each fires, then they call navigate() and do not assign view state independently", () => {
    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toMatch(/function navigate\(\s*destination/);
    expect(shell).toMatch(/function resolveDestination\(/);
    expect(shell).toMatch(/function commitDestination\(/);
    expect(shell).not.toMatch(/window\.history/);

    for (const name of [
      "handleSelect",
      "openExtraPage",
      "openSettings",
      "applyEmbeddedNavigation",
    ]) {
      const body = functionSource(shell, name);
      expect(body, `${name} must call navigate()`).toContain("void navigate(");
      expect(body, `${name} must not assign view independently`).not.toMatch(
        /\bview\s*=/,
      );
    }

    expect(destinationFromEmbeddedTarget({ kind: "home" })).toEqual({
      kind: "messages",
    });
    expect(navigationDestinationFromRoute("inbox")).toEqual({
      kind: "notifications",
    });
    expect(navigationDestinationFromRoute("sessions:abc")).toEqual({
      kind: "extra",
      page: "sessions",
      param: "abc",
    });
    expect(navigationDestinationFromRoute("hq-desktop://setup?company=cmp_x")).toEqual(
      {
        kind: "setup-checkout",
        companyUid: "cmp_x",
        checkout: "",
      },
    );
  });

  it("Given B is still resolving when C commits, when B completes, then the visible destination stays C", async () => {
    const delayedB = deferred<NavigationResolveOutcome>();
    const applied: NavigationDestination[] = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      resolve: (destination) => {
        if (destination.kind === "channel" && destination.channelId === "chn_b") {
          return delayedB.promise;
        }
        return { status: "ready", destination };
      },
      apply: (next) => {
        applied.push(next.entry.destination);
      },
    });
    controller.navigate({ kind: "channel", channelId: "chn_a" });
    const bNav = controller.navigate({ kind: "channel", channelId: "chn_b" });
    controller.navigate({ kind: "channel", channelId: "chn_c" });
    delayedB.resolve({
      status: "ready",
      destination: { kind: "channel", channelId: "chn_b" },
    });
    expect(await bNav).toMatchObject({ status: "cancelled", committed: false });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_c" }),
    );
    expect(applied.at(-1)).toEqual(
      expect.objectContaining({ channelId: "chn_c" }),
    );
  });

  it("Given a missing session id, when resolve fails transiently, then the cursor does not move; when it is confirmed gone, then an unavailable view commits and Back still works", () => {
    let lookup: NavigationResolveOutcome = {
      status: "transient-failure",
      error: "timeout",
    };
    const applied: Array<{
      kind: string;
      availability: string;
    }> = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      resolve: (destination) => {
        if (destination.kind === "extra") return lookup;
        return { status: "ready", destination };
      },
      apply: (next) => {
        applied.push({
          kind: next.entry.destination.kind,
          availability: next.availability,
        });
      },
    });
    controller.navigate({ kind: "channel", channelId: "chn_home" });
    const before = controller.lastCommitted();
    const transient = controller.navigate({
      kind: "extra",
      page: "sessions",
      param: "ses_missing",
    });
    expect(transient).toMatchObject({
      status: "transient-failure",
      committed: false,
    });
    expect(controller.lastCommitted()).toEqual(before);

    lookup = {
      status: "unavailable",
      destination: {
        kind: "extra",
        page: "sessions",
        param: "ses_missing",
      },
      reason: "Session was deleted",
    };
    const gone = controller.navigate({
      kind: "extra",
      page: "sessions",
      param: "ses_missing",
    });
    expect(gone).toMatchObject({ status: "unavailable", committed: true });
    expect(applied.at(-1)).toEqual({
      kind: "extra",
      availability: "unavailable",
    });
    expect(controller.history.canGoBack()).toBe(true);
    const back = controller.back();
    expect(back).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_home" }),
    );
  });

  it("Given a cold native route before mount, when the shell mounts, then that route enters the stack exactly once", () => {
    const bridge = createEmbeddedNavigationController();
    const delivered: NavigationDestination[] = [];
    bridge.navigate({ kind: "settings", section: "appearance" });
    const detach = bridge.attach((target) => {
      const next = destinationFromEmbeddedTarget(target);
      if (next) delivered.push(next);
    });
    expect(delivered).toEqual([{ kind: "settings", section: "appearance" }]);
    detach();
    bridge.navigate({ kind: "atlas" });
    expect(delivered).toHaveLength(1);
  });
});
