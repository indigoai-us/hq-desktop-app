// @vitest-environment happy-dom

/**
 * console-rail US-007 — the company tile opens the company sidepane.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type { Workspace } from "../chat/workspaces.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok({ messages: [] }),
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

// ActivityRailHost loads ActivityView with a lazy import. Under full-suite
// load that import could resolve after this file's environment was torn
// down (EnvironmentTeardownError). Load the module up front so the lazy
// import resolves from the module cache while the test is still running.
beforeAll(async () => {
  await import("../activity/ActivityView.svelte");
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document.documentElement.removeAttribute("data-platform");
});


async function mountShell(companies?: Workspace[]): Promise<void> {
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
      ...(companies ? { companies } : {}),
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

describe("DesktopApp company sidepane (console-rail US-007)", () => {
  // OWNER-R24: Groups under People, a Settings group last, no footer link.
  it("Indigo tile shows every row in the decided groups with Settings last and no footer", async () => {
    await mountShell([
      {
        slug: "indigo",
        displayName: "Indigo",
        kind: "company",
        state: "synced",
        cloudUid: "cmp_indigo",
        role: "member",
        membershipStatus: "active",
      } as Workspace,
    ]);
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="rail-company"]')!.click();
    await settle();
    const pane = host.querySelector('[data-testid="company-sidepane-header"]');
    expect(pane?.textContent).toContain("Indigo");
    const labels = [...host.querySelectorAll('[data-testid="sidepane-section-label"]')].map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual(["People", "Brain", "Files and connect", "Settings"]);
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="sidepane-row"]')].map(
      (el) => el.getAttribute("data-row-id"),
    );
    expect(rows).toEqual([
      "atlas", "projects", "activity", "team", "bots", "groups",
      "knowledge", "policies", "skills", "workers",
      "vault", "integrations", "secrets", "deployments",
      // Grants and Billing are hidden: the member role is not owner or admin.
      "general", "brand",
      // US-014: the tile lands on Atlas and this company has no teammates yet.
      "invite-teammate",
    ]);
    expect(host.querySelector('[data-testid="company-sidepane-settings"]')).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-row-id="workers"]')!.click();
    await settle();
    // US-028 Brain pages replaced the placeholder; the lazy door paints its
    // loading frame (row title plus the shared loader) in the first frame.
    const loading = host.querySelector('[data-testid="brain-door-loading"]')?.closest(".rail-placeholder");
    expect(loading?.querySelector("h1")?.textContent).toBe("Workers");
    expect(host.querySelector('[data-row-id="workers"]')?.getAttribute("aria-current")).toBe("page");
    expect(
      host.querySelector('[data-testid="rail-company"]')?.getAttribute("aria-current"),
    ).toBe("page");

    host.querySelector<HTMLButtonElement>('[data-testid="rail-home"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="company-sidepane-header"]')).toBeNull();
  });

  it("Projects row opens the project board, not a placeholder (US-039)", async () => {
    await mountShell([
      {
        slug: "indigo",
        displayName: "Indigo",
        kind: "company",
        state: "synced",
        cloudUid: "cmp_indigo",
        role: "member",
        membershipStatus: "active",
      } as Workspace,
    ]);
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="rail-company"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-row-id="projects"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="projects-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-placeholder"]')).toBeNull();
    expect(host.querySelector('[data-row-id="projects"]')?.getAttribute("aria-current")).toBe("page");
  });

  const unicom = {
    slug: "unicom",
    displayName: "unicom",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_unicom",
    role: "member",
    membershipStatus: "active",
  } as Workspace;

  async function runCommand(id: string): Promise<void> {
    const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true }),
    );
    await tick();
    host.querySelector<HTMLButtonElement>(`#${id}`)!.click();
    await settle();
  }

  function meetingsPaneShown(): boolean {
    return (
      host.querySelector('[data-testid="meetings-sidepane-door-loading"]') != null ||
      host.querySelector('[data-sidepane-key="meetings"], [aria-label="Meetings"]') != null
    );
  }

  it("QA-047: the palette Meetings command swaps the company sections for the Meetings pane", async () => {
    await mountShell([unicom]);
    await settle();
    click("rail-company");
    await settle();
    host.querySelector<HTMLButtonElement>('[data-row-id="team"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="company-sidepane-header"]')).not.toBeNull();

    await runCommand("command-go-meetings");

    expect(host.querySelector('[data-testid="company-sidepane-header"]')).toBeNull();
    expect(meetingsPaneShown()).toBe(true);
    expect(current()).toBe("meetings");
  });

  it("QA-045: Bots, then Settings, then Back restores Bots with the company pane", async () => {
    await mountShell([unicom]);
    await settle();
    click("rail-company");
    await settle();
    host.querySelector<HTMLButtonElement>('[data-row-id="bots"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="bots-page"]')).not.toBeNull();

    await runCommand("command-go-settings");
    expect(host.querySelector('[data-testid="company-sidepane-header"]')).toBeNull();

    click("titlebar-back");
    await settle();

    expect(host.querySelector('[data-testid="company-sidepane-header"]')?.textContent).toContain(
      "unicom",
    );
    expect(host.querySelector('[data-row-id="bots"]')?.getAttribute("aria-current")).toBe("page");
    expect(current()).toBe("company");
    // The canvas is the Bots page, not a conversation.
    expect(host.querySelector('[data-testid="bots-page"]')).not.toBeNull();
  });

  it("QA-045: Back from Home to Bots restores the company pane and tenant with the Bots canvas", async () => {
    await mountShell([unicom]);
    await settle();
    click("rail-company");
    await settle();
    host.querySelector<HTMLButtonElement>('[data-row-id="bots"]')!.click();
    await settle();
    click("rail-home");
    await settle();
    expect(host.querySelector('[data-testid="company-sidepane-header"]')).toBeNull();

    click("titlebar-back");
    await settle();

    expect(host.querySelector('[data-testid="company-sidepane-header"]')?.textContent).toContain(
      "unicom",
    );
    expect(host.querySelector('[data-row-id="bots"]')?.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector('[data-testid="bots-page"]')).not.toBeNull();
    expect(current()).toBe("company");
  });
});
