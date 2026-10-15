import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalScanApi, LocalScanView } from "@hq/platform";

import { createImportRunner, importResultOf } from "./import-runner.js";
import { createNativeScanHost, nativeScanEvents, companyFolderOf } from "./native-scan-host.js";
import { isScanNotRun, parseScanEvent, type ScanEvent } from "./scan-stream.js";

const NOW = 1_760_000_000_000;

function scanOf(over: Partial<LocalScanView> = {}): LocalScanView {
  return {
    tools: [
      { tool: "claude-code", sessions_total: 0, sessions_last_30d: 0, last_active_at: null, share_last_30d: 0 },
      { tool: "codex", sessions_total: 0, sessions_last_30d: 0, last_active_at: null, share_last_30d: 0 },
    ],
    projects: [],
    repos: [],
    apps: [],
    mcp_servers: [],
    sources: [
      { source: "claude-code", outcome: "missing", count: 0 },
      { source: "codex", outcome: "missing", count: 0 },
      { source: "repos", outcome: "missing", count: 0 },
      { source: "apps", outcome: "read", count: 0 },
    ],
    truncated: false,
    elapsed_ms: 3,
    ...over,
  };
}

const BOTH = scanOf({
  tools: [
    { tool: "claude-code", sessions_total: 12, sessions_last_30d: 9, last_active_at: NOW, share_last_30d: 0.75 },
    { tool: "codex", sessions_total: 5, sessions_last_30d: 3, last_active_at: NOW - 1000, share_last_30d: 0.25 },
  ],
  projects: [
    { tool: "claude-code", name: "hq-desktop.app", sessions: 7, last_active_at: NOW },
    { tool: "claude-code", name: "home", sessions: 2, last_active_at: NOW - 5000 },
  ],
  repos: [
    { path: "/Users/me/code/hq-desktop.app", last_commit_at: NOW },
    { path: "/Users/me/dev/site", last_commit_at: NOW - 10_000 },
  ],
  apps: ["Linear", "Slack"],
  mcp_servers: ["github"],
  sources: [
    { source: "claude-code", outcome: "read", count: 12 },
    { source: "codex", outcome: "read", count: 5 },
    { source: "repos", outcome: "read", count: 2 },
    { source: "apps", outcome: "read", count: 3 },
  ],
});

function parsed(scan: LocalScanView): ScanEvent[] {
  return nativeScanEvents(scan).map((raw) => {
    const event = parseScanEvent(raw);
    expect(event, JSON.stringify(raw)).not.toBeNull();
    return event!;
  });
}

