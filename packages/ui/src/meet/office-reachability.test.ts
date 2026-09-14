// @vitest-environment happy-dom

/**
 * US-018 REACHABILITY — can a signed-in user actually get to the Office?
 *
 * The office view can be perfect and still be unreachable if nothing in the
 * shell that actually ships renders it. That was the review finding this file
 * exists to prevent from recurring, so it pins the whole chain:
 *
 *   1. the company tab list a host renders is capability-gated (Office appears
 *      only when the adapter reports `nativeCalls`, and defaults to hidden);
 *   2. `CompanyPage` — the shared company surface — renders the Office panel
 *      for `tab: "office"` and NOT a blank when the host cannot call;
 *   3. the shipping shell (`DesktopApp.svelte`) mounts the SAME one panel and
 *      never asks the company-tab endpoint for Office rows;
 *   4. `@hq/ui` reaches for no native import of its own.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { ok, type AdapterResult, type Json } from "@hq/platform";

import CompanyPage from "../company/CompanyPage.svelte";
import {
  COMPANY_CHANNEL_TABS,
  COMPANY_OFFICE_TAB,
  companyChannelTabsFor,
  isCompanyChannelTabId,
  isCompanyTabSurfaceId,
} from "../chat/tabs/tab-model.js";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

const COMPANY = {
  slug: "indigo",
  displayName: "Indigo",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_indigo",
  bucketName: "bucket",
  hasLocalFolder: true,
  localPath: "/tmp/HQ/companies/indigo",
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

/**
 * The narrow slice of PlatformAdapter CompanyPage + OfficePanel touch. Built by
 * hand rather than with a real adapter so the test states exactly which seams
 * reachability depends on.
 */
function fakeAdapter(options: {
  nativeCalls: boolean;
  roster?: () => Promise<AdapterResult<Json>>;
  preflight?: () => Promise<AdapterResult<unknown>>;
  personUid?: string | null;
}) {
  const noop = async () => ok({} as Json);
  return {
    kind: options.nativeCalls ? "desktop" : "web",
    capabilities: { nativeCalls: options.nativeCalls },
    isAvailable: (name: string) =>
      name === "nativeCalls" ? options.nativeCalls : false,
    calls: {
      preflight:
        options.preflight ?? (async () => ok({ passed: true } as never)),
      discoverOffice: options.roster ?? (async () => ok({} as Json)),
      setOfficePreference: noop,
      setOfficeConnectivity: noop,
      createRoom: noop,
    },
    identity: {
      whoami: async () =>
        ok({ personUid: options.personUid ?? "prs_self" } as never),
      getProfile: undefined,
    },
    // CompanyPage wires these on mount; empty answers keep it quiet.
    company: {
      listCompanies: async () => ok([] as never),
      getCompany: async () => ok({} as never),
    },
    settings: { getSettings: async () => ok({} as never) },
    library: {},
    shell: {},
    sync: {},
    messaging: {},
    files: {},
  } as never;
}

const ROSTER = ok({
  companyUid: "cmp_indigo",
  observedAt: 1_000,
  people: [
    { personUid: "prs_self", connectivity: "online", willingness: "knock" },
    { personUid: "prs_mate", connectivity: "online", willingness: "open" },
  ],
} as Json);

describe("US-018 reachability: the company tab list is the door", () => {
  it("advertises Office only when the host reports native calling", () => {
    const closed = companyChannelTabsFor({ nativeCalls: false }).map((t) => t.id);
    expect(closed).not.toContain("office");
    // Default is closed: forgetting to pass capabilities cannot open a door.
    expect(companyChannelTabsFor().map((t) => t.id)).not.toContain("office");
    // The gate is surgical — the ungated four are untouched.
    expect(closed).toEqual(COMPANY_CHANNEL_TABS.map((t) => t.id));

    const open = companyChannelTabsFor({ nativeCalls: true });
    expect(open.map((t) => t.id)).toEqual([
      ...COMPANY_CHANNEL_TABS.map((t) => t.id),
      "office",
    ]);
    expect(open.at(-1)).toEqual({ id: "office", label: "Office" });
    expect(COMPANY_OFFICE_TAB.id).toBe("office");
  });

  it("treats office as a real tab id but never as a server-backed surface", () => {
    expect(isCompanyChannelTabId("office")).toBe(true);
    // Office renders a live native surface; there are no company-tab rows for
    // it, so it must be excluded from the endpoint-backed ids.
    expect(isCompanyTabSurfaceId("office")).toBe(false);
    expect(isCompanyTabSurfaceId("team")).toBe(true);
  });
});

