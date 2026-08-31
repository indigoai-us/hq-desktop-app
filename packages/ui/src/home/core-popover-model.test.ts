import { describe, expect, it } from "vitest";
import {
  appVersionLabel,
  buildCorePopoverViewModel,
  CLOUD_PAUSED_NOTICE,
  conflictCompanyPath,
  conflictFileName,
  conflictHeaderLabel,
  coreNeedsRestore,
  detectedCoreVersion,
  driftPillLabel,
  hqVersionLabel,
  isSyncNowAllowed,
  packsSummaryLabel,
} from "./core-popover-model";

describe("core-popover-model (US-016)", () => {
  describe("detectedCoreVersion", () => {
    it("does not report a CLI-only install as HQ Core", () => {
      expect(detectedCoreVersion({ cli: "0.9.0" })).toBeNull();
      expect(detectedCoreVersion({ core: "15.0.15", cli: "0.9.0" })).toBe(
        "15.0.15",
      );
    });
  });

  describe("conflicts present / empty", () => {
    it("builds rescue-card rows with filename + company path", () => {
      const vm = buildCorePopoverViewModel({
        conflicts: [
          {
            path: "companies/indigo/knowledge/notes.md",
            status: "pending",
          },
          {
            path: "personal/draft.txt",
            status: "resolving",
          },
        ],
      });
      expect(vm.conflictCount).toBe(2);
      expect(vm.conflictHeader).toBe("2 conflicts need you");
      expect(vm.conflictRows[0]).toMatchObject({
        fileName: "notes.md",
        companyPath: "companies/indigo/knowledge",
        actionsDisabled: false,
      });
      expect(vm.conflictRows[1].actionsDisabled).toBe(true);
    });

    it("singular header and empty card when no unresolved conflicts", () => {
      expect(conflictHeaderLabel(1)).toBe("1 conflict needs you");
      const empty = buildCorePopoverViewModel({ conflicts: [] });
      expect(empty.conflictCount).toBe(0);
      expect(empty.conflictHeader).toBe("");
      expect(empty.conflictRows).toEqual([]);

      // Resolved rows clear from the card.
      const cleared = buildCorePopoverViewModel({
        conflicts: [{ path: "a.md", status: "resolved" }],
      });
      expect(cleared.conflictCount).toBe(0);
      expect(cleared.conflictRows).toEqual([]);
    });

    it("path helpers strip filename and handle root files", () => {
      expect(conflictFileName("companies/x/file.md")).toBe("file.md");
      expect(conflictCompanyPath("companies/x/file.md")).toBe("companies/x");
      expect(conflictCompanyPath("solo.md")).toBe("HQ root");
    });
  });

  describe("drift vs no-drift", () => {
    it("labels NO DRIFT when count is zero", () => {
      expect(driftPillLabel(0)).toBe("NO DRIFT");
      const vm = buildCorePopoverViewModel({
        core: { hqVersion: "15.0.1", driftCount: 0, needsRestore: false },
      });
      expect(vm.driftPill).toBe("NO DRIFT");
      expect(vm.driftOpenable).toBe(false);
      expect(vm.showRestore).toBe(false);
      expect(vm.hqVersionLabel).toBe("HQ core v15.0.1");
    });

    it("labels N drifted and exposes restore when needed", () => {
      expect(driftPillLabel(3)).toBe("3 drifted");
      expect(coreNeedsRestore(false, 2)).toBe(true);
      expect(coreNeedsRestore(true, 0)).toBe(true);
      expect(coreNeedsRestore(false, 0)).toBe(false);
      const vm = buildCorePopoverViewModel({
        core: { hqVersion: "15.0.1", driftCount: 3, needsRestore: true },
      });
      expect(vm.driftPill).toBe("3 drifted");
      expect(vm.driftOpenable).toBe(true);
      expect(vm.showRestore).toBe(true);
    });

    it("hqVersionLabel falls back when missing", () => {
      expect(hqVersionLabel(null)).toBe("HQ core not detected");
      expect(hqVersionLabel("")).toBe("HQ core not detected");
    });
  });

  describe("update available / none", () => {
    it("surfaces Update when available, version label always", () => {
      const available = buildCorePopoverViewModel({
        appVersion: "0.10.106",
        updateAvailable: true,
      });
      expect(available.updateAvailable).toBe(true);
      expect(available.appVersionLabel).toBe("Desktop app v0.10.106");

      const none = buildCorePopoverViewModel({
        appVersion: "0.10.106",
        updateAvailable: false,
      });
      expect(none.updateAvailable).toBe(false);
      expect(appVersionLabel(null)).toBe("Desktop app");
    });
  });

  describe("paused vs active", () => {
    it("paused notice + Sync Now no-op while cloud is off", () => {
      const paused = buildCorePopoverViewModel({ cloudPaused: true });
      expect(paused.cloudPaused).toBe(true);
      expect(paused.pausedNotice).toBe(CLOUD_PAUSED_NOTICE);
      expect(paused.syncNowAllowed).toBe(false);
      expect(isSyncNowAllowed(true)).toBe(false);

      const active = buildCorePopoverViewModel({ cloudPaused: false });
      expect(active.pausedNotice).toBeNull();
      expect(active.syncNowAllowed).toBe(true);
      expect(isSyncNowAllowed(false)).toBe(true);
    });
  });

  describe("packs section", () => {
    it("summarizes installed packs for the expandable list", () => {
      expect(packsSummaryLabel(0)).toBe("No packs installed");
      expect(packsSummaryLabel(1)).toBe("1 pack installed");
      const vm = buildCorePopoverViewModel({
        packs: [
          { name: "engineering", version: "1.0.0" },
          { name: "gstack", version: "2.0.0" },
        ],
        packsExpanded: true,
      });
      expect(vm.packsSummary).toBe("2 packs installed");
      expect(vm.packsExpanded).toBe(true);
      expect(vm.packs.map((p) => p.name)).toEqual(["engineering", "gstack"]);
    });
  });
});