function apiReturning(scan: LocalScanView): LocalScanApi & { calls: number } {
  const api = {
    calls: 0,
    scan: async () => {
      api.calls += 1;
      return { ok: true as const, value: scan };
    },
  };
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nativeScanEvents", () => {
  it("every event is one the stream parser accepts", () => {
    expect(nativeScanEvents(BOTH).length).toBe(parsed(BOTH).length);
  });

  it("names the four sources up front and ends with done", () => {
    const events = parsed(BOTH);
    expect(events[0]).toEqual({
      type: "start",
      sources: [
        { id: "claude-code", label: "Claude Code" },
        { id: "codex", label: "Codex" },
        { id: "repos", label: "Repos" },
        { id: "apps", label: "Apps" },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      report: null,
      summary: { companies: 0, projects: 3, sessions: 17, repos: 2, apps: 2, sources: 4 },
    });
  });

  it("session projects come first and a repo with the same folder name is not repeated", () => {
    const projects = parsed(BOTH).filter((e) => e.type === "project");
    expect(projects).toEqual([
      { type: "project", id: "claude-code:hq-desktop.app", name: "hq-desktop.app", company: null, basis: "claude-code-cwd" },
      { type: "project", id: "claude-code:home", name: "home", company: null, basis: "claude-code-cwd" },
      { type: "project", id: "repo:site", name: "site", company: null, basis: "repo" },
    ]);
  });

  it("carries session counts per tool and maps host outcomes to row statuses", () => {
    const sources = parsed(
      scanOf({
        tools: BOTH.tools,
        sources: [
          { source: "claude-code", outcome: "read", count: 12 },
          { source: "codex", outcome: "budget", count: 5 },
          { source: "repos", outcome: "unreadable", count: 0 },
          { source: "apps", outcome: "unsupported", count: 0 },
        ],
      }),
    ).filter((e) => e.type === "source");
    expect(sources).toEqual([
      { type: "source", id: "claude-code", status: "done", counts: { sessions: 12, recent: 9 }, message: null },
      { type: "source", id: "codex", status: "done", counts: { sessions: 5, recent: 3 }, message: null },
      { type: "source", id: "repos", status: "error", counts: { repos: 0 }, message: null },
      { type: "source", id: "apps", status: "skipped", counts: { apps: 0, mcp_servers: 0 }, message: null },
    ]);
  });

  it("a folder holding two or more repos is a company limb; home folders and lone repos are not (owner, 2026-10-15)", () => {
    const events = nativeScanEvents(
      scanOf({
        projects: [{ tool: "claude-code", name: "hq-cli", sessions: 4, last_active_at: null }],
        repos: [
          { path: "/Users/admin/dev/indigo/hq-cli", last_commit_at: null },
          { path: "/Users/admin/dev/indigo/hq-pro", last_commit_at: null },
          { path: "/Users/admin/dev/solo/one-off", last_commit_at: null },
          { path: "/Users/admin/scratch", last_commit_at: null },
        ],
      }),
    );
    const companies = events.filter((e) => e.type === "company");
    expect(companies).toEqual([{ v: 1, type: "company", id: "folder:indigo", name: "indigo", basis: "folder" }]);
    // The company comes before any project on it.
    expect(events.findIndex((e) => e.type === "company")).toBeLessThan(events.findIndex((e) => e.type === "project"));
    const projects = events.filter((e) => e.type === "project") as { name: string; company: string | null }[];
    expect(projects.map((p) => [p.name, p.company])).toEqual([
      ["hq-cli", "folder:indigo"],
      ["hq-pro", "folder:indigo"],
      ["one-off", null],
      ["scratch", null],
    ]);
    const done = events.find((e) => e.type === "done") as { summary: Record<string, number> };
    expect(done.summary.companies).toBe(1);
  });

  it("companyFolderOf: the parent folder, unless it is a home folder or the root", () => {
    expect(companyFolderOf("/Users/admin/dev/indigo/hq-cli")).toBe("indigo");
    expect(companyFolderOf("/Users/admin/hq-cli")).toBe("");
    expect(companyFolderOf("/home/admin/hq-cli")).toBe("");
    expect(companyFolderOf("/hq-cli")).toBe("");
    expect(companyFolderOf("/Users/admin/dev/hq-cli")).toBe("");
    expect(companyFolderOf("/Users/admin/Projects/hq-cli")).toBe("");
    expect(companyFolderOf("C:\\Users\\admin\\work\\acme\\site")).toBe("acme");
  });

  it("an empty computer still reads as a scan that ran", () => {
    const done = parsed(scanOf()).at(-1)!;
    expect(done.type).toBe("done");
    if (done.type !== "done") return;
    expect(isScanNotRun(done)).toBe(false);
    expect(done.summary).toEqual({ companies: 0, projects: 0, sessions: 0, repos: 0, apps: 0, sources: 4 });
  });

  it("names that are not safe ids become safe ids, and odd shapes are skipped", () => {
    const projects = parsed(
      scanOf({
        projects: [
          { tool: "codex", name: "My App (v2)", sessions: 1, last_active_at: null },
          { tool: "claude-code", name: "   ", sessions: 1, last_active_at: null },
        ],
        repos: [{ path: "/", last_commit_at: null }],
      }),
    ).filter((e) => e.type === "project");
    expect(projects).toEqual([
      { type: "project", id: "codex:my-app-v2", name: "My App (v2)", company: null, basis: "codex-cwd" },
    ]);
  });
});

