// @vitest-environment happy-dom
//
// hard-stop-readiness US-019: a sync pass whose uploads a plan limit refused
// is not "All synced". The Core popover says "Uploads paused", names the
// company, and offers the upgrade link; the title-bar pill goes amber.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
import {
  buildCorePopoverViewModel,
  buildCoreSyncHeader,
  buildUploadsPausedRows,
  corePillDotTone,
} from "./core-popover-model";
import { resetUpdateStore } from "../settings/update-store.svelte";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

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

describe("uploads-paused status model", () => {
  it("an idle pass with plan-limit skips reads Uploads paused, not All synced", () => {
    const header = buildCoreSyncHeader({ syncState: "idle", uploadsPausedCount: 1 });
    expect(header.stateWord).toBe("Uploads paused");
    expect(header.tone).toBe("warn");
    expect(buildCoreSyncHeader({ syncState: "idle" }).stateWord).toBe("All synced");
  });

  it("a run in flight, an error, or a conflict still wins", () => {
    expect(buildCoreSyncHeader({ syncState: "syncing", uploadsPausedCount: 1 }).stateWord).toBe(
      "Syncing",
    );
    expect(buildCoreSyncHeader({ syncState: "error", uploadsPausedCount: 1 }).stateWord).toBe(
      "Needs attention",
    );
    expect(
      buildCoreSyncHeader({ syncState: "idle", conflictCount: 2, uploadsPausedCount: 1 })
        .stateWord,
    ).toBe("Sync paused");
  });

  it("lights the Core pill amber while uploads are paused", () => {
    expect(corePillDotTone({ uploadsPausedCount: 1 })).toBe("warn");
    expect(corePillDotTone({ uploadsPausedCount: 1, syncState: "syncing" })).toBe("active");
    expect(corePillDotTone({ uploadsPausedCount: 0 })).toBe("ok");
  });

  it("builds one row per company with its upgrade link", () => {
    expect(
      buildUploadsPausedRows([
        { company: "Acme", upgradeUrl: UPGRADE_URL },
        { company: "Beta", upgradeUrl: null },
        { company: "Acme", upgradeUrl: UPGRADE_URL },
        { company: "  " },
      ]).map((row) => [row.title, row.upgradeUrl]),
    ).toEqual([
      ["Uploads paused for Acme", UPGRADE_URL],
      ["Uploads paused for Beta", null],
    ]);
    const vm = buildCorePopoverViewModel({
      syncState: "idle",
      uploadsPaused: [{ company: "Acme", upgradeUrl: UPGRADE_URL }],
    });
    expect(vm.syncHeader.stateWord).toBe("Uploads paused");
    expect(vm.uploadsPaused).toHaveLength(1);
  });
});

describe("CorePopover uploads paused (US-019)", () => {
  it("names the company and opens the upgrade link", () => {
    const onopenurl = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CorePopover, {
      target: host,
      props: {
        adapter: makeAdapter(),
        appVersion: "0.10.352",
        syncState: "idle",
        lastSyncLabel: "just now",
        uploadsPaused: [{ company: "Acme", upgradeUrl: UPGRADE_URL }],
        onopenurl,
        onclose: vi.fn(),
      } as never,
    });
    flushSync();

    const state = host.querySelector('[data-testid="core-popover-sync-state"]');
    expect(state?.textContent).toContain("Uploads paused");
    expect(state?.textContent).not.toContain("All synced");
    expect(
      host.querySelector('[data-testid="core-popover-sync-status"]')?.getAttribute("data-tone"),
    ).toBe("warn");
    const row = host.querySelector('[data-testid="core-popover-uploads-paused"]');
    expect(row?.textContent).toContain("Uploads paused for Acme");
    (
      host.querySelector(
        '[data-testid="core-popover-uploads-paused-upgrade"]',
      ) as HTMLButtonElement
    ).click();
    expect(onopenurl).toHaveBeenCalledWith(UPGRADE_URL);
  });

  it("shows nothing extra when no company is paused", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CorePopover, {
      target: host,
      props: {
        adapter: makeAdapter(),
        appVersion: "0.10.352",
        syncState: "idle",
        onclose: vi.fn(),
      } as never,
    });
    flushSync();
    expect(host.querySelector('[data-testid="core-popover-uploads-paused"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="core-popover-sync-state"]')?.textContent,
    ).toContain("All synced");
  });
});
