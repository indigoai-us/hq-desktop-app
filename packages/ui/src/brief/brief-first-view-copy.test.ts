/**
 * The first view's own words: the greeting pills, the sunrise's lines, the
 * found-harness test and the zero-count clean-up. A pill with no number or a
 * zero stays out, the sunrise never says what is owed, and no line keeps a
 * "0 companies"-style clause.
 */
import { describe, expect, it } from "vitest";

import {
  FV_CONNECTED,
  FV_FOUND,
  FV_NOT_CONNECTED,
  FV_QUIET_LINE,
  aiAppFound,
  firstViewAgo,
  firstViewStats,
  firstViewSub,
  firstViewWatch,
  withoutZeroCounts,
} from "./brief-first-view-copy.js";
import type { FirstView, FirstViewTool } from "./brief-first-view.js";

const TOOLS: FirstViewTool[] = [
  { harness: "claude-code", name: "Claude Code", sessions: 120 },
  { harness: "codex", name: "Codex", sessions: 30 },
  { harness: "cursor", name: "Cursor", sessions: 4 },
];

function fv(over: { tools?: FirstViewTool[]; pills?: Partial<FirstView["pills"]>; topProjects?: FirstView["topProjects"] } = {}): FirstView {
  return {
    whereYouWork: { tools: over.tools ?? TOOLS, open: null },
    tools: (over.tools ?? TOOLS).map((t) => t.name),
    pills: { sessions: 154, days: 21, projects: 38, tools: 3, ...over.pills },
    topProjects: over.topProjects ?? [{ name: "billing", sessions: 40 }],
  } as unknown as FirstView;
}

describe("the first view's fixed words", () => {
  it("are spelled out in full", () => {
    expect(FV_FOUND).toBe("Found on this Mac");
    expect(FV_NOT_CONNECTED).toBe("Not connected yet");
    expect(FV_CONNECTED).toBe("Connected");
    expect(FV_QUIET_LINE).toBe("Your HQ is ready. The sun's up.");
  });

  it("the quiet line says nothing is owed in no form", () => {
    expect(FV_QUIET_LINE).not.toMatch(/owed|nothing/i);
  });
});

describe("firstViewSub", () => {
  it("names the tools HQ read, as a list", () => {
    expect(firstViewSub(fv())).toBe("HQ read your Claude Code, Codex, and Cursor sessions.");
    expect(firstViewSub(fv({ tools: TOOLS.slice(0, 2) }))).toBe("HQ read your Claude Code and Codex sessions.");
    expect(firstViewSub(fv({ tools: TOOLS.slice(0, 1) }))).toBe("HQ read your Claude Code sessions.");
  });

  it("with no tools says HQ is set up, never what is owed", () => {
    expect(firstViewSub(fv({ tools: [] }))).toBe("HQ is set up on this Mac.");
  });
});

describe("firstViewStats", () => {
  it("gives the four pills in order with their captions", () => {
    expect(firstViewStats(fv())).toEqual([
      { key: "sessions", label: "Sessions", n: 154, caption: "in Claude Code, Codex, and Cursor" },
      { key: "days", label: "Days", n: 21, caption: "of work found" },
      { key: "projects", label: "Projects", n: 38, caption: "most active below" },
      { key: "tools", label: "Tools", n: 3, caption: "Claude Code, Codex, Cursor" },
    ]);
  });

  it("leaves out a pill that is zero or missing", () => {
    const stats = firstViewStats(fv({ pills: { sessions: 0, days: null, projects: 0 } }));
    expect(stats.map((s) => s.key)).toEqual(["tools"]);
    expect(stats.every((s) => s.n > 0)).toBe(true);
  });

  it("with no tools or projects the captions fall back to found on this Mac", () => {
    const stats = firstViewStats(fv({ tools: [], topProjects: [] }));
    expect(stats.find((s) => s.key === "sessions")!.caption).toBe("found on this Mac");
    expect(stats.find((s) => s.key === "projects")!.caption).toBe("found on this Mac");
    expect(stats.find((s) => s.key === "tools")!.caption).toBe("found on this Mac");
  });

  it("a count of one is singular on every pill (round 5)", () => {
    const stats = firstViewStats(fv({ tools: [TOOLS[0]!], pills: { sessions: 1, days: 1, projects: 1, tools: 1 } }));
    expect(stats.map((s) => `${s.n} ${s.label}`)).toEqual(["1 Session", "1 Day", "1 Project", "1 Tool"]);
  });

  it("with every pill empty gives no pills", () => {
    expect(firstViewStats(fv({ pills: { sessions: null, days: 0, projects: null, tools: 0 } }))).toEqual([]);
  });
});

describe("aiAppFound", () => {
  it("a harness with sessions here is found; one with none is not", () => {
    expect(aiAppFound({ harness: "codex", name: "Codex", sessions: 1 })).toBe(true);
    expect(aiAppFound({ harness: "cursor", name: "Cursor", sessions: 0 })).toBe(false);
  });

  it("a harness whose CLI is installed counts as found even with no history", () => {
    expect(aiAppFound({ harness: "codex", name: "Codex", sessions: 0 }, ["codex"])).toBe(true);
    expect(aiAppFound({ harness: "cursor", name: "Cursor", sessions: 0 }, ["codex"])).toBe(false);
  });
});

describe("withoutZeroCounts", () => {
  it.each([
    ["38 projects across 0 companies", "38 projects"],
    ["38 projects in 0 companies.", "38 projects."],
    ["3 PRs, 0 companies", "3 PRs"],
    ["0 companies and 4 projects", "4 projects"],
    ["0 companies", ""],
    ["Nothing to drop here", "Nothing to drop here"],
    ["10 sessions", "10 sessions"],
  ])("%j -> %j", (input, out) => {
    expect(withoutZeroCounts(input)).toBe(out);
  });
});

describe("firstViewWatch", () => {
  const a = (id: string, label: string, reason: string) => ({ id, kind: "open_tree" as const, label, reason, launch_prompt: "", primary: false });

  it("cleans zero counts and drops rows left without a label", () => {
    expect(firstViewWatch([a("1", "See your tree", "38 projects in 0 companies"), a("2", "0 companies", "x")])).toEqual([
      a("1", "See your tree", "38 projects"),
    ]);
  });
});

describe("firstViewAgo", () => {
  const now = new Date("2026-10-18T16:00:00Z");
  it.each([
    ["2026-10-18T15:59:50Z", "1 min ago"],
    ["2026-10-18T15:48:00Z", "12 min ago"],
    ["2026-10-18T13:00:00Z", "3 h ago"],
    ["2026-10-17T14:00:00Z", "Yesterday"],
    ["2026-10-14T16:00:00Z", "4 days ago"],
    ["2026-10-19T16:00:00Z", "1 min ago"],
    ["garbage", ""],
  ])("%s -> %j", (iso, out) => {
    expect(firstViewAgo(iso, now)).toBe(out);
  });
});
