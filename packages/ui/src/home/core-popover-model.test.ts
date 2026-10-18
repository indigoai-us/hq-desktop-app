import { describe, expect, it } from "vitest";
import {
  appVersionLabel,
  buildCorePopoverViewModel,
  CLOUD_PAUSED_NOTICE,
  coreNeedsRestore,
  detectedCoreVersion,
  driftPillLabel,
  hqVersionLabel,
  isSyncNowAllowed,
  packsSummaryLabel,
  parseInstalledPacks,
} from "./core-popover-model";
import { packDisplayName } from "./pack-display-name";

describe("core-popover-model (US-016)", () => {
  describe("detectedCoreVersion", () => {
    it("does not report a CLI-only install as HQ Core", () => {
      expect(detectedCoreVersion({ cli: "0.9.0" })).toBeNull();
      expect(detectedCoreVersion({ core: "15.0.15", cli: "0.9.0" })).toBe(
        "15.0.15",
      );
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

    // usage-only-pricing US-016: with the Settings Cloud switch off the header
    // must not claim "All synced" or "Syncing".
    it("the sync header reads Cloud off while the switch is off", () => {
      for (const syncState of ["idle", "syncing", "conflict", "error"]) {
        const vm = buildCorePopoverViewModel({
          cloudPaused: true,
          syncState,
        });
        expect(vm.syncHeader.stateWord).toBe("Cloud off");
        expect(vm.syncHeader.tone).toBe("warn");
        expect(vm.syncHeader.syncing).toBe(false);
      }
      const on = buildCorePopoverViewModel({ cloudPaused: false, syncState: "idle" });
      expect(on.syncHeader.stateWord).toBe("All synced");
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

  it("parseInstalledPacks accepts both wire shapes", () => {
    expect(
      parseInstalledPacks({
        packs: {
          installed: [
            { name: " engineering ", version: "1.4.0" },
            { name: "gstack", version: "2.1.0" },
          ],
        },
      }),
    ).toEqual([
      { name: "engineering", version: "1.4.0" },
      { name: "gstack", version: "2.1.0" },
    ]);
    expect(
      parseInstalledPacks([
        { name: "engineering", version: "1.4.0" },
        { name: "gstack", version: "2.1.0" },
      ]),
    ).toEqual([
      { name: "engineering", version: "1.4.0" },
      { name: "gstack", version: "2.1.0" },
    ]);
  });

  it("parseInstalledPacks returns empty for empty and malformed input", () => {
    expect(parseInstalledPacks(undefined)).toEqual([]);
    expect(parseInstalledPacks(null)).toEqual([]);
    expect(parseInstalledPacks({})).toEqual([]);
    expect(parseInstalledPacks({ packs: { installed: [] } })).toEqual([]);
    expect(parseInstalledPacks({ packs: { installed: "nope" } })).toEqual([]);
    expect(parseInstalledPacks("engineering")).toEqual([]);
    expect(parseInstalledPacks(5)).toEqual([]);
    expect(
      parseInstalledPacks({
        packs: {
          installed: [
            null,
            { name: "  " },
            { name: "ok", version: "1.0.0" },
            { version: "2.0.0" },
          ],
        },
      }),
    ).toEqual([{ name: "ok", version: "1.0.0" }]);
  });
});

describe("G7: core pill dot tone", () => {
  it("is amber whenever an attention item is pending", () => {
    expect(corePillDotTone({ syncState: "error" })).toBe("warn");
    expect(corePillDotTone({ syncState: "auth-error" })).toBe("warn");
    expect(corePillDotTone({ driftCount: 2 })).toBe("warn");
    expect(corePillDotTone({ cloudPaused: true })).toBe("warn");
  });

  it("is green only when healthy and nothing is running", () => {
    expect(corePillDotTone({})).toBe("ok");
    expect(corePillDotTone({ syncState: "idle" })).toBe("ok");
    // A parked sync conflict is not an attention item (owner decision 2026-10-13).
    expect(corePillDotTone({ syncState: "conflict" })).toBe("ok");
  });

  // PL-01: a healthy run in flight used to read green, which made the pill
  // silent about the one moment the user most wants to see. It now gets its
  // own tone — still not amber, because a running sync is not trouble.
  it("reads as active, not green, while a healthy sync runs", () => {
    expect(corePillDotTone({ syncState: "syncing" })).toBe("active");
  });
});

describe("core checking state (owner bug: healthy install shown as not detected)", () => {
  it("labels an in-flight check as checking, never as not detected", () => {
    const vm = buildCorePopoverViewModel({
      core: { hqVersion: null, driftCount: 0, needsRestore: false },
      coreChecking: true,
    });
    expect(vm.hqVersionLabel).toBe("Checking HQ core\u2026");
    expect(vm.driftPill).toBe("CHECKING");
    expect(vm.driftPillTone).toBe("neutral");
    expect(vm.coreDetected).toBe(false);
  });

  it("only claims not detected after the check resolved without a version", () => {
    const vm = buildCorePopoverViewModel({
      core: { hqVersion: null, driftCount: 0, needsRestore: false },
      coreChecking: false,
    });
    expect(vm.hqVersionLabel).toBe("HQ core not detected");
    expect(vm.driftPill).toBe("NOT CHECKED");
  });

  it("a detected version wins over a stale checking flag", () => {
    const vm = buildCorePopoverViewModel({
      core: { hqVersion: "15.0.118", driftCount: 0, needsRestore: false },
      coreChecking: true,
    });
    expect(vm.hqVersionLabel).toBe("HQ core v15.0.118");
    expect(vm.driftPill).toBe("NO DRIFT");
    expect(vm.driftPillTone).toBe("ok");
    expect(vm.coreDetected).toBe(true);
  });

  it("driftPillLabel/hqVersionLabel expose the checking arm directly", () => {
    expect(driftPillLabel(0, false, true)).toBe("CHECKING");
    expect(driftPillLabel(3, true, true)).toBe("3 drifted");
    expect(hqVersionLabel(null, true)).toBe("Checking HQ core\u2026");
    expect(hqVersionLabel(null, false)).toBe("HQ core not detected");
  });
});

describe("parseInstalledPacks displayName / old cache", () => {
  it("carries a string displayName through from the wire", () => {
    expect(
      parseInstalledPacks([
        { name: "hq-pack-foo", version: "1.0.0", displayName: "Foo Pack" },
      ]),
    ).toEqual([
      { name: "hq-pack-foo", version: "1.0.0", displayName: "Foo Pack" },
    ]);
  });

  it("carries a string title through as displayName when displayName is absent", () => {
    expect(
      parseInstalledPacks([
        { name: "hq-pack-foo", version: "1.0.0", title: "Foo Title" },
      ]),
    ).toEqual([
      { name: "hq-pack-foo", version: "1.0.0", displayName: "Foo Title" },
    ]);
  });

  it("prefers displayName over title and ignores non-string hosted fields", () => {
    expect(
      parseInstalledPacks([
        {
          name: "hq-pack-foo",
          version: "1.0.0",
          displayName: "From displayName",
          title: "From title",
        },
      ]),
    ).toEqual([
      {
        name: "hq-pack-foo",
        version: "1.0.0",
        displayName: "From displayName",
      },
    ]);
    expect(
      parseInstalledPacks([
        { name: "hq-pack-foo", version: "1.0.0", displayName: 12, title: true },
      ]),
    ).toEqual([{ name: "hq-pack-foo", version: "1.0.0" }]);
  });

  it("old-cache rows with only name+version still derive a display name, never blank", () => {
    const packs = parseInstalledPacks([
      { name: "hq-pack-client-service", version: "1.2.0" },
    ]);
    expect(packs).toEqual([
      { name: "hq-pack-client-service", version: "1.2.0" },
    ]);
    expect(packs[0]).not.toHaveProperty("displayName");
    const derived = packDisplayName(packs[0]!);
    expect(derived).toBe("Client Service");
    expect(derived).not.toBe("");
  });
});

describe("syncOffNotice (US-016)", () => {
  it("names the vaults whose own switch is off, personal first", async () => {
    const { syncOffNotice } = await import("./core-popover-model");
    const ws = [
      { slug: "zeta", displayName: "Zeta", kind: "company", cloudUid: "cmp_z", syncEnabled: false },
      { slug: "personal", kind: "personal", syncEnabled: false },
      { slug: "acme", displayName: "Acme", kind: "company", cloudUid: "cmp_a", syncEnabled: false },
      { slug: "on", displayName: "On", kind: "company", cloudUid: "cmp_o", syncEnabled: true },
      { slug: "local", displayName: "Local", kind: "company", cloudUid: null, syncEnabled: false },
    ];
    expect(syncOffNotice(ws, false)).toBe(
      "Sync is off for your personal vault, Zeta and Acme on this computer.",
    );
    expect(syncOffNotice([ws[2]!], false)).toBe("Sync is off for Acme on this computer.");
    expect(syncOffNotice(ws, true)).toBeNull();
    expect(syncOffNotice([ws[3]!], false)).toBeNull();
    expect(syncOffNotice(null, false)).toBeNull();
  });
});
