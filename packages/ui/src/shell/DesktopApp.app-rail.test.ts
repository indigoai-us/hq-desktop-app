// @vitest-environment happy-dom

/**
 * console-rail US-003 — AppRail order, routing, history, and shortcuts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
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
    meetings: {
      listAccounts: async () => ok([]),
      permissionsState: async () => ok(null),
    },
    appShell: {
      notificationPermissionState: async () => ok("default"),
    },
    settings: {
      getSettings: async () => ok({}),
    },
    library: {
      getRoot: async () => ok({ workers: [], skills: [] }),
      getCompany: async () => ok({ workers: [], skills: [] }),
      getWorkerDetail: async () => ok({}),
      getSkillDetail: async () => ok({}),
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
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function settle(): Promise<void> {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function railIds(): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="app-rail"] [data-rail-id]')].map(
    (el) => el.getAttribute("data-rail-id") ?? "",
  );
}

function current(): string | null {
  return (
    host
      .querySelector('[data-testid="app-rail"] [aria-current="page"]')
      ?.getAttribute("data-rail-id") ?? null
  );
}

function click(testId: string): void {
  host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
}

describe("DesktopApp app rail (console-rail US-003)", () => {
  it("shows the rail in the decided order and no folder, console, or meetings titlebar icon", async () => {
    await mountShell();
    expect(railIds()).toEqual([
      "home",
      "meetings",
      "more-companies",
      "library",
      "deployments",
      "telemetry",
      "secrets",
      "connections",
      "outpost",
      "you",
    ]);
    const spacer = host.querySelector('[data-testid="rail-spacer"]');
    const you = host.querySelector('[data-testid="rail-you"]');
    expect(spacer!.compareDocumentPosition(you!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const id of ["titlebar-meetings", "titlebar-console", "titlebar-reveal-folder"]) {
      expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
    for (const el of host.querySelectorAll<HTMLButtonElement>('[data-testid="app-rail"] button')) {
      expect(el.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("Meetings, then Home, then back shows Meetings", async () => {
    await mountShell();
    click("rail-meetings");
    await settle();
    expect(current()).toBe("meetings");
    expect(host.querySelector('[data-testid="meetings-dek"]')).not.toBeNull();
    click("rail-home");
    await settle();
    expect(current()).toBe("home");
    expect(host.querySelector('[data-testid="meetings-dek"]')).toBeNull();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "[", code: "BracketLeft", metaKey: true, bubbles: true }),
    );
    await settle();
    expect(current()).toBe("meetings");
    expect(host.querySelector('[data-testid="meetings-dek"]')).not.toBeNull();
  });

  it("opens a placeholder that names the story for personal pages not built yet", async () => {
    await mountShell();
    click("rail-secrets");
    await settle();
    const placeholder = host.querySelector('[data-testid="rail-placeholder"]');
    expect(placeholder?.getAttribute("data-story")).toBe("US-033");
    expect(placeholder?.textContent).toContain("Built in US-033");
    expect(current()).toBe("secrets");
  });

  it("opens telemetry through the lazy host instead of the placeholder", async () => {
    await mountShell();
    click("rail-telemetry");
    await settle();
    expect(host.querySelector('[data-testid="telemetry-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="telemetry-skeleton"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-placeholder"]')).toBeNull();
    expect(current()).toBe("telemetry");
  });

  it("maps Cmd+1 to Cmd+9 to rail items in order", async () => {
    await mountShell();
    const press = async (key: string) => {
      // The registry resolves Mod to Cmd on macOS and Ctrl elsewhere.
      const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: `Digit${key}`,
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
        }),
      );
      await settle();
    };
    await press("2");
    expect(current()).toBe("meetings");
    await press("4");
    expect(current()).toBe("library");
    await press("9");
    expect(current()).toBe("outpost");
    await press("1");
    expect(current()).toBe("home");
  });
});
