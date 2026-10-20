import type { BriefSweepSource } from "./brief-data.js";
import { briefRunPath } from "./brief-runs.js";
import { parseWelcomeFields, type WelcomeBriefFields } from "./brief-welcome-contract.js";

export interface BriefWelcome {
  skills: number;
  conversations: number;
  sessions: number;
  apps: string[];
  connectCompany: boolean;
  gettingStarted?: string;
  nextSteps?: string[];
  error?: string;
  /** The contract fields the welcome edition draws from (brief-welcome-contract.ts). */
  fields: WelcomeBriefFields;
  /** The brief.json `welcome` object as read, for the first view's model (brief-first-view.ts). */
  raw?: Record<string, unknown>;
}
const object = (value: unknown): Record<string, unknown> | null => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** Welcome is optional. A failed enrichment must never hide the useful brief. */
export function parseWelcome(value: unknown): BriefWelcome | null {
  const row = object(value);
  if (!row) return null;
  const fields = parseWelcomeFields(row);
  if (row.first_run !== true && typeof row.getting_started !== "string" && typeof row.error !== "string" && !Object.keys(fields).some((k) => k !== "sessions")) return null;
  const imported = object(row.import);
  const sessions = object(row.sessions);
  return {
    fields,
    raw: row,
    skills: count(imported?.skills),
    conversations: count(imported?.conversations),
    sessions: count(sessions?.total),
    apps: Array.isArray(row.apps) ? row.apps.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [],
    connectCompany: typeof row.getting_started === "string" || (Array.isArray(row.next_steps) && row.next_steps.some(v => object(v)?.kind === "connect_company")),
    ...(typeof row.getting_started === "string" ? {gettingStarted: row.getting_started} : {}),
    ...(typeof row.error === "string" ? {error: row.error.replace(/\s+/g, " ").trim()} : {}),
    ...(Array.isArray(row.next_steps) && row.next_steps.some(v => typeof object(v)?.reason === "string") ? { nextSteps: row.next_steps.map(v => object(v)?.reason).filter((v): v is string => typeof v === "string") } : {}),
  };
}

export interface BriefFailedCompany { company: string; label?: string }
export async function readRunFailedCompanies(source: BriefSweepSource, runId: string): Promise<BriefFailedCompany[]> {
  const failed = new Map<string, BriefFailedCompany>();
  for (const name of ["brief.json", "brief-data.json"] as const) {
    try {
      const text = await source.readHqFile(briefRunPath(runId, name));
      const sections = text ? object(object(JSON.parse(text))?.companies) : null;
      for (const [company, section] of Object.entries(sections ?? {})) {
        const row = object(section);
        if (row?.error) {
          const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : failed.get(company)?.label;
          failed.set(company, { company, ...(label ? {label} : {}) });
        }
      }
    } catch { /* A partial run can still have useful sections. */ }
  }
  return [...failed.values()];
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
