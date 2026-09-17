// PL-01 / PL-02 — the Core popover's sync status header and the four sync
// trouble notices the retired tray popover used to own.
//
// The copy here is not decorative: it is asserted verbatim against
// `apps/sync/src/components/Popover.svelte` so the relocated surface says
// exactly what the tray popover said. Changing a string here without changing
// it there (or vice versa) is the regression these tests exist to catch.

import { describe, expect, it } from "vitest";
import {
  buildCoreNoticeRows,
  buildCorePopoverViewModel,
  buildCoreSyncHeader,
  conflictNoticeBody,
  corePillDotTone,
  lastSyncLine,
  syncStateTone,
  syncStateWord,
} from "./core-popover-model.js";

describe("syncStateWord", () => {
  it("uses the tray popover's words verbatim", () => {
    expect(syncStateWord("syncing")).toBe("Syncing");
    expect(syncStateWord("auth-error")).toBe("Sign in required");
    expect(syncStateWord("conflict")).toBe("Sync paused");
    expect(syncStateWord("error")).toBe("Needs attention");
    expect(syncStateWord("idle")).toBe("All synced");
  });

  it("falls back to the healthy word for unknown or missing phases", () => {
    expect(syncStateWord(null)).toBe("All synced");
    expect(syncStateWord("setup-needed")).toBe("All synced");
  });
});

describe("syncStateTone", () => {
  it("separates in-flight from trouble", () => {
    expect(syncStateTone("syncing")).toBe("active");
    expect(syncStateTone("conflict")).toBe("warn");
    expect(syncStateTone("error")).toBe("warn");
    expect(syncStateTone("auth-error")).toBe("warn");
    expect(syncStateTone("idle")).toBe("ok");
  });
});

describe("lastSyncLine", () => {
  it("frames the ago label and names the empty case", () => {
    expect(lastSyncLine("3m ago")).toBe("Last sync · 3m ago");
    expect(lastSyncLine(null)).toBe("Last sync · never");
    expect(lastSyncLine("   ")).toBe("Last sync · never");
  });
});

describe("buildCoreSyncHeader", () => {
  it("shows the live caption only while a run is in flight", () => {
    const syncing = buildCoreSyncHeader({
      syncState: "syncing",
      lastSyncLabel: "2m ago",
      syncCaption: "Syncing indigo · 3 of 28",
    });
    expect(syncing.stateWord).toBe("Syncing");
    expect(syncing.tone).toBe("active");
    expect(syncing.syncing).toBe(true);
    expect(syncing.caption).toBe("Syncing indigo · 3 of 28");
    expect(syncing.lastSyncLine).toBe("Last sync · 2m ago");

    const idle = buildCoreSyncHeader({
      syncState: "idle",
      lastSyncLabel: "2m ago",
      syncCaption: "Syncing indigo · 3 of 28",
    });
    expect(idle.caption).toBeNull();
    expect(idle.stateWord).toBe("All synced");
  });

  it("reads Sync paused when conflicts exist on an otherwise idle journal", () => {
    const header = buildCoreSyncHeader({ syncState: "idle", conflictCount: 2 });
    expect(header.stateWord).toBe("Sync paused");
    expect(header.tone).toBe("warn");
  });

  it("lets a run in flight outrank a stale conflict count", () => {
    const header = buildCoreSyncHeader({
      syncState: "syncing",
      conflictCount: 2,
    });
    expect(header.stateWord).toBe("Syncing");
  });

  it("never claims a caption it was not given", () => {
    expect(
      buildCoreSyncHeader({ syncState: "syncing", syncCaption: "  " }).caption,
    ).toBeNull();
  });
});

describe("corePillDotTone", () => {
  it("shows the active tone for a healthy run in flight", () => {
    expect(corePillDotTone({ syncState: "syncing" })).toBe("active");
  });

  it("warns on trouble ahead of a run", () => {
    expect(corePillDotTone({ syncState: "syncing", conflictCount: 1 })).toBe(
      "warn",
    );
    expect(corePillDotTone({ syncState: "syncing", cloudReachable: false })).toBe(
      "warn",
    );
    expect(
      corePillDotTone({ syncState: "syncing", manifestError: "boom" }),
    ).toBe("warn");
  });

  it("stays green when nothing is wrong and nothing is running", () => {
    expect(corePillDotTone({ syncState: "idle", cloudReachable: true })).toBe(
      "ok",
    );
  });
});

describe("conflictNoticeBody", () => {
  it("matches the tray popover's singular / plural copy", () => {
    expect(conflictNoticeBody(1)).toBe(
      "1 file changed in two places. Resolve in Claude Code, then Sync again.",
    );
    expect(conflictNoticeBody(3)).toBe(
      "3 files changed in two places. Resolve in Claude Code, then Sync again.",
    );
    expect(conflictNoticeBody(0)).toBe(
      "A file changed in two places. Resolve in Claude Code, then Sync again.",
    );
  });
});

