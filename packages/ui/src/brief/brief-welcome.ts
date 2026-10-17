import type { BriefSweepSource } from "./brief-data.js";
import { briefRunPath } from "./brief-runs.js";

export interface BriefWelcome {
  skills: number;
  conversations: number;
  sessions: number;
  apps: string[];
  connectCompany: boolean;
  gettingStarted?: string;
  nextSteps?: string[];
}
const object = (value: unknown): Record<string, unknown> | null => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** Welcome is optional. A failed enrichment must never hide the useful brief. */
export function parseWelcome(value: unknown): BriefWelcome | null {
  const row = object(value);
  if (!row || row.error || (row.first_run !== true && typeof row.getting_started !== "string")) return null;
  const imported = object(row.import);
  const sessions = object(row.sessions);
  return {
    skills: count(imported?.skills),
    conversations: count(imported?.conversations),
    sessions: count(sessions?.total),
    apps: Array.isArray(row.apps) ? row.apps.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [],
    connectCompany: Array.isArray(row.next_steps) && row.next_steps.some(v => object(v)?.kind === "connect_company"),
    ...(typeof row.getting_started === "string" ? {gettingStarted: row.getting_started} : {}),
    ...(Array.isArray(row.next_steps) && row.next_steps.some(v => typeof object(v)?.reason === "string") ? { nextSteps: row.next_steps.map(v => object(v)?.reason).filter((v): v is string => typeof v === "string") } : {}),
  };
}

export async function readRunWelcome(source: BriefSweepSource, runId: string): Promise<BriefWelcome | null> {
  for (const name of ["brief.json", "brief-data.json"] as const) {
    try {
      const text = await source.readHqFile(briefRunPath(runId, name));
      if (text) {
        const welcome = parseWelcome(object(JSON.parse(text))?.welcome);
        if (welcome) return welcome;
      }
    } catch { /* Optional enrichment; keep rendering the run. */ }
  }
  return null;
}

export interface BriefExclusion { company: string; reason: string }
export function parseExclusions(value: unknown): BriefExclusion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const row = object(entry);
    return typeof row?.company === "string" && typeof row.reason === "string"
      ? [{company: row.company, reason: row.reason}] : [];
  });
}
export async function readRunExclusions(source: BriefSweepSource, runId: string): Promise<BriefExclusion[]> {
  for (const name of ["brief.json", "brief-data.json"] as const) {
    try {
      const text = await source.readHqFile(briefRunPath(runId, name));
      const row = text ? object(JSON.parse(text)) : null;
      if (Array.isArray(row?.not_included)) return parseExclusions(row.not_included);
    } catch { /* Optional metadata does not prevent the brief from rendering. */ }
  }
  return [];
}
