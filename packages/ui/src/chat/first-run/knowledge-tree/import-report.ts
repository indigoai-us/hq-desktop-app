/**
 * The tree step's import report input: what the first view reads after the
 * scan ("N sessions over N days", the top threads). The host writes it to
 * `workspace/imports/<stamp>/report.json`; this module only builds the input,
 * from whichever scan ran, in one shape for both.
 *
 * Counts, tool ids, times and project names only. A project name must pass
 * `welcomeName` (no paths, filenames or credentials); nothing from a
 * transcript is read or kept.
 */

import type { ImportReportInput, LocalScanView } from "@hq/platform";

import { welcomeName } from "../../../brief/brief-welcome-names.js";
import type { ImportScanEnd, ImportScanHost } from "./import-runner.js";
import { parseScanLine, type ScanEvent } from "./scan-stream.js";

/** The tools a report names, in its order. */
export const IMPORT_REPORT_TOOLS = ["claude-code", "codex", "cursor"] as const;
type ReportTool = (typeof IMPORT_REPORT_TOOLS)[number];

/** The report's 12 count keys; the done summary may carry any of them. */
export const IMPORT_REPORT_COUNT_KEYS = [
  "plans",
  "commands",
  "skills",
  "hooks",
  "policies",
  "agents",
  "claude_md",
  "settings_fragments",
  "mcp_servers",
  "knowledge_dirs",
  "claude_repos",
  "conversations",
] as const;

/** The most project names a report keeps (the host caps it again). */
export const IMPORT_REPORT_PROJECTS = 10;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function time(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Names that pass `welcomeName`, deduped without regard to case, at most the cap. */
function projectNames(names: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = typeof raw === "string" ? welcomeName(raw, 80) : null;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= IMPORT_REPORT_PROJECTS) break;
  }
  return out;
}

function toolsWith(sessions: Record<ReportTool, number>): string[] {
  return IMPORT_REPORT_TOOLS.filter((t) => sessions[t] > 0);
}

/**
 * The native launch scan's report input. The scan reads Claude Code and
 * Codex session files only, so Cursor is 0 (no Cursor workspace was scanned).
 * Days and first/last times are the session files' own times.
 */
export function importReportInputFromScan(scan: LocalScanView): ImportReportInput {
  const tools = Array.isArray(scan.tools) ? scan.tools : [];
  const of = (id: string) => tools.find((t) => t && t.tool === id);
  const sessions: Record<ReportTool, number> = {
    "claude-code": count(of("claude-code")?.sessions_total),
    codex: count(of("codex")?.sessions_total),
    cursor: 0,
  };
  const lasts = tools.map((t) => time(t?.last_active_at)).filter((t): t is number => t !== null);
  const projects = (Array.isArray(scan.projects) ? scan.projects : [])
    .filter((p) => p && typeof p.name === "string")
    .slice()
    .sort((a, b) => count(b.sessions) - count(a.sessions))
    .map((p) => p.name);
  const total = sessions["claude-code"] + sessions.codex;
  return {
    sessions: {
      total,
      claude: sessions["claude-code"],
      codex: sessions.codex,
      cursor: 0,
      days_seen: typeof scan.days_seen === "number" && Number.isFinite(scan.days_seen) ? count(scan.days_seen) : null,
      first_at: time(scan.first_active_at),
      last_at: lasts.length ? Math.max(...lasts) : null,
    },
    tools: toolsWith(sessions),
    projects: projectNames(projects),
    counts: { mcp_servers: Array.isArray(scan.mcp_servers) ? scan.mcp_servers.length : 0 },
  };
}

/**
 * The hq-cli import scan's report input, from its stream events. That scan
 * reports session counts per source and no times, so days and first/last are
 * null. Cursor is counted only when the scan named a Cursor source.
 */
export function importReportInputFromEvents(events: readonly ScanEvent[]): ImportReportInput {
  const sessions: Record<ReportTool, number> = { "claude-code": 0, codex: 0, cursor: 0 };
  const note = (source: string, value: number) => {
    if ((IMPORT_REPORT_TOOLS as readonly string[]).includes(source)) {
      const id = source as ReportTool;
      sessions[id] = Math.max(sessions[id], value);
    }
  };
  const names: string[] = [];
  let summary: Record<string, number> = {};
  for (const event of events) {
    if (event.type === "count" && event.key === "sessions") note(event.source, event.value);
    else if (event.type === "source" && event.counts && typeof event.counts.sessions === "number") note(event.id, event.counts.sessions);
    else if (event.type === "project") names.push(event.name);
    else if (event.type === "done") summary = event.summary;
  }
  const sum = sessions["claude-code"] + sessions.codex + sessions.cursor;
  const counts: Partial<Record<string, number>> = {};
  for (const key of IMPORT_REPORT_COUNT_KEYS) if (key in summary) counts[key] = count(summary[key]);
  return {
    sessions: {
      total: Math.max(sum, count(summary.sessions)),
      claude: sessions["claude-code"],
      codex: sessions.codex,
      cursor: sessions.cursor,
      days_seen: null,
      first_at: null,
      last_at: null,
    },
    tools: toolsWith(sessions),
    projects: projectNames(names),
    counts,
  };
}

/**
 * A host that hands every finished scan's events to `ondone`, so the hq-cli
 * fallback can write its report. Only a scan that ended "done" with a done
 * line counts; a failed, cancelled or cut-short scan writes nothing.
 */
export function tapImportHost(host: ImportScanHost | null, ondone: (events: ScanEvent[]) => void): ImportScanHost | null {
  if (!host) return null;
  return {
    async run(scanId, onevent): Promise<ImportScanEnd | null | undefined> {
      const events: ScanEvent[] = [];
      const end = await host.run(scanId, (raw) => {
        const event = parseScanLine(raw);
        if (event) events.push(event);
        onevent(raw);
      });
      if (end?.status === "done" && events.some((e) => e.type === "done")) {
        try {
          ondone(events);
        } catch (err) {
          console.warn("[first-run] import report listener threw:", err);
        }
      }
      return end;
    },
    cancel: (scanId) => host.cancel(scanId),
  };
}