describe("buildCoreNoticeRows", () => {
  it("renders nothing when everything is healthy", () => {
    expect(
      buildCoreNoticeRows({ syncState: "idle", cloudReachable: true }),
    ).toEqual([]);
  });

  it("renders the conflict row with the sync-conflict payload", () => {
    const [row, ...rest] = buildCoreNoticeRows({
      syncState: "conflict",
      conflictCount: 2,
      conflictCompany: "indigo",
    });
    expect(rest).toEqual([]);
    expect(row.kind).toBe("conflict");
    expect(row.title).toBe("Sync paused");
    expect(row.body).toBe(conflictNoticeBody(2));
    expect(row.openLabel).toBe("Resolve");
    expect(row.copyLabel).toBe("Copy prompt");
    expect(row.issue).toEqual({
      kind: "sync-conflict",
      payload: { count: 2, company: "indigo" },
    });
  });

  it("renders the sync-failed row with the failure message in the payload", () => {
    const [row] = buildCoreNoticeRows({
      syncState: "error",
      errorMessage: "runner exited 1",
      errorCompany: "indigo",
    });
    expect(row.kind).toBe("sync-failed");
    expect(row.title).toBe("Finish sync in Claude Code");
    expect(row.body).toBe("Sync started but needs a hand to complete.");
    expect(row.openLabel).toBe("Finish in Claude Code");
    expect(row.issue).toEqual({
      kind: "sync-failed",
      payload: { message: "runner exited 1", company: "indigo" },
    });
  });

  it("suppresses the sync-failed row when the error phase carries no message", () => {
    expect(buildCoreNoticeRows({ syncState: "error", errorMessage: "" })).toEqual(
      [],
    );
  });

  it("renders the manifest row as copy-only", () => {
    const [row] = buildCoreNoticeRows({ manifestError: "line 4: bad indent" });
    expect(row.kind).toBe("manifest-error");
    expect(row.title).toBe("Couldn’t read companies list");
    expect(row.body).toBe("companies/manifest.yaml could not be read.");
    expect(row.openLabel).toBeNull();
    expect(row.copyLabel).toBe("Copy fix prompt");
    expect(row.detail).toBe("line 4: bad indent");
    expect(row.issue).toEqual({
      kind: "manifest-error",
      payload: { error: "line 4: bad indent" },
    });
  });

  it("renders the cloud row as copy-only, at the warn (degraded) tone", () => {
    const [row] = buildCoreNoticeRows({
      cloudReachable: false,
      cloudError: "network down",
    });
    expect(row.kind).toBe("cloud-unreachable");
    expect(row.tone).toBe("warn");
    expect(row.title).toBe("Cloud unreachable");
    expect(row.body).toBe("Showing local folders.");
    expect(row.copyLabel).toBe("Copy diagnose prompt");
    expect(row.issue).toEqual({
      kind: "cloud-unreachable",
      payload: { error: "network down" },
    });
  });

  it("keeps the tray popover's row order when several states are live at once", () => {
    const rows = buildCoreNoticeRows({
      syncState: "conflict",
      conflictCount: 1,
      manifestError: "bad yaml",
      cloudReachable: false,
      cloudError: "offline",
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "conflict",
      "manifest-error",
      "cloud-unreachable",
    ]);
  });
});

describe("buildCorePopoverViewModel sync surface", () => {
  it("carries the header and the notices alongside the existing model", () => {
    const model = buildCorePopoverViewModel({
      syncState: "conflict",
      lastSyncLabel: "5m ago",
      conflicts: [{ path: "companies/indigo/notes.md", status: "pending" }],
      notices: { conflictCount: 1, conflictCompany: "indigo" },
    });
    expect(model.syncHeader.stateWord).toBe("Sync paused");
    expect(model.syncHeader.lastSyncLine).toBe("Last sync · 5m ago");
    expect(model.notices.map((r) => r.kind)).toEqual(["conflict"]);
    // Existing behaviour is untouched.
    expect(model.conflictRows).toHaveLength(1);
    expect(model.conflictHeader).toContain("1 conflict needs you");
  });

  it("trusts the journal conflict count when the event stream has none", () => {
    const model = buildCorePopoverViewModel({
      syncState: "idle",
      notices: { conflictCount: 3 },
    });
    expect(model.syncHeader.stateWord).toBe("Sync paused");
    expect(model.notices[0]?.issue.payload).toEqual({
      count: 3,
      company: "",
    });
  });
});
