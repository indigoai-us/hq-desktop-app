// @vitest-environment happy-dom

/**
 * Company > Office uses the existing native panel and company navigation history.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import { dispatchEmbeddedNavigation } from "./embedded-navigation.js";
import { officeDoor } from "./lazy-doors.js";
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
  await officeDoor.load();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document.documentElement.removeAttribute("data-platform");
});


async function mountShell(companies: Workspace[], adapter = webAdapter()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      callsHost: { serviceEvidence: {}, openCallWindow: async () => {}, resolveDeviceId: async () => "dev_test" },
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

const companies = [
  { slug: "indigo", displayName: "Indigo", kind: "company", state: "synced", cloudUid: "cmp_indigo", role: "member", membershipStatus: "active" },
  { slug: "other", displayName: "Other", kind: "company", state: "synced", cloudUid: "cmp_other", role: "member", membershipStatus: "active" },
] as Workspace[];
function nativeAdapter(read = async () => true) {
  const adapter = webAdapter();
  const discoverOffice = vi.fn(async () => ok({ companyUid: "cmp_indigo", observedAt: Date.now(), people: [] }));
  return { adapter: { ...adapter, kind: "desktop", capabilities: { nativeCalls: true },
    identity: { ...adapter.identity, hasCompanyFeature: read },
    calls: { preflight: async () => ok({ passed: true }), discoverOffice,
      listKnocks: async () => ok({ knocks: [] }),
      setOfficeConnectivity: async () => ok({}), setOfficePreference: async () => ok({}),
    },
  } as unknown as PlatformAdapter, discoverOffice };
}
async function openCompany(uid: string) {
  dispatchEmbeddedNavigation({ kind: "extra", page: "company-page-team", companyUid: uid });
  await settle();
}
const office = () => host.querySelector<HTMLButtonElement>('[data-row-id="office"]');
describe("Company Office navigation", () => {
  it("opens the existing native roster directly and follows back/forward", async () => {
    const { adapter, discoverOffice } = nativeAdapter();
    await mountShell(companies, adapter);
    await openCompany("cmp_indigo");
    expect(office()).not.toBeNull();
    office()!.click();
    await settle();
    await vi.waitFor(() => expect(discoverOffice).toHaveBeenCalled());
    expect(office()?.getAttribute("aria-current")).toBe("page");
    expect(JSON.stringify(discoverOffice.mock.calls)).toContain("cmp_indigo");
    host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click();
    await settle();
    expect(office()?.getAttribute("aria-current")).not.toBe("page");
    host.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.click();
    await settle();
    expect(office()?.getAttribute("aria-current")).toBe("page");
    await openCompany("cmp_other");
    expect(office()).toBeNull();
  });
  it("ignores a late Indigo flag answer after company switching", async () => {
    let answer!: (value: boolean) => void;
    const { adapter, discoverOffice } = nativeAdapter(() => new Promise<boolean>(resolve => { answer = resolve; }));
    await mountShell(companies, adapter);
    await openCompany("cmp_indigo");
    expect(office()).toBeNull();
    await openCompany("cmp_other");
    answer(true);
    await settle();
    expect(office()).toBeNull();
    expect(discoverOffice).not.toHaveBeenCalled();
  });
  it.each(["browser", "flag-off", "other-company"])("denies navigation and roster reads for %s", async (reason) => {
    const { adapter, discoverOffice } = nativeAdapter(async () => reason !== "flag-off");
    if (reason === "browser") Object.assign(adapter, { kind: "web" });
    await mountShell(companies, adapter);
    dispatchEmbeddedNavigation({ kind: "extra", page: "company-page-office", companyUid: reason === "other-company" ? "cmp_other" : "cmp_indigo" });
    await settle();
    expect(office()).toBeNull();
    expect(discoverOffice).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Office is not available");
  });
});
