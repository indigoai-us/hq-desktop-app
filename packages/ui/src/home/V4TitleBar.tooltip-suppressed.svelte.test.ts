// @vitest-environment happy-dom

/**
 * The Launch and Core pills open menus right under themselves. Their hover /
 * focus tooltips must step aside while the menu is open, or the bubble sits
 * on top of the first row of the menu it just opened. So must every OTHER
 * titlebar button's tooltip (the console-rail beta has no Projects button in
 * the titlebar, so Notifications stands in as the Launch menu's neighbour).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import V4TitleBar from "./V4TitleBar.svelte";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeAdapter() {
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true, localFiles: true },
    // Core is only shown when the host can sync / update / manage packs.
    isAvailable: (cap: string) => cap === "canSync",
    shell: {
      detectAiTools: vi.fn(async () => ok({})),
    },
    files: {
      revealInFinder: vi.fn(async () => ok(undefined)),
      revealHqRoot: vi.fn(async () => ok(undefined)),
    },
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
    packages: {
      listPackagesCached: vi.fn(async () => ok([])),
      listPackages: vi.fn(async () => ok([])),
    },
    identity: {
      hasFeature: vi.fn(async () => ok(false)),
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

async function mountTitleBar(extraProps: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter: makeAdapter(),
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      ...extraProps,
    } as never,
  });
  await tick();
}

function tooltipIn(wrapSelector: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    `${wrapSelector} [data-testid="tooltip-bubble"]`,
  );
}

function tooltipFor(button: HTMLButtonElement): HTMLElement | null {
  return (
    button.parentElement?.querySelector<HTMLElement>(
      '[data-testid="tooltip-bubble"]',
    ) ?? null
  );
}

/** Hover dwells 400ms before the bubble shows. */
async function hoverPill(button: HTMLButtonElement): Promise<void> {
  button.parentElement!.dispatchEvent(
    new PointerEvent("pointerenter", { bubbles: false }),
  );
  vi.advanceTimersByTime(500);
  flushSync();
  await tick();
}

async function focusPill(button: HTMLButtonElement): Promise<void> {
  button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  flushSync();
  await tick();
}

describe("V4TitleBar menu-trigger tooltips", () => {
  it("hides the Launch tooltip while the Launch menu is open", async () => {
    await mountTitleBar();
    const pill = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-launch"]',
    )!;

    await focusPill(pill);
    expect(tooltipIn(".v4-launch-wrap")?.textContent?.trim()).toBe(
      "Open your HQ folder in an AI tool",
    );

    pill.click();
    flushSync();
    await tick();
    expect(
      host.querySelector('[data-testid="titlebar-launch-menu"]'),
    ).toBeTruthy();
    expect(tooltipIn(".v4-launch-wrap")).toBeNull();
    expect(pill.getAttribute("aria-describedby")).toBeNull();
  });

  it("hides the Core tooltip while the Core popover is open", async () => {
    await mountTitleBar();
    const pill = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-core-pill"]',
    )!;
    expect(pill).toBeTruthy();

    await focusPill(pill);
    expect(tooltipIn(".v4-core-wrap")?.textContent?.trim()).toBe(
      "HQ Core: sync, packs, and updates",
    );

    pill.click();
    flushSync();
    await tick();
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(tooltipIn(".v4-core-wrap")).toBeNull();
    expect(pill.getAttribute("aria-describedby")).toBeNull();
  });

  describe("neighbouring titlebar buttons while a menu is open", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps a neighbour's tooltip off the open Launch menu", async () => {
      vi.useFakeTimers();
      await mountTitleBar();
      const neighbour = host.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-notifications"]',
      )!;
      expect(neighbour).toBeTruthy();

      // Baseline: hovering the button with no menu open shows its tooltip.
      await hoverPill(neighbour);
      expect(tooltipFor(neighbour)?.textContent?.trim()).toBe("Notifications");
      neighbour.parentElement!.dispatchEvent(
        new PointerEvent("pointerleave", { bubbles: false }),
      );
      flushSync();
      await tick();
      expect(tooltipFor(neighbour)).toBeNull();

      host
        .querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')!
        .click();
      flushSync();
      await tick();
      expect(
        host.querySelector('[data-testid="titlebar-launch-menu"]'),
      ).toBeTruthy();

      await hoverPill(neighbour);
      expect(tooltipFor(neighbour)).toBeNull();
      await focusPill(neighbour);
      expect(tooltipFor(neighbour)).toBeNull();
      expect(neighbour.getAttribute("aria-describedby")).toBeNull();
      // The menu is still the thing on screen.
      expect(
        host.querySelector('[data-testid="titlebar-launch-menu"]'),
      ).toBeTruthy();
    });

    it("keeps the Notifications tooltip off the open Core popover", async () => {
      vi.useFakeTimers();
      await mountTitleBar();
      const notifications = host.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-notifications"]',
      )!;

      await focusPill(notifications);
      expect(tooltipFor(notifications)?.textContent?.trim()).toBe(
        "Notifications",
      );
      notifications.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      flushSync();
      await tick();

      const core = host.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-core-pill"]',
      )!;
      core.click();
      flushSync();
      await tick();
      expect(core.getAttribute("aria-expanded")).toBe("true");

      await hoverPill(notifications);
      expect(tooltipFor(notifications)).toBeNull();
      await focusPill(notifications);
      expect(tooltipFor(notifications)).toBeNull();
      expect(notifications.getAttribute("aria-describedby")).toBeNull();
    });

    it("hides a neighbour's already-showing tooltip when a menu opens, and lets it back after close", async () => {
      vi.useFakeTimers();
      await mountTitleBar();
      const neighbour = host.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-notifications"]',
      )!;
      await hoverPill(neighbour);
      expect(tooltipFor(neighbour)).toBeTruthy();

      const launch = host.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-launch"]',
      )!;
      launch.click();
      flushSync();
      await tick();
      expect(tooltipFor(neighbour)).toBeNull();

      launch.click();
      flushSync();
      await tick();
      expect(
        host.querySelector('[data-testid="titlebar-launch-menu"]'),
      ).toBeNull();
      await hoverPill(neighbour);
      expect(tooltipFor(neighbour)?.textContent?.trim()).toBe("Notifications");
    });
  });
});
