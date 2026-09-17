import { describe, expect, it } from "vitest";
import {
  emptySyncStatus,
  reduceSyncEvent,
  syncStatusLabel,
  SYNC_STATUS_EVENTS,
} from "./sync-status.js";

const plan = (company: string, down = 0, up = 0, del = 0, skip = 0) => ({
  company,
  filesToDownload: down,
  filesToUpload: up,
  filesToDelete: del,
  filesToSkip: skip,
});

describe("sync-status reducer", () => {
  it("counts progress against the planned total", () => {
    let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", plan("acme", 20, 8));
    expect(s.planTotal).toBe(28);
    s = reduceSyncEvent(s, "sync:progress", { company: "acme", path: "a" });
    s = reduceSyncEvent(s, "sync:progress", { company: "acme", path: "b" });
    s = reduceSyncEvent(s, "sync:progress", { company: "acme", path: "c" });
    expect(syncStatusLabel(s).text).toBe("3 of 28");
  });

  it("sums plans across companies instead of replacing them", () => {
    // A run covers several workspaces and emits one plan each. Replacing would
    // make the denominator jump backwards mid-run.
    let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", plan("acme", 10));
    s = reduceSyncEvent(s, "sync:plan", plan("beta", 5));
    expect(s.planTotal).toBe(15);
  });

  it("excludes skipped files from the total", () => {
    // Skipped files are never moved, so counting them guarantees the caption
    // can never reach its own denominator.
    const s = reduceSyncEvent(emptySyncStatus(), "sync:plan", plan("acme", 2, 0, 0, 99));
    expect(s.planTotal).toBe(2);
  });

  it("counts deletes, which do emit a progress event", () => {
    const s = reduceSyncEvent(emptySyncStatus(), "sync:plan", plan("acme", 1, 0, 3));
    expect(s.planTotal).toBe(4);
  });

  it("does not reset on per-company completion, only when the run ends", () => {
    // `sync:complete` fires per company. Resetting there would make a
    // multi-company run count up, restart, and count up again.
    let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", plan("acme", 4));
    s = reduceSyncEvent(s, "sync:progress", { company: "acme" });
    s = reduceSyncEvent(s, "sync:complete", { company: "acme" });
    expect(s.progressed).toBe(1);
    expect(s.phase).toBe("syncing");

    s = reduceSyncEvent(s, "sync:all-complete", {});
    expect(s).toEqual(emptySyncStatus());
  });

  it("counts up without a denominator when no plan arrived", () => {
    // Older runners send no plan. Counting honestly beats inventing a total.
    let s = reduceSyncEvent(emptySyncStatus(), "sync:progress", { company: "acme" });
    s = reduceSyncEvent(s, "sync:progress", { company: "acme" });
    expect(syncStatusLabel(s).text).toBe("2 files");
  });

  it("leaves attention states to the Core pill rather than lighting a second warning", () => {
    // The Core pill's dot tone and its popover sentence already own
    // auth-error / conflict / error. A second indicator in the same bar makes
    // it ambiguous which one to act on. The phase is still reduced and
    // available; the title bar just does not draw it.
    for (const event of ["sync:auth-error", "sync:conflict", "sync:error"]) {
      let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", plan("acme", 9));
      s = reduceSyncEvent(s, event, {});
      const label = syncStatusLabel(s);
      expect(label.text, `${event} must not draw a chip`).toBeNull();
      expect(label.tone).toBe("attention");
      expect(s.phase, "the phase is still tracked for other consumers").not.toBe("idle");
    }
  });

  it("says nothing at all when idle", () => {
    // A permanent "All synced" chip is right almost always and therefore stops
    // being read. Silence is the signal.
    expect(syncStatusLabel(emptySyncStatus()).text).toBeNull();
  });

  it("returns the identical object for events it does not handle", () => {
    // The runner emits a lot of events. Returning a copy would invalidate the
    // title bar's subtree on every one of them.
    const s = emptySyncStatus();
    expect(reduceSyncEvent(s, "sync:new-files", { company: "acme" })).toBe(s);
    expect(reduceSyncEvent(s, "sync:totals", {})).toBe(s);
  });

  it("survives malformed payloads rather than showing NaN", () => {
    let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", null);
    s = reduceSyncEvent(s, "sync:plan", { filesToDownload: "lots" });
    s = reduceSyncEvent(s, "sync:plan", { filesToDownload: -4 });
    expect(s.planTotal).toBe(0);
    expect(syncStatusLabel(s).text).toBe("Starting…");
  });

  it("names every event the reducer actually handles", () => {
    // A host subscribing to this list is the contract; drift means an event
    // silently stops being counted.
    for (const name of SYNC_STATUS_EVENTS) {
      const before = { ...emptySyncStatus(), progressed: 1, planTotal: 2 };
      expect(
        reduceSyncEvent(before, name, { company: "acme" }),
        `${name} is listed but not handled`,
      ).not.toBe(before);
    }
  });
});
