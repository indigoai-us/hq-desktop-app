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
        watchOwner: "desktop-app",
        source: "journal",
        hqFolderPath: "/Users/me/hq",
      }),
    ).toEqual({
      lastSyncAt: "2026-08-16T12:00:00Z",
      pendingFiles: 2,
      conflicts: 1,
      daemonRunning: true,
      watchOwner: "desktop-app",
      source: "journal",
      hqFolderPath: "/Users/me/hq",
    });
  });

  it("treats junk as an empty observe-only status", () => {
    expect(parseLiveSyncStatus(null).source).toBe("none");
    expect(parseLiveSyncStatus({ running: true }).daemonRunning).toBe(true);
  });

  it("accepts only bounded owner labels from the lease projection", () => {
    expect(parseLiveSyncStatus({ watchOwner: "hq-daemon" }).watchOwner).toBe(
      "hq-daemon",
    );
    expect(
      parseLiveSyncStatus({ watchOwner: "owner with spaces" }).watchOwner,
    ).toBeNull();
    expect(parseLiveSyncStatus({ watchOwner: "x".repeat(65) }).watchOwner).toBe(
      null,
    );
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
        watchOwner: null,
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
        watchOwner: null,
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
          watchOwner: null,
          source: "journal",
          hqFolderPath: null,
        },
        now,
      ),
    ).toBe("50m ago");
  });
});
