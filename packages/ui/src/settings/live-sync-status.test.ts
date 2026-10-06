import { describe, expect, it } from "vitest";

import {
  lastSyncLabelFromLive,
  parseLiveSyncStatus,
  readLiveSyncStatus,
  syncStateFromLive,
} from "./live-sync-status.js";
import { ok, type PlatformAdapter } from "@hq/platform";

describe("parseLiveSyncStatus", () => {
  it("reads the v1 journal camelCase shape", () => {
    expect(
      parseLiveSyncStatus({
        lastSyncAt: "2026-08-16T12:00:00Z",
        pendingFiles: 2,
        conflicts: 1,
        daemonRunning: true,
        source: "journal",
        hqFolderPath: "/Users/me/hq",
      }),
    ).toEqual({
      lastSyncAt: "2026-08-16T12:00:00Z",
      pendingFiles: 2,
      conflicts: 1,
      daemonRunning: true,
      source: "journal",
      hqFolderPath: "/Users/me/hq",
      uploadsPaused: [],
      daemonOwner: null,
      daemonHealth: null,
      daemonErrors: [],
      daemonLogPath: null,
    });
  });

  it("reads the companies whose uploads are paused by a plan limit", () => {
    const parsed = parseLiveSyncStatus({
      lastSyncAt: "2026-09-28T12:00:00Z",
      conflicts: 0,
      source: "journal",
      uploadsPaused: [
        {
          company: "Acme",
          upgradeUrl: "https://hq.computer/companies/acme/billing?upgrade=1",
          lastNoticeAtMs: 1,
        },
        { company: "Beta", lastNoticeAtMs: 2 },
        { company: "Gamma", upgradeUrl: "https://app.indigo-hq.com/billing/upgrade" },
        { company: "  " },
        "junk",
      ],
    });
    expect(parsed.uploadsPaused).toEqual([
      {
        company: "Acme",
        upgradeUrl: "https://hq.computer/companies/acme/billing?upgrade=1",
      },
      { company: "Beta", upgradeUrl: null },
      { company: "Gamma", upgradeUrl: null },
    ]);
    expect(parseLiveSyncStatus({}).uploadsPaused).toEqual([]);
  });

  it("treats junk as an empty observe-only status", () => {
    expect(parseLiveSyncStatus(null).source).toBe("none");
    expect(parseLiveSyncStatus({ running: true }).daemonRunning).toBe(true);
  });
});

