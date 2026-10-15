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

/** A parent folder reads as a company once it holds this many repos. */
export const MIN_REPOS_PER_FOLDER = 2;

/**
 * The folder a repo sits in, when that folder can stand for a company: not a
 * home folder (`/Users/<name>/repo`, `/home/<name>/repo`) and not the root.
 * The hq-cli scan grouped repos the same way (its "folder" company basis);
 * the native scan has no git remotes, so the folder is the one grouping it
 * can offer. Without it every project landed on the tree's one "other" limb
 * and the tree lost its company limbs (owner run 2026-10-15).
 */
export function companyFolderOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length < 3) return "";
  const parent = parts[parts.length - 2] ?? "";
  const grand = (parts[parts.length - 3] ?? "").toLowerCase();
  if (grand === "users" || grand === "home") return "";
  if (GENERIC_CODE_FOLDERS.has(parent.toLowerCase())) return "";
  return parent;
}

/** Folders people keep all their code in: a limb named "dev" would say nothing. */
const GENERIC_CODE_FOLDERS = new Set([
  "dev", "code", "repos", "repo", "src", "source", "sources", "projects", "project", "work", "workspace", "workspaces",
  "git", "github", "gitlab", "documents", "desktop", "developer", "development", "sites", "www", "tmp", "scratch",
]);

/** Folder-basis company events and the company id each repo path belongs to. */
export function folderCompanies(repos: readonly { path: string }[]): {
  companies: { id: string; name: string }[];
  byPath: Map<string, string>;
} {
  const folders = new Map<string, { name: string; paths: string[] }>();
  for (const r of repos) {
    if (!r || typeof r.path !== "string") continue;
    const name = companyFolderOf(r.path);
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = folders.get(key) ?? { name, paths: [] };
    entry.paths.push(r.path);
    folders.set(key, entry);
  }
  const companies: { id: string; name: string }[] = [];
  const byPath = new Map<string, string>();
  for (const { name, paths } of folders.values()) {
    if (paths.length < MIN_REPOS_PER_FOLDER) continue;
    const id = `folder:${idPart(name)}`;
    companies.push({ id, name });
    for (const path of paths) byPath.set(path, id);
  }
  return { companies, byPath };
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

  // Companies first (a limb each on the tree), then the projects on them. A
  // session project whose name matches a repo folder sits on that repo's limb.
  const { companies, byPath } = folderCompanies(repos);
  for (const c of companies) events.push({ v, type: "company", id: c.id, name: c.name, basis: "folder" });
  const companyByFolder = new Map<string, string>();
  for (const r of repos) {
    const name = r && typeof r.path === "string" ? folderName(r.path) : "";
    const company = name ? byPath.get(r.path) : undefined;
    if (name && company && !companyByFolder.has(name.toLowerCase())) companyByFolder.set(name.toLowerCase(), company);
  }

  const seen = new Set<string>();
  const projectEvents: Record<string, unknown>[] = [];
  for (const p of projects) {
    if (!p || typeof p.name !== "string" || !p.name.trim()) continue;
    const basis = p.tool === "codex" ? "codex-cwd" : "claude-code-cwd";
    const key = p.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const company = companyByFolder.get(key) ?? null;
    projectEvents.push({ v, type: "project", id: `${p.tool === "codex" ? "codex" : "claude-code"}:${idPart(p.name)}`, name: p.name, company, basis });
  }
  for (const r of repos) {
    const name = r && typeof r.path === "string" ? folderName(r.path) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projectEvents.push({ v, type: "project", id: `repo:${idPart(name)}`, name, company: byPath.get(r.path) ?? null, basis: "repo" });
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
      companies: companies.length,
      projects: projectEvents.length,
      sessions,
      repos: repos.length,
      apps: apps.length,
      sources: NATIVE_SCAN_SOURCES.length,
    },
  });
  return events;
}

/**
 * `onscan` gets the finished scan before its events go out, so the first run
 * can read which coding tool the person uses most (US-007) without a second
 * scan or a model turn.
 */
export function createNativeScanHost(
  api: LocalScanApi | null | undefined,
  onscan?: ((scan: LocalScanView) => void) | null,
): ImportScanHost | null {
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
        if (!scan || typeof scan !== "object" || !Array.isArray(scan.tools)) {
          console.warn("[first-run] native scan returned no scan");
          return { status: "failed" };
        }
      } catch (err) {
        console.warn("[first-run] native scan threw:", err);
        return { status: "failed" };
      }
      // The host scan cannot be stopped mid-walk (it is bounded at 8 s);
      // a cancel that landed meanwhile drops its result here.
      if (takeCancelled(scanId)) return { status: "cancelled" };
      if (onscan) {
        try {
          onscan(scan);
        } catch (err) {
          console.warn("[first-run] native scan listener threw:", err);
        }
      }
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
