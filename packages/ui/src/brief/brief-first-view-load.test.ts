import { describe, expect, it } from "vitest";

import type { ImportReportApi } from "@hq/platform";

import { buildFirstView } from "./brief-first-view.js";
import { readLatestImportReport, readRunWelcomeRow } from "./brief-first-view-load.js";
import desktopReport from "./fixtures/import-report-desktop.json";
import legacy from "./fixtures/welcome-16030-legacy.json";

const api = (latest: ImportReportApi["latest"]): ImportReportApi => ({
  write: async () => ({ ok: false, reason: "unavailable", code: "unused" }),
  latest,
});

describe("readLatestImportReport", () => {
  it("parses the host's newest report", async () => {
    const report = await readLatestImportReport(api(async () => ({ ok: true, value: desktopReport.report as Record<string, unknown> })));
    expect(report?.sessions?.total).toBe(desktopReport.report.sessions.total);
    expect(report?.tools.length).toBeGreaterThan(0);
  });

  it("no host, no report, a failed read or a throw is null", async () => {
    expect(await readLatestImportReport(null)).toBeNull();
    expect(await readLatestImportReport(undefined)).toBeNull();
    expect(await readLatestImportReport(api(async () => ({ ok: true, value: null })))).toBeNull();
    expect(await readLatestImportReport(api(async () => ({ ok: false, reason: "error", code: "io", message: "denied" })))).toBeNull();
    expect(
      await readLatestImportReport(
        api(async () => {
          throw new Error("host gone");
        }),
      ),
    ).toBeNull();
  });
});

describe("readRunWelcomeRow", () => {
  const RUN = "brief-20261019-090000";

  it("answers brief.json's welcome row as written", async () => {
    const row = await readRunWelcomeRow({ readHqFile: async (p) => (p.endsWith("/brief.json") ? JSON.stringify(legacy) : null) }, RUN);
    expect(row).toEqual(legacy.welcome);
  });

  it("falls back to the sweep's brief-data.json, and is null with neither or bad JSON", async () => {
    const fromSweep = await readRunWelcomeRow(
      { readHqFile: async (p) => (p.endsWith("brief-data.json") ? JSON.stringify({ welcome: { first_run: true } }) : "{not json") },
      RUN,
    );
    expect(fromSweep).toEqual({ first_run: true });
    expect(await readRunWelcomeRow({ readHqFile: async () => JSON.stringify({ welcome: [1] }) }, RUN)).toBeNull();
    expect(await readRunWelcomeRow({ readHqFile: async () => null }, RUN)).toBeNull();
  });

  it("the two reads feed buildFirstView", async () => {
    const welcome = await readRunWelcomeRow({ readHqFile: async () => JSON.stringify(legacy) }, RUN);
    const importReport = await readLatestImportReport(api(async () => ({ ok: true, value: desktopReport.report as Record<string, unknown> })));
    const view = buildFirstView({ welcome, importReport, now: "2026-10-19T09:00:00Z" });
    expect(view.cardOrder).toEqual(["sunrise", "connect", "oneThing", "recentWork"]);
    expect(view.count).toBe(402);
    expect(view.pills).toEqual({ sessions: 402, days: 37, projects: 3, tools: 2 });
  });
});
