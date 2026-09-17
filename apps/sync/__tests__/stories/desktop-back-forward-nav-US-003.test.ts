/**
 * US-003: Title-bar back/forward controls and keyboard shortcuts.
 *
 * Named separately from the existing widget US-003.test.ts.
 */
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("svelte", async () => {
  // @ts-expect-error client entry has no public type export.
  return await import("../../node_modules/svelte/src/index-client.js");
});

import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import V4TitleBar from "../../../../packages/ui/src/home/V4TitleBar.svelte";
import {
  createNavigationController,
  type NavigationDestination,
} from "../../../../packages/ui/src/shell/navigation-controller";
import { destinationLabel } from "../../../../packages/ui/src/shell/navigation-history";
import {
  consumeNavigationShortcut,
  resolveNavigationShortcut,
} from "../../../../packages/ui/src/shell/navigation-shortcuts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function dest(id: "a" | "b"): NavigationDestination {
  return { kind: "extra", page: id === "a" ? "alpha" : "bravo" };
}

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeAdapter() {
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true, localFiles: true },
    isAvailable: () => false,
    shell: {
      detectAiTools: vi.fn(async () =>
        ok({
          claude_desktop: false,
          claude_cli: false,
          codex_desktop: false,
          codex_cli: false,
          grok_cli: false,
        }),
      ),
    },
    files: {
      revealHqRoot: vi.fn(async () => ok(undefined)),
    },
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountBar(extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter: makeAdapter(),
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      ...extra,
    } as never,
  });
  await tick();
}

describe("US-003: Title-bar back/forward controls and keyboard shortcuts", () => {
  it("Given history A→B, when the user clicks Back then Forward, then selection returns to A then B and button disabled states match the stack", async () => {
    const applied: NavigationDestination[] = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      captureCurrent: () => ({
        destination: { kind: "messages" },
        accountId: "acct_ada",
        companyUid: "cmp_acme",
      }),
      apply: (next) => {
        applied.push(next.entry.destination);
      },
    });
    controller.navigate(dest("a"));
    controller.navigate(dest("b"));

    const refresh = async () => {
      if (component) await unmount(component);
      await mountBar({
        canGoBack: controller.history.canGoBack(),
        canGoForward: controller.history.canGoForward(),
        backLabel: destinationLabel(
          controller.history.snapshot().entries[
            controller.history.snapshot().index - 1
          ]?.destination ?? { kind: "messages" },
        ),
        forwardLabel: destinationLabel(
          controller.history.snapshot().entries[
            controller.history.snapshot().index + 1
          ]?.destination ?? { kind: "messages" },
        ),
        onback: () => void controller.back(),
        onforward: () => void controller.forward(),
      });
    };
    await refresh();

    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-back"]',
    );
    const forward = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-forward"]',
    );
    expect(back?.disabled).toBe(false);
    expect(forward?.disabled).toBe(true);

    back?.click();
    await tick();
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ page: "alpha" }),
    );
    await refresh();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="titlebar-back"]')
        ?.disabled,
    ).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="titlebar-forward"]')
        ?.disabled,
    ).toBe(false);

    host.querySelector<HTMLButtonElement>('[data-testid="titlebar-forward"]')
      ?.click();
    await tick();
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ page: "bravo" }),
    );
    await refresh();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="titlebar-forward"]')
        ?.disabled,
    ).toBe(true);
    expect(applied.at(-1)).toEqual(expect.objectContaining({ page: "bravo" }));
  });

  it("Given a focused text input, when Cmd+[ or Alt+Left is pressed, then the editor keeps the event and history does not move", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const moved: string[] = [];
    const mac = {
      key: "[",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: input,
      preventDefault: () => {
        throw new Error("must not steal from the editor");
      },
    };
    expect(resolveNavigationShortcut(mac, "macos")).toBeNull();
    expect(
      consumeNavigationShortcut(mac, {
        platform: "macos",
        onBack: () => moved.push("back"),
        onForward: () => moved.push("forward"),
      }),
    ).toBe(false);

    const win = {
      key: "ArrowLeft",
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      defaultPrevented: false,
      target: input,
      preventDefault: () => {
        throw new Error("must not steal from the editor");
      },
    };
    expect(resolveNavigationShortcut(win, "windows")).toBeNull();
    expect(
      consumeNavigationShortcut(win, {
        platform: "windows",
        onBack: () => moved.push("back"),
        onForward: () => moved.push("forward"),
      }),
    ).toBe(false);
    expect(moved).toEqual([]);
    input.remove();
  });

  it("Given an empty stack, when Back and Forward are inspected, then both are disabled and still have accessible names", async () => {
    await mountBar({ canGoBack: false, canGoForward: false });
    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-back"]',
    );
    const forward = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-forward"]',
    );
    expect(back?.disabled).toBe(true);
    expect(forward?.disabled).toBe(true);
    expect(back?.getAttribute("aria-label")).toBe("Back");
    expect(forward?.getAttribute("aria-label")).toBe("Forward");
  });

  it("Given minimum window width, when the title bar is shown, then both buttons are visible and not in the drag region", async () => {
    await mountBar();
    host.style.width = "960px";
    const cluster = host.querySelector<HTMLElement>(
      '[data-testid="titlebar-history"]',
    );
    expect(cluster).toBeTruthy();
    expect(host.querySelector('[data-testid="titlebar-back"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="titlebar-forward"]')).toBeTruthy();
    expect(cluster?.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(cluster?.hasAttribute("data-no-drag")).toBe(true);
    expect(cluster?.classList.contains("v4-history")).toBe(true);
    expect(readRepo("packages/ui/src/home/V4TitleBar.svelte")).toMatch(
      /\.v4-history\s*\{[\s\S]*?flex-shrink:\s*0/,
    );
    expect(readRepo("packages/ui/src/shell/DesktopApp.svelte")).not.toContain(
      "window.history",
    );
  });
});