// ── Design-gap wave regressions (G6 / G7) ────────────────────────────────────

import { corePillDotTone, driftPillTone } from "./core-popover-model";

describe("G6: undetected core never pairs with green NO DRIFT", () => {
  it("shows a neutral NOT CHECKED pill when hq core is not detected", () => {
    const vm = buildCorePopoverViewModel({
      core: { hqVersion: null, driftCount: 0, needsRestore: false },
    });
    expect(vm.hqVersionLabel).toBe("HQ core not detected");
    expect(vm.coreDetected).toBe(false);
    expect(vm.driftPill).toBe("NOT CHECKED");
    expect(vm.driftPillTone).toBe("neutral");
  });

  it("keeps NO DRIFT green only for a detected, drift-free core", () => {
    const vm = buildCorePopoverViewModel({
      core: { hqVersion: "15.0.15", driftCount: 0, needsRestore: false },
    });
    expect(vm.driftPill).toBe("NO DRIFT");
    expect(vm.driftPillTone).toBe("ok");
    expect(driftPillTone(3, true)).toBe("warn");
  });

  it("derives the packs header count from the same list the body renders", () => {
    // Real failure shape: zero installed packs — header said "4 packs
    // installed" (fixtures) while the body said "No packs installed".
    const vm = buildCorePopoverViewModel({ packs: [] });
    expect(vm.packs).toHaveLength(0);
    expect(vm.packsSummary).toBe("No packs installed");
    const one = buildCorePopoverViewModel({ packs: [{ name: "engineering" }] });
    expect(one.packsSummary).toBe("1 pack installed");
    expect(one.packs).toHaveLength(1);
    const loading = buildCorePopoverViewModel({
      packs: [],
      packsLoading: true,
    });
    expect(loading.packsSummary).toBe("Loading…");
    expect(loading.packsLoading).toBe(true);
  });
});

describe("G7: core pill dot tone", () => {
  it("is amber whenever a conflict/attention item is pending", () => {
    expect(corePillDotTone({ conflictCount: 1 })).toBe("warn");
    expect(corePillDotTone({ syncState: "conflict" })).toBe("warn");
    expect(corePillDotTone({ syncState: "error" })).toBe("warn");
    expect(corePillDotTone({ syncState: "auth-error" })).toBe("warn");
    expect(corePillDotTone({ driftCount: 2 })).toBe("warn");
    expect(corePillDotTone({ cloudPaused: true })).toBe("warn");
  });

  it("is green only when healthy", () => {
    expect(corePillDotTone({})).toBe("ok");
    expect(corePillDotTone({ syncState: "idle", conflictCount: 0 })).toBe("ok");
    expect(corePillDotTone({ syncState: "syncing" })).toBe("ok");
  });
});
