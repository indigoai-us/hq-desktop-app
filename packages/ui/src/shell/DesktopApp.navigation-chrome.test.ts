// @vitest-environment happy-dom

/**
 * US-003 — title-bar Back/Forward + keyboard, through the shared resolver.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { dispatchEmbeddedNavigation } from "./embedded-navigation.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
    },
  } as unknown as PlatformAdapter;
}

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document.documentElement.removeAttribute("data-platform");
});

const pages = {
  alpha: {
    label: "Alpha",
    detail: "Page A",
    component: ExtraPageProbe,
  },
  bravo: {
    label: "Bravo",
    detail: "Page B",
    component: ExtraPageProbe,
  },
};

async function mountShell(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
      extraPages: pages,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function goTo(page: "alpha" | "bravo"): Promise<void> {
  dispatchEmbeddedNavigation({ kind: "extra", page });
  await tick();
  await tick();
}

function extraPage(): string | null {
  return (
    host
      .querySelector('[data-testid="extra-page-host"]')
      ?.getAttribute("data-page") ?? null
  );
}

describe("DesktopApp title-bar back/forward", () => {
  it("Given history A→B, when the user clicks Back then Forward, then selection returns to A then B and button disabled states match the stack", async () => {
    await mountShell();
    await goTo("alpha");
    await goTo("bravo");
    expect(extraPage()).toBe("bravo");

    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-back"]',
    );
    const forward = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-forward"]',
    );
    expect(back?.disabled).toBe(false);
    expect(forward?.disabled).toBe(true);
    expect(back?.getAttribute("title")).toBe("Alpha");

    back?.click();
    await tick();
    await tick();
    expect(extraPage()).toBe("alpha");
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="titlebar-back"]')
        ?.disabled,
    ).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="titlebar-forward"]')
        ?.disabled,
    ).toBe(false);
    expect(
      host
        .querySelector('[data-testid="titlebar-forward"]')
        ?.getAttribute("title"),
    ).toBe("Bravo");

    host.querySelector<HTMLButtonElement>('[data-testid="titlebar-forward"]')
      ?.click();
    await tick();
    await tick();
    expect(extraPage()).toBe("bravo");
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="titlebar-forward"]')
        ?.disabled,
    ).toBe(true);
  });

  it("Given a focused text input, when Cmd+[ or Alt+Left is pressed, then the editor keeps the event and history does not move", async () => {
    await mountShell();
    await goTo("alpha");
    await goTo("bravo");
    expect(extraPage()).toBe("bravo");

    const input = document.createElement("input");
    host.appendChild(input);
    input.focus();
    const cmd = new KeyboardEvent("keydown", {
      key: "[",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(cmd);
    await tick();
    expect(cmd.defaultPrevented).toBe(false);
    expect(extraPage()).toBe("bravo");

    document.documentElement.setAttribute("data-platform", "windows");
    const alt = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(alt);
    await tick();
    expect(alt.defaultPrevented).toBe(false);
    expect(extraPage()).toBe("bravo");
  });

  it("moves history with Cmd+[ / Cmd+] on macOS when focus is not in an editor", async () => {
    await mountShell();
    document.documentElement.setAttribute("data-platform", "macos");
    await goTo("alpha");
    await goTo("bravo");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "[",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    await tick();
    expect(extraPage()).toBe("alpha");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    await tick();
    expect(extraPage()).toBe("bravo");
  });

  it("moves history with Alt+Left / Alt+Right on Windows when focus is not in an editor", async () => {
    await mountShell();
    document.documentElement.setAttribute("data-platform", "windows");
    await goTo("alpha");
    await goTo("bravo");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    await tick();
    expect(extraPage()).toBe("alpha");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    await tick();
    expect(extraPage()).toBe("bravo");
  });

  it("Given an empty stack, when Back and Forward are inspected, then both are disabled and still have accessible names", async () => {
    await mountShell();
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
    await mountShell();
    host.style.width = "960px";
    const cluster = host.querySelector<HTMLElement>(
      '[data-testid="titlebar-history"]',
    );
    const back = host.querySelector('[data-testid="titlebar-back"]');
    const forward = host.querySelector('[data-testid="titlebar-forward"]');
    expect(cluster).toBeTruthy();
    expect(back).toBeTruthy();
    expect(forward).toBeTruthy();
    expect(cluster?.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(cluster?.hasAttribute("data-no-drag")).toBe(true);
    expect(getComputedStyle(cluster!).flexShrink).toBe("0");
  });

  it("does not treat Escape as back — menus still own Escape", async () => {
    await mountShell();
    await goTo("alpha");
    await goTo("bravo");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(extraPage()).toBe("bravo");
  });
});
