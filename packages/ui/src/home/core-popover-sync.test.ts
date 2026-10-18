// PL-01 / PL-02 — the Core popover's sync status header and the four sync
// trouble notices the retired tray popover used to own.
//
// The copy here is not decorative: it was taken verbatim from the tray
// popover (deleted in PL-07) so the relocated surface says exactly what the
// tray popover said. These tests are now the only record of that wording —
// changing a string here is changing what users read.

import { describe, expect, it } from "vitest";
import {
  buildCoreNoticeRows,
  buildCorePopoverViewModel,
  buildCoreSyncHeader,
  corePillDotTone,
  lastSyncLine,
  syncStateTone,
  syncStateWord,
} from "./core-popover-model.js";

describe("syncStateWord", () => {
  it("uses the tray popover's words verbatim", () => {
    expect(syncStateWord("syncing")).toBe("Syncing");
    expect(syncStateWord("auth-error")).toBe("Sign in required");
    expect(syncStateWord("error")).toBe("Needs attention");
    expect(syncStateWord("idle")).toBe("All synced");
  });

  it("falls back to the healthy word for unknown or missing phases", () => {
    expect(syncStateWord(null)).toBe("All synced");
    expect(syncStateWord("setup-needed")).toBe("All synced");
    // A parked sync conflict is not a sync state (owner decision 2026-10-13).
    expect(syncStateWord("conflict")).toBe("All synced");
  });
});

describe("syncStateTone", () => {
  it("separates in-flight from trouble", () => {
    expect(syncStateTone("syncing")).toBe("active");
    expect(syncStateTone("conflict")).toBe("ok");
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

describe("first-launch npm cache bail (US-014)", () => {
  const raw =
    "HQ Sync is still preparing its npm cache in another window. Wait a moment, then try Sync again.";

  it("replaces the raw npm message with one plain line and Sync now", () => {
    const model = buildCorePopoverViewModel({
      syncState: "error",
      notices: { errorMessage: raw },
    });
    expect(model.syncOffer).toEqual({
      line: "Your files have not synced yet.",
      action: "Sync now",
    });
    expect(model.notices.some((row) => row.kind === "sync-failed")).toBe(false);
    const visible = JSON.stringify({
      offer: model.syncOffer,
      notices: model.notices,
    });
    expect(visible.toLowerCase()).not.toContain("npm");
    expect(visible).not.toContain("another window");
    expect(visible).not.toContain("!");
    expect(visible).not.toContain("—");
  });

  it("keeps Sync now when the backend already sent the plain line", () => {
    const model = buildCorePopoverViewModel({
      syncState: "error",
      notices: { errorMessage: "Your files have not synced yet." },
    });
    expect(model.syncOffer).toEqual({
      line: "Your files have not synced yet.",
      action: "Sync now",
    });
  });
});

describe("buildCoreNoticeRows", () => {
  it("renders nothing when everything is healthy", () => {
    expect(
      buildCoreNoticeRows({ syncState: "idle", cloudReachable: true }),
    ).toEqual([]);
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
      syncState: "error",
      errorMessage: "boom",
      manifestError: "bad yaml",
      cloudReachable: false,
      cloudError: "offline",
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "sync-failed",
      "manifest-error",
      "cloud-unreachable",
    ]);
  });
});

describe("buildCorePopoverViewModel sync surface", () => {
  it("carries the header and the notices alongside the existing model", () => {
    const model = buildCorePopoverViewModel({
      syncState: "idle",
      lastSyncLabel: "5m ago",
    });
    expect(model.syncHeader.stateWord).toBe("All synced");
    expect(model.syncHeader.lastSyncLine).toBe("Last sync · 5m ago");
    expect(model.notices).toEqual([]);
  });
});
