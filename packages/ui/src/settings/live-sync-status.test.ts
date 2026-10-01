import { describe, expect, it } from "vitest";

import {
  lastSyncLabelFromLive,
  parseLiveSyncStatus,
  syncStateFromLive,
} from "./live-sync-status.js";

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
        },
        now,
      ),
    ).toBe("50m ago");
  });
});
