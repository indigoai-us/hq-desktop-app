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
    expect(notice?.textContent).toContain("Cloud is off");
    expect(notice?.textContent).toContain("Nothing uploads or downloads");
    expect(notice?.textContent).toContain("Settings › Sync");

    q("core-popover-cloud-settings")!.click();
    expect(onopenCloudSettings).toHaveBeenCalledTimes(1);
  });

  it("shows no notice or button with Cloud on", () => {
    mountPopover({ cloudPaused: false, onopenCloudSettings: vi.fn() });
    expect(q("core-popover-paused")).toBeNull();
    expect(q("core-popover-cloud-settings")).toBeNull();
    expect(q("core-popover-sync-state")?.textContent).toContain("All synced");
  });

  it("lights the Core pill amber while Cloud is off", () => {
    expect(corePillDotTone({ cloudPaused: true })).toBe("warn");
  });
});
