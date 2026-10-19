/**
 * The first view's reads: the shown run's raw `welcome` row and the newest
 * import report. Both are optional enrichment; a failed read is null and the
 * brief renders without it.
 */

import type { ImportReportApi } from "@hq/platform";

import type { BriefSweepSource } from "./brief-data.js";
import { parseImportReport, type FirstViewInput, type ImportReport } from "./brief-first-view.js";
import { briefRunPath } from "./brief-runs.js";

/** What the first view reads from disk; `buildFirstView` takes it with the host's own fields. */
export type FirstViewData = Pick<FirstViewInput, "welcome" | "importReport">;

const object = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The newest import report through the host, parsed; null with no host, no report, or a failed read. */
export async function readLatestImportReport(api: Pick<ImportReportApi, "latest"> | null | undefined): Promise<ImportReport | null> {
  if (!api) return null;
  try {
    const result = await api.latest();
    return result.ok ? parseImportReport(result.value) : null;
  } catch {
    return null;
  }
}

/** The run's brief.json `welcome` row as written (Core 1432 or 16.0.30 shape), or null. */
export async function readRunWelcomeRow(source: BriefSweepSource, runId: string): Promise<Record<string, unknown> | null> {
  for (const name of ["brief.json", "brief-data.json"] as const) {
    try {
      const text = await source.readHqFile(briefRunPath(runId, name));
      const welcome = text ? object(object(JSON.parse(text))?.welcome) : null;
      if (welcome) return welcome;
    } catch {
      /* Optional enrichment; keep rendering the run. */
    }
  }
  return null;
}
