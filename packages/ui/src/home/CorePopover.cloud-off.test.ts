// @vitest-environment happy-dom
//
// usage-only-pricing US-016: while the Settings Cloud switch is off, the Core
// popover says "Cloud off" (not "All synced"), explains it plainly, and offers
// the way back to the switch. The title-bar pill goes amber.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
import { corePillDotTone } from "./core-popover-model";
import { resetUpdateStore } from "../settings/update-store.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetUpdateStore();
});

const ok = (value: unknown) => ({ ok: true as const, value });

function makeAdapter() {
  return {
    kind: "tauri",
    company: {
      getBillingSummary: async () => ok({}),
      getUsageStatement: async () => ok(null),
      createBillingPortalSession: async () => ok({ url: "https://billing.stripe.com/x" }),
    },
    isAvailable: () => true,
    packages: {
      listPackagesCached: async () => ok(null),
      listPackages: async () => ok({ packs: { installed: [] } }),
    },
    updates: {
      getVersions: async () => ok({ core: "15.0.118" }),
      checkCoreState: async () => ok(null),
      checkForUpdates: async () => ok(null),
      checkCliUpdate: async () => ok(null),
      downloadUpdate: async () => ok(null),
      installDownloadedUpdate: async () => ok(null),
      getDownloadedUpdate: async () => ok(null),
    },
    shell: { openClaudeCodeLink: async () => ok(undefined) },
  } as never;
}

function mountPopover(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CorePopover, {
    target: host,
    props: {
      adapter: makeAdapter(),
      appVersion: "0.11.6",
      syncState: "idle",
      lastSyncLabel: "just now",
      onclose: vi.fn(),
      ...props,
    } as never,
  });
  flushSync();
}

function q(testid: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testid}"]`);
}

describe("Core popover with Cloud off (US-016)", () => {
  it("reads Cloud off, explains it, and opens Sync settings", () => {
    const onopenCloudSettings = vi.fn();
    mountPopover({ cloudPaused: true, onopenCloudSettings });

    expect(q("core-popover-sync-state")?.textContent).toContain("Cloud off");
    expect(q("core-popover-sync-state")?.textContent).not.toContain("All synced");
    const notice = q("core-popover-paused");
    expect(notice?.textContent).toContain("Cloud sync is off");
    expect(q("core-popover-paused-body")?.textContent).toBe(
      "Cloud sync is turned off. Turn it back on in Settings › Sync.",
    );
    expect(notice?.textContent).not.toContain("switch off Turn off all cloud sync");

    q("core-popover-cloud-settings")!.click();
    expect(onopenCloudSettings).toHaveBeenCalledTimes(1);
  });

  it("shows no notice or button with Cloud on", () => {
    mountPopover({ cloudPaused: false, onopenCloudSettings: vi.fn() });
    expect(q("core-popover-paused")).toBeNull();
    expect(q("core-popover-cloud-settings")).toBeNull();
    expect(q("core-popover-sync-state")?.textContent).toContain("All synced");
  });

  it("says which vaults are off and opens Sync settings", () => {
    const onopenCloudSettings = vi.fn();
    mountPopover({
      cloudPaused: false,
      onopenCloudSettings,
      workspaces: [
        { slug: "personal", kind: "personal", cloudUid: "prs_me", syncEnabled: false },
        { slug: "acme", displayName: "Acme", kind: "company", cloudUid: "cmp_a", syncEnabled: false },
        { slug: "zeta", displayName: "Zeta", kind: "company", cloudUid: "cmp_z", syncEnabled: true },
      ],
    });
    const notice = q("core-popover-vault-off");
    expect(notice?.textContent).toContain(
      "Sync is off for your personal vault and Acme on this computer.",
    );
    expect(notice?.textContent).not.toContain("Zeta");
    expect(notice?.textContent).toContain("turn the vault back on in Settings › Sync");
    q("core-popover-vault-off-settings")!.click();
    expect(onopenCloudSettings).toHaveBeenCalledTimes(1);
  });

  it("the usage panel links to Sync settings in one click", () => {
    const onopenCloudSettings = vi.fn();
    mountPopover({
      cloudPaused: false,
      onopenCloudSettings,
      usageCompany: { uid: "cmp_a", name: "Acme", role: "owner" },
    });
    const link = q("core-usage-sync-settings");
    expect(link?.textContent).toContain("Turn sync off or on for each vault");
    link!.click();
    expect(onopenCloudSettings).toHaveBeenCalledTimes(1);
  });

  it("lights the Core pill amber while Cloud is off", () => {
    expect(corePillDotTone({ cloudPaused: true })).toBe("warn");
  });
});
