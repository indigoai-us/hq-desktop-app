// @vitest-environment happy-dom
//
// hard-stop-readiness US-019: a sync pass whose uploads a plan limit refused
// is not "HQ is synced". The Core popover says "Uploads paused", names the
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
    expect(buildCoreSyncHeader({ syncState: "idle" }).stateWord).toBe("HQ is synced");
  });

  it("a run in flight or an error still wins", () => {
    expect(buildCoreSyncHeader({ syncState: "syncing", uploadsPausedCount: 1 }).stateWord).toBe(
      "Syncing",
    );
    expect(buildCoreSyncHeader({ syncState: "error", uploadsPausedCount: 1 }).stateWord).toBe(
      "Needs attention",
    );
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
    expect(state?.textContent).not.toContain("HQ is synced");
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
    ).toContain("HQ is synced");
  });
});

describe("CorePopover usage pause (US-024)", () => {
  const BILLING_URL = "https://hq.computer/companies/acme/billing";
  const MESSAGE =
    "Cloud sync is paused. Acme used its $10.00 monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.";

  it("reads the journal's usagePause and shows the server message with Open Billing", async () => {
    const { parseLiveSyncStatus } = await import("../settings/live-sync-status");
    const live = parseLiveSyncStatus({
      uploadsPaused: [
        {
          company: "Acme",
          upgradeUrl: UPGRADE_URL,
          usagePause: { code: "usage_paused", reason: "usage_card_required", message: MESSAGE, actionUrl: BILLING_URL },
        },
      ],
    });
    expect(live.uploadsPaused).toEqual([
      { company: "Acme", upgradeUrl: BILLING_URL, usagePause: expect.objectContaining({ message: MESSAGE }) },
    ]);
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
        uploadsPaused: live.uploadsPaused,
        onopenurl,
        onclose: vi.fn(),
      } as never,
    });
    flushSync();
    const row = host.querySelector('[data-testid="core-popover-uploads-paused"]');
    expect(row?.textContent).toContain("Cloud sync paused for Acme");
    expect(row?.textContent).toContain(MESSAGE);
    expect(row?.textContent).not.toMatch(/plan limit|Upgrade|Starter|Workforce|Individual/);
    const button = host.querySelector('[data-testid="core-popover-uploads-paused-upgrade"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Open Billing");
    button.click();
    expect(onopenurl).toHaveBeenCalledWith(BILLING_URL);
  });

  it("keeps the legacy row and label without a usage pause", () => {
    expect(buildUploadsPausedRows([{ company: "Acme", upgradeUrl: UPGRADE_URL }])[0].actionLabel).toBe("Upgrade plan");
  });
});