describe("US-018 reachability: CompanyPage renders the Office surface", () => {
  function render(props: Record<string, unknown>): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CompanyPage, { target: host, props: props as never });
    flushSync();
    return host;
  }

  it("renders the live office for tab:'office' when native calling is available", async () => {
    const discoverOffice = vi.fn(async () => ROSTER);
    const root = render({
      adapter: fakeAdapter({ nativeCalls: true, roster: discoverOffice }),
      callsHost: {
        serviceEvidence: { schema: "hq-meet-staging-proof/v1" },
        evidenceMaxAgeMs: 90 * 24 * 60 * 60 * 1000,
        openCallWindow: async () => {},
      },
      company: COMPANY,
      tab: "office",
    });
    await settle();

    // The real surface, scoped to THIS company — not a placeholder.
    expect(testid(root, "office-self")).not.toBeNull();
    expect(testid(root, "office-row-prs_mate")).not.toBeNull();
    expect(testid(root, "office-host-refusal")).toBeNull();
    expect(
      (discoverOffice.mock.calls as unknown as unknown[][])[0]?.[0],
    ).toBe("cmp_indigo");
  });

  it("says why, in words, when the host cannot call — never a blank panel", async () => {
    const discoverOffice = vi.fn(async () => ROSTER);
    const root = render({
      adapter: fakeAdapter({ nativeCalls: false, roster: discoverOffice }),
      company: COMPANY,
      tab: "office",
    });
    await settle();

    const refusal = testid(root, "office-host-refusal");
    expect(refusal).not.toBeNull();
    expect(refusal?.getAttribute("data-refusal")).toBe("CALLS_UNSUPPORTED_HOST");
    expect(refusal?.textContent).toContain("Office hours are unavailable");
    expect(refusal?.textContent).toContain("Native calls are not available");
    expect((refusal?.textContent ?? "").trim().length).toBeGreaterThan(20);
    // And it refused BEFORE asking hq-pro anything.
    expect(discoverOffice).not.toHaveBeenCalled();
    expect(testid(root, "office-self")).toBeNull();
  });

  it("refuses in its own voice when the host supplied no calling seams", async () => {
    const root = render({
      adapter: fakeAdapter({ nativeCalls: true }),
      callsHost: null,
      company: COMPANY,
      tab: "office",
    });
    await settle();
    expect(
      testid(root, "office-host-refusal")?.getAttribute("data-refusal"),
    ).toBe("CALLS_HOST_MISSING");
  });
});

describe("US-018 reachability: the shipping shell mounts the same panel", () => {
  const shell = read("../shell/DesktopApp.svelte");

  it("renders the shared OfficePanel for the office tab", () => {
    expect(shell).toContain('import OfficePanel from "../meet/OfficePanel.svelte"');
    expect(shell).toContain('{#if companyTab === "office"}');
    expect(shell).toContain('data-testid="company-tab-panel-office"');
    expect(shell).toContain("<OfficePanel");
    // The panel gets the adapter AND the host seams; without both it cannot
    // preflight or open a window.
    const mountBlock = shell.slice(
      shell.indexOf("<OfficePanel"),
      shell.indexOf("<OfficePanel") + 400,
    );
    expect(mountBlock).toContain("{adapter}");
    expect(mountBlock).toContain("{callsHost}");
    expect(mountBlock).toContain("companyUid={selectedRow.companyUid");
  });

  it("gates the tab on the adapter capability rather than on the build", () => {
    expect(shell).toContain("companyChannelTabsFor({");
    expect(shell).toContain("nativeCalls: adapter?.capabilities?.nativeCalls === true");
    expect(shell).toContain("tabs={companyTabsForHost}");
  });

  it("never asks the company-tab endpoint for office rows", () => {
    expect(shell).toContain('if (tabId === "office") {');
  });
});

describe("US-018 reachability: the shared office stays host-agnostic", () => {
  it("imports nothing native anywhere under packages/ui/src/meet", () => {
    for (const file of [
      "./OfficePanel.svelte",
      "./OfficeHours.svelte",
      "./office-store.svelte.ts",
      "./office-host.ts",
    ]) {
      const source = read(file);
      // Prose may NAME the ban; only a real import would break the web build.
      expect(source).not.toMatch(/from\s+["']@tauri-apps\//);
      expect(source).not.toMatch(/import\(["']@tauri-apps\//);
      expect(source).not.toContain("window.__TAURI");
    }
  });

  it("routes the call window through the injected host seam, not an invoke", () => {
    const panel = read("./OfficePanel.svelte");
    expect(panel).toContain("callsHost.openCallWindow(");
    expect(panel).not.toContain("calls_open_window");
    // The target it builds is ids only — no token, key or secret.
    const target = panel.slice(
      panel.indexOf("callsHost.openCallWindow({"),
      panel.indexOf("callsHost.openCallWindow({") + 320,
    );
    for (const banned of ["token", "secret", "key", "password", "credential"]) {
      expect(target.toLowerCase()).not.toContain(banned);
    }
  });
});
