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
import { meetingCanvasDoor, meetingsSidepaneDoor } from "./lazy-doors.js";
import { loadOutpost } from "./outpost-lazy.js";
import { loadPersonalRail } from "./personal-rail-lazy.js";
import { loadTelemetry } from "./telemetry-lazy.js";
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
    identity: {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: async () => ok(false),
      subscribeFeature: () => () => {},
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

/**
 * Rail clicks start lazy chunk loads that cannot be cancelled. A test waits
 * for the bodies it opened before teardown, so none resolves (and injects its
 * CSS) into a torn-down environment. Each test waits only for its own bodies:
 * the skeleton assertions in later tests need the other chunks still cold.
 */
async function lazyBodiesLoaded(...loads: Array<() => Promise<unknown>>): Promise<void> {
  await Promise.all(loads.map((load) => load()));
  await settle();
}

const meetingsBodies = [() => meetingsSidepaneDoor.load(), () => meetingCanvasDoor.load()];

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document.documentElement.removeAttribute("data-platform");
});


function localFilesAdapter(): PlatformAdapter {
  return {
    ...webAdapter(),
    files: {
      listDir: async () => ok([]),
      getFileContent: async () => ok(""),
      vault: {
        summary: async (root: string) =>
          ok({ root, notes: 0, files: 0, links: 0, truncated: false, hubs: [], folders: [] }),
        search: async () => ok([]),
        noteLinks: async () => ok({ resolved: [], backlinks: [], backlinkCount: 0, outgoing: [] }),
        readNote: async () => ok({ text: "", size: 0, truncated: false }),
      },
    },
  } as unknown as PlatformAdapter;
}

async function mountShell(adapter: PlatformAdapter = webAdapter()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
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
    for (const id of ["titlebar-meetings", "titlebar-console", "titlebar-reveal-folder", "titlebar-projects"]) {
      expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
    expect(host.querySelector('[data-testid="titlebar-sidebar-toggle"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="titlebar-notifications"]')).not.toBeNull();
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
    await lazyBodiesLoaded(...meetingsBodies);
  });

  it("opens the Outpost page through its lazy host instead of the placeholder", async () => {
    await mountShell();
    click("rail-outpost");
    await settle();
    // US-034 replaced the placeholder; US-039 points this test at the real host.
    expect(host.querySelector('[data-testid="outpost-rail-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-placeholder"]')).toBeNull();
    expect(current()).toBe("outpost");
    await lazyBodiesLoaded(loadOutpost);
  });

  it("opens personal secrets through the lazy host instead of the placeholder", async () => {
    await mountShell();
    click("rail-secrets");
    await settle();
    expect(host.querySelector('[data-testid="personal-rail-host"]')?.getAttribute("data-page")).toBe("secrets");
    expect(host.querySelector('[data-testid="personal-rail-skeleton"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-placeholder"]')).toBeNull();
    expect(current()).toBe("secrets");
    await lazyBodiesLoaded(loadPersonalRail);
  });

  it("opens Files as the explorer alone and personal deployments through a lazy host", async () => {
    await mountShell();
    click("rail-library");
    await settle();
    // Owner: "this view should just be the files explorer". No Library nav
    // column (My files / Shared / Recent / Starred / Companies / Local).
    expect(host.querySelector('[data-testid="rail-files-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="personal-library"]')).toBeNull();
    expect(host.querySelector('[data-testid="library-shared-tab"]')).toBeNull();
    // The web adapter has no local files, so it says where Files works.
    expect(host.querySelector('[data-testid="rail-files-unavailable"]')).not.toBeNull();
    expect(current()).toBe("library");
    click("rail-deployments");
    await settle();
    expect(host.querySelector('[data-testid="personal-deployments-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="personal-deployments-skeleton"]')).not.toBeNull();
    expect(current()).toBe("deployments");
    await lazyBodiesLoaded(() => import("../library/PersonalDeploymentsPage.svelte"));
  });

  it("paints the vault explorer for Files in the same frame when local files exist", async () => {
    await mountShell(localFilesAdapter());
    click("rail-library");
    await tick();
    const files = host.querySelector('[data-testid="rail-files-host"]');
    expect(files).not.toBeNull();
    expect(files!.querySelector('[data-testid="vault-explorer"]')).not.toBeNull();
    expect(files!.querySelector('[data-testid="vault-search"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="personal-library"]')).toBeNull();
    // The new shell chrome stays: the rail is still there and Files is current.
    expect(current()).toBe("library");
    await settle();
  });

  it("opens telemetry through the lazy host instead of the placeholder", async () => {
    // RELEASE-001: Telemetry is Indigo-only; the registry opens it here.
    const adapter = webAdapter();
    (adapter as unknown as { identity: unknown }).identity = {
      hasFeature: async (flag: string) => ok(flag === "desktop.rail-telemetry-v1"),
    };
    await mountShell(adapter);
    click("rail-telemetry");
    await settle();
    expect(host.querySelector('[data-testid="telemetry-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="telemetry-skeleton"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-placeholder"]')).toBeNull();
    expect(current()).toBe("telemetry");
    await lazyBodiesLoaded(loadTelemetry);
  });

  it("shows Coming soon for Telemetry outside Indigo, with no telemetry host or data load (RELEASE-001)", async () => {
    await mountShell();
    click("rail-telemetry");
    await settle();
    expect(current()).toBe("telemetry");
    expect(host.querySelector('[data-testid="telemetry-host"]')).toBeNull();
    expect(host.querySelector('[data-testid="telemetry-coming-soon"]')?.textContent).toContain(
      "Coming soon. Usage and session telemetry is on its way to your company.",
    );
  });

  it("shows one sidepane: personal pages and Meetings replace the Messages list", async () => {
    await mountShell();
    const chatSlot = () => host.querySelector<HTMLElement>(".chat-pane-slot");
    expect(chatSlot()?.style.display).toBe("contents");
    for (const id of ["rail-telemetry", "rail-secrets", "rail-connections", "rail-outpost"]) {
      click(id);
      await settle();
      expect(chatSlot()?.style.display, id).toBe("none");
    }
    click("rail-meetings");
    await settle();
    expect(chatSlot()?.style.display).toBe("none");
    // The Meetings sidepane lives in the shared Sidepane host, and the
    // classic agenda stays mounted under the canvas.
    const pane = host.querySelector('[aria-label="Meetings"]');
    expect(pane).not.toBeNull();
    expect(host.querySelector('[data-testid="meetings-dek"]')).not.toBeNull();
    click("rail-home");
    await settle();
    expect(chatSlot()?.style.display).toBe("contents");
    await lazyBodiesLoaded(loadTelemetry, loadPersonalRail, loadOutpost, ...meetingsBodies);
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
    await lazyBodiesLoaded(
      loadOutpost,
      ...meetingsBodies,
    );
  });
});
