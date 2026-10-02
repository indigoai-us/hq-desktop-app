// @vitest-environment happy-dom

/**
 * console-rail US-007 — the company tile opens the company sidepane.
 */

import { afterEach, describe, expect, it } from "vitest";
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
  it("Indigo tile shows all 15 rows in the decided groups and Company settings in the footer", async () => {
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
    expect(labels).toEqual(["People", "Brain", "Files and connect"]);
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="sidepane-row"]')].map(
      (el) => el.getAttribute("data-row-id"),
    );
    expect(rows).toEqual([
      "atlas", "projects", "activity", "goals", "team", "bots",
      "knowledge", "policies", "skills", "workers",
      "vault", "integrations", "secrets", "deployments",
      // US-014: the tile lands on Atlas and this company has no teammates yet.
      "invite-teammate",
    ]);
    expect(
      host.querySelector('[data-testid="sidepane-footer"] [data-testid="company-sidepane-settings"]'),
    ).not.toBeNull();

    host.querySelector<HTMLButtonElement>('[data-row-id="workers"]')!.click();
    await settle();
    // US-028 Brain pages replaced the placeholder; the lazy door paints its
    // skeleton with the row title in the first frame.
    const skeleton = host.querySelector('[data-testid="brain-door-skeleton"]');
    expect(skeleton?.querySelector("h1")?.textContent).toBe("Workers");
    expect(host.querySelector('[data-row-id="workers"]')?.getAttribute("aria-current")).toBe("page");
    expect(
      host.querySelector('[data-testid="rail-company"]')?.getAttribute("aria-current"),
    ).toBe("page");

    host.querySelector<HTMLButtonElement>('[data-testid="rail-home"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="company-sidepane-header"]')).toBeNull();
  });
});