describe("readLiveSyncStatus daemon projection", () => {
  it("keeps working with a legacy adapter that has no daemon status method", async () => {
    const adapter = {
      isAvailable: () => true,
      sync: {
        getSyncStatus: async () => ok({ daemonRunning: false, source: "journal" }),
      },
    } as unknown as PlatformAdapter;

    await expect(readLiveSyncStatus(adapter)).resolves.toMatchObject({
      daemonRunning: false,
      source: "journal",
      daemonErrors: [],
    });
  });

  it("uses CLI ownership, health, last pass, errors, and log path in daemon mode", async () => {
    const adapter = {
      isAvailable: () => true,
      sync: {
        getSyncStatus: async () => ok({ daemonRunning: false, source: "legacy" }),
        daemonSyncStatus: async () => ok({
          running: true,
          paused: false,
          syncOwner: "daemon",
          owner: "hq-daemon",
          lastHeartbeat: "2026-10-01T12:01:00Z",
          lastPassResult: { status: "ok", completedAt: "2026-10-01T12:00:00Z", errors: 1 },
          unitStatus: "running",
          reason: null,
          logPath: "/tmp/hq-sync.log",
        }),
      },
    } as unknown as PlatformAdapter;

    await expect(readLiveSyncStatus(adapter)).resolves.toMatchObject({
      daemonRunning: true,
      source: "hq-daemon",
      lastSyncAt: "2026-10-01T12:00:00Z",
      daemonOwner: "hq-daemon",
      daemonHealth: "running",
      daemonErrors: ["The last daemon sync reported errors. See the daemon log for details."],
      daemonLogPath: "/tmp/hq-sync.log",
    });
  });

  it("keeps the newest successful sync timestamp across the journal and daemon status", async () => {
    const adapter = {
      isAvailable: () => true,
      sync: {
        getSyncStatus: async () => ok({ lastSyncAt: "2026-10-01T12:30:00Z", source: "journal" }),
        daemonSyncStatus: async () => ok({
          running: true,
          paused: false,
          syncOwner: "daemon",
          owner: "hq-daemon",
          lastHeartbeat: null,
          lastPassResult: { status: "ok", completedAt: "2026-10-01T12:00:00Z", errors: 0 },
          unitStatus: "running",
          reason: null,
          logPath: "/tmp/hq-sync.log",
        }),
      },
    } as unknown as PlatformAdapter;

    await expect(readLiveSyncStatus(adapter)).resolves.toMatchObject({
      lastSyncAt: "2026-10-01T12:30:00Z",
    });
  });

  it("does not show a paused or lease-waiting daemon reason as a sync error", async () => {
    const adapter = {
      isAvailable: () => true,
      sync: {
        getSyncStatus: async () => ok({}),
        daemonSyncStatus: async () => ok({
          running: false,
          paused: true,
          syncOwner: "daemon",
          owner: null,
          lastHeartbeat: null,
          lastPassResult: null,
          unitStatus: "waiting",
          reason: "Sync is paused until resumed",
          logPath: "/tmp/hq-sync.log",
        }),
      },
    } as unknown as PlatformAdapter;

    await expect(readLiveSyncStatus(adapter)).resolves.toMatchObject({
      daemonHealth: "paused",
      daemonErrors: [],
    });
  });

  it("shows when the installed CLI cannot apply the Instant Sync setting", async () => {
    const message = "Instant Sync is off, but this HQ CLI version cannot apply that setting. Update HQ CLI to use Instant Sync controls.";
    const adapter = {
      isAvailable: () => true,
      sync: {
        getSyncStatus: async () => ok({}),
        daemonSyncStatus: async () => ok({
          running: true,
          paused: false,
          syncOwner: "daemon",
          owner: "hq-daemon",
          lastHeartbeat: null,
          lastPassResult: null,
          unitStatus: "running",
          reason: message,
          logPath: "/tmp/hq-sync.log",
        }),
      },
    } as unknown as PlatformAdapter;

    await expect(readLiveSyncStatus(adapter)).resolves.toMatchObject({
      daemonErrors: [message],
    });
  });

  it("keeps daemon command failures visible as actionable status", async () => {
    const adapter = {
      isAvailable: () => true,
      sync: {
        getSyncStatus: async () => ok({}),
        daemonSyncStatus: async () => ({ ok: false, message: "HQ CLI is unavailable. Install or update it, then retry." }),
      },
    } as unknown as PlatformAdapter;

    await expect(readLiveSyncStatus(adapter)).resolves.toMatchObject({
      daemonErrors: ["HQ CLI is unavailable. Install or update it, then retry."],
      daemonLogPath: "~/.hq/daemon/logs/sync.log",
    });
  });
});

describe("syncStateFromLive", () => {
  it("surfaces conflicts and otherwise stays idle", () => {
    expect(
      syncStateFromLive({
        lastSyncAt: null,
        pendingFiles: 0,
        conflicts: 2,
        daemonRunning: true,
        source: "journal",
        hqFolderPath: null,
        daemonOwner: null,
        daemonHealth: null,
        daemonErrors: [],
        daemonLogPath: null,
      }),
    ).toBe("conflict");
    expect(
      syncStateFromLive({
        lastSyncAt: "2026-08-16T12:00:00Z",
        pendingFiles: 0,
        conflicts: 0,
        daemonRunning: true,
        source: "journal",
        hqFolderPath: null,
        daemonOwner: null,
        daemonHealth: null,
        daemonErrors: [],
        daemonLogPath: null,
      }),
    ).toBe("idle");
  });
});

describe("lastSyncLabelFromLive", () => {
  it("uses a relative clock", () => {
    const now = Date.parse("2026-08-16T13:00:00Z");
    expect(
      lastSyncLabelFromLive(
        {
          lastSyncAt: "2026-08-16T12:10:00Z",
          pendingFiles: 0,
          conflicts: 0,
          daemonRunning: false,
          source: "journal",
          hqFolderPath: null,
          daemonOwner: null,
          daemonHealth: null,
          daemonErrors: [],
          daemonLogPath: null,
        },
        now,
      ),
      ).toBe("50m ago");
  });
});
