/**
 * OWNER-R35: helpers for the single My Telemetry page (no side nav). The
 * Models section groups exact models into families (OWNER-R29); the page
 * sections and the CSV export read from here.
 */
import { vizOrder } from "./telemetry-colors.js";
import { compactNumber } from "../common/compact-number.js";
import { SYSTEM_MODEL_NOTE } from "./telemetry-me.js";
import type { TelemetrySnapshot } from "./telemetry-model.js";
import type { LocalSessionRow } from "./telemetry-local-sessions.js";
import { formatMoney, modelFamilies, type ExactModelUsage, type ModelFamilyUsage } from "./telemetry-models.js";

/** Sections in page order. Outcomes stays unmounted (OWNER-R30). */
export const TELEMETRY_SECTIONS = ["totals", "tokens-per-day", "models", "skills", "sessions"] as const;
export type TelemetrySection = (typeof TELEMETRY_SECTIONS)[number];

/**
 * The old sub-pages had their own nav entries. Each now lands on the page with
 * its matching section scrolled into view; Outcomes lands on Totals, where the
 * real shipped and deploy counts are.
 */
export function sectionForOldPage(page: string | null | undefined): TelemetrySection {
  switch (page) {
    case "sessions":
      return "sessions";
    case "tokens":
      return "models";
    case "skills":
      return "skills";
    default:
      return "totals";
  }
}

export const TOP_SKILLS = 10;
export const RECENT_SESSIONS = 10;

/** Families with exact models, from the snapshot's per-model read. */
export function familiesFor(snapshot: TelemetrySnapshot): ModelFamilyUsage[] {
  // Same fixed provider-then-shade order as the chart's stacks and legend.
  return vizOrder(familyRows(snapshot), (f) => f.family);
}

function familyRows(snapshot: TelemetrySnapshot): ModelFamilyUsage[] {
  if (snapshot.exactModels?.length) return modelFamilies(snapshot.exactModels);
  // Sources without exact ids (the offline fixture) list their family rows.
  return snapshot.models.map((m) => {
    const total = m.input + m.output + m.cacheWrite + m.cacheRead;
    return {
      family: m.label,
      provider: "",
      models: [],
      input: m.input,
      output: m.output,
      cacheWrite: m.cacheWrite,
      cacheRead: m.cacheRead,
      total,
      costUsd: null,
    };
  });
}

export function familyNote(family: string): string {
  return family === "System" ? SYSTEM_MODEL_NOTE : "";
}

/** "input 1.2M · output 40K · cache write 3K · cache read 9M" for a hover. */
export function tokenTypes(t: { input: number; output: number; cacheWrite: number; cacheRead: number }): string {
  return [
    `input ${compactNumber(t.input)}`,
    `output ${compactNumber(t.output)}`,
    `cache write ${compactNumber(t.cacheWrite)}`,
    `cache read ${compactNumber(t.cacheRead)}`,
  ].join(" · ");
}

/** Every exact model, largest first, for the By model view. */
export function flatModels(families: readonly ModelFamilyUsage[]): ExactModelUsage[] {
  return families.flatMap((f) => f.models).sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
}

const cell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;

/** CSV of what the page shows: totals, models, skills and local sessions. */
export function pageCsv(
  snapshot: TelemetrySnapshot,
  families: readonly ModelFamilyUsage[],
  sessions: readonly LocalSessionRow[],
): string {
  const lines: string[] = [["section", "name", "detail", "value", "cost"].map(cell).join(",")];
  const add = (...row: (string | number)[]) => lines.push(row.map(cell).join(","));
  add("totals", "sessions", snapshot.rangeLabel, snapshot.sessions, "");
  add("totals", "tokens", snapshot.rangeLabel, snapshot.tokensLabel, "");
  add("totals", "stories shipped", snapshot.rangeLabel, snapshot.storiesShipped, "");
  add("totals", "deploys", snapshot.rangeLabel, snapshot.deploys, "");
  add("totals", "distinct skills", snapshot.rangeLabel, snapshot.distinctSkills, "");
  for (const f of families) {
    add("model family", f.family, f.provider, f.total, formatMoney(f.costUsd));
    for (const m of f.models) add("model", m.name, m.id, m.total, formatMoney(m.costUsd));
  }
  for (const s of snapshot.skills) add("skill", s.name, "", s.count, "");
  for (const s of sessions) add("session on this Mac", s.title, [s.when, s.company, s.project, s.length].filter(Boolean).join(" · "), "", "");
  return lines.join("\n");
}
