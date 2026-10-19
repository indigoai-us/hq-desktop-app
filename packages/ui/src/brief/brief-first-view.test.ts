import { describe, expect, it } from "vitest";
import {
  FIRST_VIEW_CARD_ORDER,
  FIRST_VIEW_CONNECT_MODE,
  buildFirstView,
  parseImportReport,
  type FirstView,
  type FirstViewInput,
} from "./brief-first-view.js";
import { WELCOME_IMPORT_LABEL, type WelcomeAction } from "./brief-welcome-contract.js";
import core from "./fixtures/core-1432-welcome.json";
import legacy from "./fixtures/welcome-16030-legacy.json";
import desktopReport from "./fixtures/import-report-desktop.json";

const NOW = "2026-10-19T09:30:00";
const report = parseImportReport(desktopReport.report)!;
const view = (welcome: unknown, extra: Partial<FirstViewInput> = {}): FirstView =>
  buildFirstView({ welcome: welcome as Record<string, unknown>, now: NOW, userName: "Alex", ...extra });

/** Every label and kind the model can put on a button, so a past-work action cannot hide in any slot. */
function allActions(v: FirstView): WelcomeAction[] {
  return [v.oneThing, v.whereYouWork.open, v.connect.aiAction, ...v.connect.integrations.map((i) => i.action), ...v.watchList].filter(
    (a): a is WelcomeAction => !!a,
  );
}
const pastWork = (v: FirstView) => allActions(v).filter((a) => a.kind === "import_history" || a.label === WELCOME_IMPORT_LABEL);

describe("parseImportReport", () => {
  it("reads the desktop report's contract fields", () => {
    expect(report.sessions).toEqual({
      total: 402,
      claude: 371,
      codex: 31,
      cursor: 0,
      days_seen: 37,
      first_at: "2026-08-30T14:02:11Z",
      last_at: "2026-10-19T07:58:40Z",
    });
    expect(report.tools).toEqual(["claude-code", "codex"]);
    expect(report.projects).toEqual(["hq", "hq-desktop-app", "billing-api"]);
    expect(report.counts.conversations).toBe(0);
    expect(report.source).toBe("desktop-tree-step");
  });

  it("reads an older /import-context report with no sessions block", () => {
    const old = parseImportReport({ scan_id: "s1", counts: { conversations: 12 }, categories: {}, discovery: { ok: true, errors: [] } });
    expect(old).not.toBeNull();
    expect(old!.sessions).toBeNull();
    expect(old!.counts.conversations).toBe(12);
    expect(old!.projects).toEqual([]);
  });

  it("drops a project that is a path or holds a credential", () => {
    const r = parseImportReport({ scan_id: "s", projects: ["web-app", "/Users/pat/code/web-app", "~/code/x", "ghp_" + "a".repeat(30), "C:\\Users\\pat\\x"] });
    expect(r!.projects).toEqual(["web-app"]);
  });

  it("is null for anything that is not a report object", () => {
    expect(parseImportReport(null)).toBeNull();
    expect(parseImportReport([])).toBeNull();
    expect(parseImportReport("report")).toBeNull();
  });
});