describe("createNativeScanHost", () => {
  it("is null without a native scan, so the caller can fall back", () => {
    expect(createNativeScanHost(null)).toBeNull();
    expect(createNativeScanHost(undefined)).toBeNull();
  });

  it("runs one scan and forwards its events, then ends done", async () => {
    const api = apiReturning(BOTH);
    const host = createNativeScanHost(api)!;
    const seen: unknown[] = [];
    const end = await host.run("scan-1", (raw) => seen.push(raw));
    expect(end).toEqual({ status: "done" });
    expect(api.calls).toBe(1);
    expect(seen).toEqual(nativeScanEvents(BOTH));
  });

  it("a failed host answer ends failed and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createNativeScanHost({
      scan: async () => ({ ok: false as const, reason: "error" as const, code: "invoke", message: "boom" }),
    })!;
    const seen: unknown[] = [];
    expect(await host.run("scan-2", (raw) => seen.push(raw))).toEqual({ status: "failed" });
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("an ok answer with no scan ends failed, emits nothing and skips onscan", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onscan = vi.fn();
    const host = createNativeScanHost(
      { scan: async () => ({ ok: true as const, value: null as unknown as LocalScanView }) },
      onscan,
    )!;
    const seen: unknown[] = [];
    expect(await host.run("scan-null", (raw) => seen.push(raw))).toEqual({ status: "failed" });
    expect(seen).toEqual([]);
    expect(onscan).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[first-run] native scan returned no scan");
  });

  it("a throwing host ends failed and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createNativeScanHost({
      scan: async () => {
        throw new Error("bridge gone");
      },
    })!;
    expect(await host.run("scan-3", () => undefined)).toEqual({ status: "failed" });
    expect(warn).toHaveBeenCalled();
  });

  it("a cancel before the run never calls the host", async () => {
    const api = apiReturning(BOTH);
    const host = createNativeScanHost(api)!;
    await host.cancel("scan-4");
    expect(await host.run("scan-4", () => undefined)).toEqual({ status: "cancelled" });
    expect(api.calls).toBe(0);
  });

  it("a cancel while the host scans drops the result", async () => {
    let release: (() => void) | null = null;
    const host = createNativeScanHost({
      scan: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, value: BOTH });
        }),
    })!;
    const seen: unknown[] = [];
    const running = host.run("scan-5", (raw) => seen.push(raw));
    await host.cancel("scan-5");
    release!();
    expect(await running).toEqual({ status: "cancelled" });
    expect(seen).toEqual([]);
  });
});

describe("native scan through the import runner", () => {
  it("the knowledge tree's runner finishes with the native counts", async () => {
    const host = createNativeScanHost(apiReturning(BOTH))!;
    const runner = createImportRunner(host, () => NOW, () => undefined, {
      schedule: (fn) => {
        fn();
        return () => undefined;
      },
    });
    runner.start();
    await vi.waitFor(() => expect(runner.current().phase).toBe("done"));
    expect(importResultOf(runner.current().events)).toEqual({
      summary: { companies: 0, projects: 3, sessions: 17, repos: 2, apps: 2, sources: 4 },
      report: null,
    });
    runner.dispose();
  });
});

describe("createNativeScanHost onscan (US-007)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands the finished scan to the listener before any event goes out", async () => {
    const order: string[] = [];
    let seen: LocalScanView | null = null;
    const host = createNativeScanHost(apiReturning(BOTH), (scan) => {
      seen = scan;
      order.push("scan");
    })!;
    expect(await host.run("scan-us007-1", () => order.push("event"))).toEqual({ status: "done" });
    expect(seen).toBe(BOTH);
    expect(order[0]).toBe("scan");
    expect(order.filter((step) => step === "scan")).toHaveLength(1);
    expect(order.length).toBeGreaterThan(1);
  });

  it("logs a throwing listener and still ends the scan done with its events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createNativeScanHost(apiReturning(BOTH), () => {
      throw new Error("listener broke");
    })!;
    const events: unknown[] = [];
    expect(await host.run("scan-us007-2", (raw) => events.push(raw))).toEqual({ status: "done" });
    expect(warn).toHaveBeenCalled();
    expect(events.length).toBe(nativeScanEvents(BOTH).length);
  });

  it("does not call the listener when the scan fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onscan = vi.fn();
    const host = createNativeScanHost(
      {
        scan: async () => {
          throw new Error("bridge gone");
        },
      },
      onscan,
    )!;
    expect(await host.run("scan-us007-3", () => undefined)).toEqual({ status: "failed" });
    expect(onscan).not.toHaveBeenCalled();
  });

  it("does not call the listener for a cancelled scan", async () => {
    const onscan = vi.fn();
    const host = createNativeScanHost(apiReturning(BOTH), onscan)!;
    await host.cancel("scan-us007-4");
    expect(await host.run("scan-us007-4", () => undefined)).toEqual({ status: "cancelled" });
    expect(onscan).not.toHaveBeenCalled();
  });
});
