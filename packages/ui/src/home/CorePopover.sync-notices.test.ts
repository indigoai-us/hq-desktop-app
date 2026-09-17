// @vitest-environment happy-dom
//
// PL-01 / PL-02 — the Core popover renders the sync status header and each of
// the four trouble notices the retired tray popover owned, with the same copy
// and the same prompt payload.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
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
    shell: {
      openClaudeCodeLink: async () => ok(undefined),
    },
  } as never;
}

function mountPopover(props: Record<string, unknown>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CorePopover, {
    target: host,
    props: {
      adapter: makeAdapter(),
      appVersion: "0.10.285",
      hqFolderPath: "/Users/me/HQ",
      onclose: vi.fn(),
      ...props,
    } as never,
  });
  flushSync();
  return host;
}

function notice(kind: string): HTMLElement | null {
  return host.querySelector(`[data-testid="core-popover-notice"][data-kind="${kind}"]`);
}

function text(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("CorePopover sync status header (PL-01)", () => {
  it("shows the state word, the last-sync line and the live caption while syncing", () => {
    mountPopover({
      syncState: "syncing",
      lastSyncLabel: "4m ago",
      syncCaption: "Syncing indigo · 3 of 28",
    });
    const header = host.querySelector('[data-testid="core-popover-sync-status"]');
    expect(header?.getAttribute("data-tone")).toBe("active");
    expect(text(host.querySelector('[data-testid="core-popover-sync-state"]'))).toContain(
      "Syncing",
    );
    expect(text(host.querySelector('[data-testid="core-popover-last-sync"]'))).toBe(
      "Last sync · 4m ago",
    );
    expect(text(host.querySelector('[data-testid="core-popover-sync-caption"]'))).toBe(
      "Syncing indigo · 3 of 28",
    );
  });

  it("reads Sync paused with a warn tone when there are conflicts", () => {
    mountPopover({ syncState: "conflict", conflictCount: 2, lastSyncLabel: null });
    const header = host.querySelector('[data-testid="core-popover-sync-status"]');
    expect(header?.getAttribute("data-tone")).toBe("warn");
    expect(text(host.querySelector('[data-testid="core-popover-sync-state"]'))).toContain(
      "Sync paused",
    );
    expect(text(host.querySelector('[data-testid="core-popover-last-sync"]'))).toBe(
      "Last sync · never",
    );
  });

  it("reads All synced with no caption when idle", () => {
    mountPopover({ syncState: "idle", lastSyncLabel: "1h ago" });
    const header = host.querySelector('[data-testid="core-popover-sync-status"]');
    expect(header?.getAttribute("data-tone")).toBe("ok");
    expect(text(host.querySelector('[data-testid="core-popover-sync-state"]'))).toContain(
      "All synced",
    );
    expect(host.querySelector('[data-testid="core-popover-sync-caption"]')).toBeNull();
    expect(host.querySelector('[data-testid="core-popover-notice"]')).toBeNull();
  });
});

describe("CorePopover sync trouble notices (PL-02)", () => {
  it("renders the conflict notice with Resolve and Copy prompt", () => {
    mountPopover({
      syncState: "conflict",
      conflictCount: 2,
      conflictCompany: "indigo",
    });
    const row = notice("conflict");
    expect(text(row)).toContain("Sync paused");
    expect(text(row)).toContain(
      "2 files changed in two places. Resolve in Claude Code, then Sync again.",
    );
    expect(
      row?.querySelector('[data-testid="core-popover-open-in-claude"]')
        ?.getAttribute("data-issue-kind"),
    ).toBe("sync-conflict");
  });

  it("renders the sync-failed notice", () => {
    mountPopover({
      syncState: "error",
      errorMessage: "runner exited 1",
      errorCompany: "indigo",
    });
    const row = notice("sync-failed");
    expect(text(row)).toContain("Finish sync in Claude Code");
    expect(text(row)).toContain("Sync started but needs a hand to complete.");
    expect(row?.getAttribute("title")).toBe("runner exited 1");
    expect(
      row?.querySelector('[data-testid="core-popover-open-in-claude"]')
        ?.getAttribute("data-issue-kind"),
    ).toBe("sync-failed");
  });

  it("renders the manifest notice as copy-only", () => {
    mountPopover({ manifestError: "line 4: bad indent" });
    const row = notice("manifest-error");
    expect(text(row)).toContain("Couldn’t read companies list");
    expect(text(row)).toContain("companies/manifest.yaml could not be read.");
    expect(text(row)).toContain("Copy fix prompt");
    expect(
      row?.querySelector('[data-testid="core-popover-open-in-claude"]'),
    ).toBeNull();
  });

  it("renders the cloud notice and sanitizes uids out of the error it shows", () => {
    mountPopover({
      cloudReachable: false,
      cloudError: "cmp_01HZZZZZZZZZZZZZZZZZZZZZZZ is unreachable",
      workspaces: [{ uid: "cmp_01HZZZZZZZZZZZZZZZZZZZZZZZ", name: "Indigo" }],
    });
    const row = notice("cloud-unreachable");
    expect(text(row)).toContain("Cloud unreachable");
    expect(text(row)).toContain("Showing local folders.");
    expect(text(row)).toContain("Copy diagnose prompt");
    expect(row?.getAttribute("title")).toBe("Indigo is unreachable");
    expect(row?.getAttribute("title")).not.toContain("cmp_");
  });
});