describe("buildFirstView", () => {
  it("core-1432 welcome: greeting, pills, cards and slots from the contract", () => {
    const v = view(core.showcase_personal);
    expect(v.greeting).toBe("Good morning, Alex.");
    expect(v.count).toBe(196);
    expect(v.countLine).toBe("196 sessions over 41 days in Claude Code and Codex. Top threads: harbor-checkout, field-notes, pricing-site.");
    expect(v.pills).toEqual({ sessions: 196, days: 41, projects: 38, tools: 2 });
    expect(v.recentWork).toHaveLength(5);
    expect(v.recentWork[0]).toEqual({
      title: "Fixed the coupon rounding at checkout",
      project: "harbor-checkout",
      harness: "claude-code",
      tool: "Claude Code",
      at: "2026-10-17T21:10:00Z",
    });
    expect(v.topProjects.map((p) => [p.name, p.sessions])).toEqual([
      ["harbor-checkout", 46],
      ["field-notes", 31],
      ["pricing-site", 24],
      ["ops-scripts", 18],
      ["recipe-app", 12],
    ]);
    expect(v.whereYouWork.tools).toEqual([
      { harness: "claude-code", name: "Claude Code", sessions: 180 },
      { harness: "codex", name: "Codex", sessions: 16 },
    ]);
    expect(v.whereYouWork.open?.harness).toBe("claude-code");
    // Sessions were found, so Core's primary "Bring in your past work" gives way to the next action.
    expect(v.oneThing?.id).toBe("open-hq-in-harness");
    expect(v.watchList.map((a) => a.id)).toEqual(["connect-company", "open-tree"]);
    expect(v.connect.aiAction?.id).toBe("connect-ai-apps");
    expect(v.connect.aiApps.map((a) => a.harness)).toEqual(["claude-code", "codex", "cursor"]);
    expect(v.connect.harnessCounts).toEqual({ claude_code: 180, codex: 16, cursor: 0 });
    expect(v.cardOrder).toEqual(["sunrise", "connect", "oneThing", "recentWork"]);
    expect(pastWork(v)).toEqual([]);
  });

  it("core-1432 company welcome: connect_integration rows and suggested apps, deduped by slug", () => {
    const v = view(core.codex_company, {
      suggestedApps: [
        { slug: "github", name: "GitHub" },
        { slug: "linear", name: "Linear" },
      ],
      connectedAiApps: ["codex"],
    });
    expect(v.connect.integrations.map((i) => [i.slug, i.name, i.action?.id ?? null])).toEqual([
      ["github", "GitHub", "connect-github"],
      ["linear", "Linear", null],
    ]);
    // Codex is connected already, so only the others are offered.
    expect(v.connect.aiApps.map((a) => a.harness)).toEqual(["claude-code", "cursor"]);
    expect(v.oneThing?.label).toBe("Open HQ in Codex");
    expect(v.watchList.map((a) => a.id)).toEqual(["open-tree"]);
    // imported (12) + local (5) wins over total (12): the brief's count order.
    expect(v.count).toBe(17);
  });

  it("integration rows go GitHub, Linear, Slack, then the rest in source order (round 4 m3)", () => {
    const v = view(core.codex_company, {
      suggestedApps: [
        { slug: "notion.so", name: "Notion" },
        { slug: "slack.com", name: "Slack" },
        { slug: "linear.app", name: "Linear" },
        { slug: "figma.com", name: "Figma" },
      ],
    });
    expect(v.connect.integrations.map((i) => i.name)).toEqual(["GitHub", "Linear", "Slack", "Notion", "Figma"]);
  });

  it("16.0.30 legacy with import null: next_steps, apps and sessions{total, claude, codex, days_seen}", () => {
    const v = view(legacy.welcome);
    expect(v.count).toBe(41);
    expect(v.countLine).toBe("41 sessions over 9 days in Claude Code and Codex.");
    expect(v.pills).toEqual({ sessions: 41, days: 9, projects: null, tools: 2 });
    expect(v.whereYouWork.tools.map((t) => [t.harness, t.sessions])).toEqual([
      ["claude-code", 38],
      ["codex", 3],
    ]);
    expect(v.whereYouWork.open?.label).toBe("Open HQ in Claude Code");
    expect(v.oneThing?.kind).toBe("connect_company");
    expect(v.recentWork).toEqual([]);
    expect(v.topProjects).toEqual([]);
    // 41 sessions were found locally, so the past-work step never shows (the contract's rule).
    expect(pastWork(v)).toEqual([]);
  });

  it("16.0.30 legacy plus a desktop import report: the count comes from the report and past work is gone", () => {
    const v = view(legacy.welcome, { importReport: report });
    expect(v.count).toBe(402);
    expect(v.countLine).toBe("402 sessions over 37 days in Claude Code and Codex. Top threads: hq, hq-desktop-app, billing-api.");
    expect(v.pills).toEqual({ sessions: 402, days: 37, projects: 3, tools: 2 });
    expect(v.topProjects.map((p) => p.name)).toEqual(["hq", "hq-desktop-app", "billing-api"]);
    expect(pastWork(v)).toEqual([]);
  });

  it("a desktop report feeds every first-view part: where rows, tools and the count line (round 4 M1)", () => {
    // The brief says 38/3 and 9 days; the report says 371/31 over 37 days. Every part reads the report.
    const v = view(legacy.welcome, { importReport: report });
    expect(v.whereYouWork.tools.map((t) => [t.harness, t.name, t.sessions])).toEqual([
      ["claude-code", "Claude Code", 371],
      ["codex", "Codex", 31],
    ]);
    expect(v.tools).toEqual(["Claude Code", "Codex"]);
    expect(v.pills.tools).toBe(2);
    expect(v.whereYouWork.tools.reduce((n, t) => n + t.sessions, 0)).toBe(402);
  });

  it("a report with no tools list names the tools that have report sessions (round 4 M1)", () => {
    const v = view(legacy.welcome, { importReport: { ...report, tools: [] } });
    expect(v.whereYouWork.tools.map((t) => [t.harness, t.sessions])).toEqual([
      ["claude-code", 371],
      ["codex", 31],
    ]);
    expect(v.tools).toEqual(["Claude Code", "Codex"]);
  });

  it("no import report: where rows, tools and the count line fall back to the welcome row (round 4 M1)", () => {
    const v = view(legacy.welcome, { importReport: null });
    expect(v.whereYouWork.tools.map((t) => [t.harness, t.sessions])).toEqual([
      ["claude-code", 38],
      ["codex", 3],
    ]);
    expect(v.tools).toEqual(["Claude Code", "Codex"]);
    expect(v.pills).toEqual({ sessions: 41, days: 9, projects: null, tools: 2 });
    expect(v.countLine).toBe("41 sessions over 9 days in Claude Code and Codex.");
  });

  it("a report count with no days hides the days, never borrowing the brief's (review m1)", () => {
    // The hq-cli fallback writes days as null (read as 0); the 16.0.30 brief says 9 days for its own 41 sessions.
    const cli = parseImportReport({ ...desktopReport.report, sessions: { ...desktopReport.report.sessions, total: 400, days_seen: null } })!;
    const v = view(legacy.welcome, { importReport: cli });
    expect(v.count).toBe(400);
    expect(v.countLine).toBe("400 sessions in Claude Code and Codex. Top threads: hq, hq-desktop-app, billing-api.");
    expect(v.pills.days).toBeNull();
  });

  it("a report with no sessions block leaves the brief's count and its own days together", () => {
    const old = parseImportReport({ scan_id: "s1", counts: { conversations: 12 } })!;
    const v = view(legacy.welcome, { importReport: old });
    expect(v.count).toBe(41);
    expect(v.countLine).toBe("41 sessions over 9 days in Claude Code and Codex.");
    expect(v.pills.days).toBe(9);
  });

  it("the projects pill counts every report project, not only the five shown", () => {
    const names = ["a1", "b2", "c3", "d4", "e5", "f6", "g7"];
    const v = view(legacy.welcome, { importReport: { ...report, projects: names } });
    expect(v.topProjects).toHaveLength(5);
    expect(v.pills.projects).toBe(7);
  });

  it("cursor-primary: Cursor leads where-you-work, and a host that cannot open Cursor gets the next runnable action", () => {
    const v = view(core.cursor_person);
    expect(v.whereYouWork.tools.map((t) => t.harness)).toEqual(["cursor", "claude-code"]);
    expect(v.whereYouWork.open?.harness).toBe("cursor");
    expect(v.countLine).toBe("18 sessions over 3 days in Cursor and Claude Code. Top threads: web-app, billing-api.");

    const noCursor = view(core.cursor_person, { canRun: (a) => !(a.kind === "open_harness" && a.harness === "cursor") });
    expect(noCursor.whereYouWork.open).toBeNull();
    expect(allActions(noCursor).some((a) => a.kind === "open_harness" && a.harness === "cursor")).toBe(false);
    expect(noCursor.oneThing).not.toBeNull();
    expect(noCursor.oneThing?.kind).not.toBe("open_harness");
  });

  it("no company: create-or-join stays on the watch list and there are no integration rows", () => {
    const v = view(core.cursor_person);
    expect(v.watchList.map((a) => a.kind)).toContain("connect_company");
    expect(v.connect.integrations).toEqual([]);
    expect(v.pills.projects).toBe(3);
  });

  it("1 session and no import report: the count line is hidden", () => {
    const one = { ...legacy.welcome, sessions: { total: 1, claude: 1, codex: 0, days_seen: 1 } };
    const v = view(one);
    expect(v.count).toBe(1);
    expect(v.countLine).toBeNull();
    // With a report the same count shows.
    const withReport = view(one, { importReport: { ...report, sessions: { ...report.sessions!, total: 1, days_seen: 1 } } });
    expect(withReport.countLine).toBe("1 session over 1 day in Claude Code and Codex. Top threads: hq, hq-desktop-app, billing-api.");
  });

  it("keeps the past-work step only when nothing was found and nothing was imported", () => {
    const empty = { ...legacy.welcome, sessions: { total: 0, claude: 0, codex: 0, days_seen: 0 } };
    expect(pastWork(view(empty)).map((a) => a.label)).toEqual([WELCOME_IMPORT_LABEL]);
  });

  it("never shows 'Bring in your past work' once a report exists, sessions were imported or conversations were counted", () => {
    const empty = { ...legacy.welcome, sessions: { total: 0, claude: 0, codex: 0, days_seen: 0 } };
    const emptyReport = parseImportReport({ scan_id: "s", counts: { conversations: 0 } })!;
    const cases: [string, FirstView][] = [
      ["a report with no sessions block", view(empty, { importReport: emptyReport })],
      ["the desktop report", view(empty, { importReport: report })],
      ["sessions.imported > 0", view({ ...empty, sessions: { ...empty.sessions, imported: 3 } })],
      ["import.conversations > 0", view({ ...empty, import: { conversations: 12, skills: 0 } })],
      ["core-1432 import_history with a report", view({ ...core.claude_person, sessions: { total: 0 } }, { importReport: emptyReport })],
    ];
    for (const [name, v] of cases) expect(pastWork(v), name).toEqual([]);
  });

  it("drops a recent-work title or project name that is a path or a credential", () => {
    const w = {
      ...core.showcase_personal,
      recent_work: [
        { title: "Read /Users/pat/notes.md", project: "notes", at: "2026-10-17T10:00:00Z", harness: "codex" },
        { title: "Ship it", project: "/Users/pat/code/x", at: "2026-10-16T10:00:00Z", harness: "codex" },
      ],
      top_projects: [{ name: "~/code/secret", sessions: 3 }, { name: "web-app", sessions: 2 }],
    };
    const v = view(w);
    expect(v.recentWork).toEqual([{ title: "Ship it", project: null, harness: "codex", tool: "Codex", at: "2026-10-16T10:00:00Z" }]);
    expect(v.topProjects.map((p) => p.name)).toEqual(["web-app"]);
  });

  it("connect mode defaults to expand, and the input can switch it", () => {
    expect(FIRST_VIEW_CONNECT_MODE).toBe("expand");
    expect(view(core.codex_company).connect.mode).toBe("expand");
    expect(view(core.codex_company, { connectMode: "settings" }).connect.mode).toBe("settings");
  });

  it("the card order is sunrise, connect, one thing, recent work", () => {
    expect(FIRST_VIEW_CARD_ORDER).toEqual(["sunrise", "connect", "oneThing", "recentWork"]);
  });

  it("an empty or missing welcome still returns a greeting and nothing else", () => {
    const v = buildFirstView({ welcome: null, now: "2026-10-19T19:00:00" });
    expect(v.greeting).toBe("Good evening.");
    expect(v.count).toBe(0);
    expect(v.countLine).toBeNull();
    expect(v.pills).toEqual({ sessions: null, days: null, projects: null, tools: null });
    expect(v.oneThing).toBeNull();
    expect(v.watchList).toEqual([]);
  });
});
