import { describe, expect, it } from "vitest";

import { judgeRail } from "./perf/rail-budget.mjs";

const reference = {
  "coldLoad.shellReadyMs": { median: 146 },
  "coldLoad.firstContentfulPaintMs": { median: 154 },
  "bundle.jsBytes": { median: 2_486_977 },
};

describe("console rail budget", () => {
  it("passes a run inside the 10% start band with rail scenarios skipped", () => {
    const judgement = judgeRail(
      {
        "coldLoad.shellReadyMs": { median: 160, p95: 162 },
        "coldLoad.firstContentfulPaintMs": { median: 168, p95: 170 },
        "interaction.switchConversation": { median: 44, p95: 49 },
        "interaction.commandPalette": { median: 13, p95: 18 },
        "scroll.messages.droppedPct": { median: 0.5, p95: 0.6 },
        "scroll.messages.worstMs": { median: 20, p95: 22 },
        "idle.busyMs": { median: 0, p95: 0 },
        "bundle.jsBytes": { median: 2_500_000, p95: 2_500_000 },
      },
      reference,
      {
        companySwitch: { skipped: true, todo: "US-004" },
        sidepaneSwitch: { skipped: true, todo: "US-006" },
        lazyChunks: {
          atlasInInitialJs: false,
          telemetryInInitialJs: false,
          atlasBytes: 0,
          telemetryBytes: 0,
          atlasInitial: [],
          telemetryInitial: [],
        },
      },
    );
    expect(judgement.pass).toBe(true);
  });

  it("fails when Atlas is in the initial graph or shell-ready exceeds 10%", () => {
    const judgement = judgeRail(
      {
        "coldLoad.shellReadyMs": { median: 200, p95: 210 },
        "coldLoad.firstContentfulPaintMs": { median: 154, p95: 154 },
        "interaction.switchConversation": { median: 40, p95: 40 },
        "interaction.commandPalette": { median: 10, p95: 10 },
        "idle.busyMs": { median: 0, p95: 0 },
        "bundle.jsBytes": { median: 2_486_977, p95: 2_486_977 },
      },
      reference,
      {
        companySwitch: { skipped: true, todo: "US-004" },
        sidepaneSwitch: { skipped: true, todo: "US-006" },
        lazyChunks: {
          atlasInInitialJs: true,
          telemetryInInitialJs: false,
          atlasBytes: 10,
          telemetryBytes: 0,
          atlasInitial: ["packages/ui/src/atlas/Map.svelte"],
          telemetryInitial: [],
        },
      },
    );
    expect(judgement.pass).toBe(false);
    const names = judgement.checks.filter((c) => !c.pass).map((c) => c.name);
    expect(names).toContain("coldStartShellReadyMs");
    expect(names).toContain("lazyChunks.atlasAbsent");
  });

  it("keeps a noisy branch-point conversation p95 as the gate", () => {
    const judgement = judgeRail(
      {
        "coldLoad.shellReadyMs": { median: 146, p95: 150 },
        "coldLoad.firstContentfulPaintMs": { median: 154, p95: 156 },
        "interaction.switchConversation": { median: 65, p95: 124 },
        "interaction.commandPalette": { median: 16, p95: 17 },
        "idle.busyMs": { median: 0, p95: 0 },
        "bundle.jsBytes": { median: 2_486_977, p95: 2_486_977 },
      },
      {
        ...reference,
        "interaction.switchConversation": { median: 65, p95: 124 },
        "interaction.commandPalette": { median: 16, p95: 17 },
      },
      {
        companySwitch: { skipped: true, todo: "US-004" },
        sidepaneSwitch: { skipped: true, todo: "US-006" },
        lazyChunks: {
          atlasInInitialJs: false,
          telemetryInInitialJs: false,
          atlasBytes: 0,
          telemetryBytes: 0,
          atlasInitial: [],
          telemetryInitial: [],
        },
      },
    );
    expect(judgement.checks.find((c) => c.name === "switchConversationMs")?.pass).toBe(
      true,
    );
  });

  it("judges initial JS from the static graph, not lazy chunks", () => {
    const run = (initialJsBytes: number) =>
      judgeRail(
        {
          "coldLoad.shellReadyMs": { median: 146, p95: 150 },
          "coldLoad.firstContentfulPaintMs": { median: 154, p95: 156 },
          "idle.busyMs": { median: 0, p95: 0 },
          // Total JS includes lazy doors and is far over the headroom.
          "bundle.jsBytes": { median: 3_000_000, p95: 3_000_000 },
        },
        reference,
        {
          companySwitch: { skipped: true, todo: "US-004" },
          sidepaneSwitch: { skipped: true, todo: "US-006" },
          lazyChunks: {
            atlasInInitialJs: false,
            telemetryInInitialJs: false,
            atlasBytes: 0,
            telemetryBytes: 0,
            initialJsBytes,
            atlasInitial: [],
            telemetryInitial: [],
          },
        },
      ).checks.find((c) => c.name === "initialJsBytes");
    expect(run(2_486_977 + 150 * 1024)?.pass).toBe(true);
    expect(run(2_486_977 + 150 * 1024 + 1)?.pass).toBe(false);
  });
});