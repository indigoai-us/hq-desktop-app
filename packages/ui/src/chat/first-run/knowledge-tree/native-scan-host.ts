/**
 * The native launch scan as an `ImportScanHost`: one `scan_local_sessions`
 * call (counts, names and recency only, read by the desktop host without
 * hq-cli) turned into the same v1 stream events the knowledge tree already
 * draws. Null when the host has no native scan (the web build), so the
 * caller can fall back to the hq-cli import.
 */

import type { LocalScanApi, LocalScanView } from "@hq/platform";

import type { ImportScanEnd, ImportScanHost } from "./import-runner.js";
import { SCAN_LIMITS, SCAN_STREAM_VERSION } from "./scan-stream.js";

/** The sources the start line names, in the order the tree shows them. */
export const NATIVE_SCAN_SOURCES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "repos", label: "Repos" },
  { id: "apps", label: "Apps" },
] as const;

/** Ids remembered as cancelled before (or while) their scan ran. */
const MAX_EARLY_CANCELS = 16;

type SourceStatus = "done" | "skipped" | "error";

/** A host source outcome to the row status the tree shows. */
function statusOf(outcome: string | undefined): SourceStatus {
  if (outcome === "read" || outcome === "budget") return "done";
  if (outcome === "unreadable") return "error";
  return "skipped";
}

/** A name to an id part the stream accepts: lowercase, safe characters only. */
function idPart(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return slug.slice(0, SCAN_LIMITS.idLength - 16) || "project";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * The stream events for one finished native scan. Pure, so the tree's input
 * can be tested without a host.
 */
export function nativeScanEvents(scan: LocalScanView): Record<string, unknown>[] {
  const v = SCAN_STREAM_VERSION;
  const events: Record<string, unknown>[] = [{ v, type: "start", sources: NATIVE_SCAN_SOURCES.map((s) => ({ ...s })) }];
  const outcomes = new Map<string, string>();
  for (const s of Array.isArray(scan.sources) ? scan.sources : []) outcomes.set(s.source, s.outcome);
  const tools = Array.isArray(scan.tools) ? scan.tools : [];
  const projects = Array.isArray(scan.projects) ? scan.projects : [];
  const repos = Array.isArray(scan.repos) ? scan.repos : [];
  const apps = Array.isArray(scan.apps) ? scan.apps : [];
  const mcpServers = Array.isArray(scan.mcp_servers) ? scan.mcp_servers : [];

  let sessions = 0;
  for (const id of ["claude-code", "codex"] as const) {
    const tool = tools.find((t) => t.tool === id);
    const total = count(tool?.sessions_total);
    const recent = count(tool?.sessions_last_30d);
    sessions += total;
    events.push({ v, type: "count", source: id, key: "sessions", value: total });
    events.push({
      v,
      type: "source",
      id,
      status: statusOf(outcomes.get(id)),
      counts: { sessions: total, recent },
      message: null,
    });
  }

  const seen = new Set<string>();
  const projectEvents: Record<string, unknown>[] = [];
  for (const p of projects) {
    if (!p || typeof p.name !== "string" || !p.name.trim()) continue;
    const basis = p.tool === "codex" ? "codex-cwd" : "claude-code-cwd";
    const key = p.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projectEvents.push({ v, type: "project", id: `${p.tool === "codex" ? "codex" : "claude-code"}:${idPart(p.name)}`, name: p.name, company: null, basis });
  }
  for (const r of repos) {
    const name = r && typeof r.path === "string" ? folderName(r.path) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projectEvents.push({ v, type: "project", id: `repo:${idPart(name)}`, name, company: null, basis: "repo" });
  }
  events.push(...projectEvents);

  events.push({ v, type: "count", source: "repos", key: "repos", value: repos.length });
  events.push({ v, type: "source", id: "repos", status: statusOf(outcomes.get("repos")), counts: { repos: repos.length }, message: null });
  events.push({ v, type: "count", source: "apps", key: "apps", value: apps.length });
  events.push({
    v,
    type: "source",
    id: "apps",
    status: statusOf(outcomes.get("apps")),
    counts: { apps: apps.length, mcp_servers: mcpServers.length },
    message: null,
  });

  // No report: the handoff reads `report` as an HQ-relative file path, and
  // this scan writes none. `sources` is always non-zero, so an empty
  // computer still reads as a scan that ran (`isScanNotRun` is false).
  events.push({
    v,
    type: "done",
    report: null,
    summary: {
      projects: projectEvents.length,
      sessions,
      repos: repos.length,
      apps: apps.length,
      sources: NATIVE_SCAN_SOURCES.length,
    },
  });
  return events;
}

export function createNativeScanHost(api: LocalScanApi | null | undefined): ImportScanHost | null {
  if (!api) return null;
  const cancelled: string[] = [];
  const takeCancelled = (scanId: string) => {
    const at = cancelled.indexOf(scanId);
    if (at < 0) return false;
    cancelled.splice(at, 1);
    return true;
  };
  return {
    async run(scanId, onevent): Promise<ImportScanEnd> {
      if (takeCancelled(scanId)) return { status: "cancelled" };
      let scan: LocalScanView;
      try {
        const result = await api.scan();
        if (!result.ok) {
          console.warn("[first-run] native scan failed:", result.reason, result.code ?? "", result.message ?? "");
          return { status: "failed" };
        }
        scan = result.value;
      } catch (err) {
        console.warn("[first-run] native scan threw:", err);
        return { status: "failed" };
      }
      // The host scan cannot be stopped mid-walk (it is bounded at 8 s);
      // a cancel that landed meanwhile drops its result here.
      if (takeCancelled(scanId)) return { status: "cancelled" };
      for (const event of nativeScanEvents(scan)) onevent(event);
      return { status: "done" };
    },
    cancel(scanId) {
      if (!cancelled.includes(scanId)) {
        if (cancelled.length >= MAX_EARLY_CANCELS) cancelled.shift();
        cancelled.push(scanId);
      }
    },
  };
}
