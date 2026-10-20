import { describe, expect, it, vi } from "vitest";

import type { LocalScanView } from "@hq/platform";

import type { ImportScanHost } from "./import-runner.js";
import { importReportInputFromEvents, importReportInputFromScan, tapImportHost } from "./import-report.js";
import { nativeScanEvents } from "./native-scan-host.js";
import { parseScanLine, type ScanEvent } from "./scan-stream.js";

const DAY = 86_400_000;
const LAST = Date.UTC(2026, 9, 19, 7, 58, 40);
const FIRST = LAST - 49 * DAY;

const SCAN: LocalScanView = {
  tools: [
    { tool: "claude-code", sessions_total: 371, sessions_last_30d: 120, last_active_at: LAST, share_last_30d: 0.8, days_seen: 35, first_active_at: FIRST },
    { tool: "codex", sessions_total: 31, sessions_last_30d: 30, last_active_at: LAST - DAY, share_last_30d: 0.2, days_seen: 6, first_active_at: LAST - 20 * DAY },
  ],
  projects: [
    { tool: "claude-code", name: "hq-desktop-app", sessions: 40, last_active_at: LAST },
    { tool: "claude-code", name: "hq", sessions: 90, last_active_at: LAST },
    { tool: "codex", name: "HQ", sessions: 5, last_active_at: LAST },
    { tool: "codex", name: "/Users/pat/code/billing-api", sessions: 12, last_active_at: LAST },
    { tool: "codex", name: "billing-api", sessions: 12, last_active_at: LAST },
  ],
  repos: [{ path: "/Users/pat/code/billing-api", last_commit_at: LAST }],
  apps: ["Linear"],
  mcp_servers: ["github", "linear"],
  sources: [{ source: "claude-code", outcome: "read", count: 371 }],
  truncated: false,
  elapsed_ms: 41,
  days_seen: 37,
  first_active_at: FIRST,
};

const events = (raw: Record<string, unknown>[]): ScanEvent[] => raw.map((e) => parseScanLine(e)).filter((e): e is ScanEvent => !!e);

/** An hq-cli import scan stream: per-source counts, projects and a done summary. */
const CLI_STREAM = [
  { v: 1, type: "start", sources: [{ id: "claude-code", label: "Claude Code" }, { id: "cursor", label: "Cursor" }] },
  { v: 1, type: "count", source: "claude-code", key: "sessions", value: 10 },
  { v: 1, type: "count", source: "claude-code", key: "sessions", value: 18 },
  { v: 1, type: "source", id: "cursor", status: "done", counts: { sessions: 4 }, message: null },
  { v: 1, type: "project", id: "repo:web-app", name: "web-app", company: null, basis: "repo" },
  { v: 1, type: "project", id: "repo:dot-env", name: "~/code/.env", company: null, basis: "repo" },
  { v: 1, type: "done", report: "workspace/imports/x/report.json", summary: { sessions: 22, conversations: 7, skills: 3, projects: 1 } },
];

describe("importReportInputFromScan", () => {
  it("counts, days and times from the native scan, Cursor 0, project names only", () => {
    expect(importReportInputFromScan(SCAN)).toEqual({
      sessions: { total: 402, claude: 371, codex: 31, cursor: 0, days_seen: 37, first_at: FIRST, last_at: LAST },
      tools: ["claude-code", "codex"],
      projects: ["hq", "hq-desktop-app", "billing-api"],
      counts: { mcp_servers: 2 },
    });
  });

  it("an older host with no days or first time writes them as null", () => {
    const { days_seen: _d, first_active_at: _f, ...old } = SCAN;
    const input = importReportInputFromScan(old as LocalScanView);
    expect(input.sessions.days_seen).toBeNull();
    expect(input.sessions.first_at).toBeNull();
    expect(input.sessions.last_at).toBe(LAST);
  });

  it("an empty computer: zeros, no tools, no projects", () => {
    const input = importReportInputFromScan({ ...SCAN, tools: [], projects: [], mcp_servers: [], days_seen: 0, first_active_at: null });
    expect(input).toEqual({
      sessions: { total: 0, claude: 0, codex: 0, cursor: 0, days_seen: 0, first_at: null, last_at: null },
      tools: [],
      projects: [],
      counts: { mcp_servers: 0 },
    });
  });
});

describe("importReportInputFromEvents", () => {
  it("the hq-cli stream: per-source sessions, Cursor when scanned, summary counts, null times", () => {
    expect(importReportInputFromEvents(events(CLI_STREAM))).toEqual({
      sessions: { total: 22, claude: 18, codex: 0, cursor: 4, days_seen: null, first_at: null, last_at: null },
      tools: ["claude-code", "cursor"],
      projects: ["web-app"],
      counts: { skills: 3, conversations: 7 },
    });
  });

  it("both builders give the same shape", () => {
    const keys = (input: object) => JSON.stringify(input, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : v));
    const native = importReportInputFromScan(SCAN);
    const cli = importReportInputFromEvents(events(nativeScanEvents(SCAN)));
    expect(Object.keys(cli)).toEqual(Object.keys(native));
    expect(Object.keys(cli.sessions)).toEqual(Object.keys(native.sessions));
    expect(keys(cli.sessions)).toBe(keys(native.sessions));
    // The native scan's own events give the same counts as the scan itself.
    expect(cli.sessions.total).toBe(native.sessions.total);
    expect(cli.sessions.claude).toBe(native.sessions.claude);
    expect(cli.tools).toEqual(native.tools);
  });
});

describe("tapImportHost", () => {
  const host = (status: string, lines: Record<string, unknown>[]): ImportScanHost => ({
    async run(_id, onevent) {
      for (const line of lines) onevent(line);
      return { status: status as "done" };
    },
    cancel: vi.fn(),
  });

  it("passes every event through and hands a finished scan's events to ondone", async () => {
    const ondone = vi.fn();
    const seen: unknown[] = [];
    const tapped = tapImportHost(host("done", CLI_STREAM), ondone)!;
    expect(await tapped.run("s1", (raw) => seen.push(raw))).toEqual({ status: "done" });
    expect(seen).toEqual(CLI_STREAM);
    expect(ondone).toHaveBeenCalledTimes(1);
    expect(importReportInputFromEvents(ondone.mock.calls[0]![0]).sessions.total).toBe(22);
  });

  it("a failed or cut-short scan writes nothing", async () => {
    const ondone = vi.fn();
    await tapImportHost(host("failed", CLI_STREAM), ondone)!.run("s1", () => {});
    await tapImportHost(host("done", CLI_STREAM.slice(0, -1)), ondone)!.run("s2", () => {});
    expect(ondone).not.toHaveBeenCalled();
  });

  it("a scan that never ran (empty done line) writes nothing", async () => {
    const ondone = vi.fn();
    const notRun = [
      { v: 1, type: "start", sources: [] },
      { v: 1, type: "done", report: null, summary: { companies: 0, projects: 0, sessions: 0 } },
    ];
    await tapImportHost(host("done", notRun), ondone)!.run("s3", () => {});
    expect(ondone).not.toHaveBeenCalled();
  });

  it("cancel goes to the wrapped host, and no host stays no host", () => {
    const inner = host("done", []);
    tapImportHost(inner, () => {})!.cancel("s9");
    expect(inner.cancel).toHaveBeenCalledWith("s9");
    expect(tapImportHost(null, () => {})).toBeNull();
  });
});
