import { describe, expect, it, vi } from "vitest";

import {
  ASSISTANT_NAME_MAX,
  FIRST_RUN_STEPS,
  VISUAL_FIRST_RUN_DONE_KEY,
  assistantNameIssue,
  createFirstRunAssistantStarter,
  firstRunCanLeave,
  firstRunFinishTarget,
  firstRunHandoffNote,
  firstRunHandoffNotice,
  firstRunIntro,
  firstRunKickoff,
  firstRunNextLabel,
  firstRunOffersFinish,
  firstRunRoute,
  firstRunStepNumber,
  firstRunStepsFor,
  firstRunImportJson,
  firstRunImportNotice,
  firstRunSettledNotice,
  firstRunKickoffCarry,
  firstRunTeamJson,
  firstRunAppsJson,
  firstRunDoneSteps,
  FIRST_RUN_BANNED_DASHES,
  handoffReportPath,
  FIRST_RUN_REPORT_PATH_MAX,
  FIRST_RUN_KICKOFF_MAX,
  hasFinishedVisualFirstRun,
  markVisualFirstRunFinished,
  normalizeAssistantName,
  nextFirstRunStep,
  prevFirstRunStep,
  type FirstRunAssistantResult,
  type FirstRunCreation,
  type FirstRunStep,
} from "./visual-first-run.js";
import { SETUP_BOT_KICKOFF_PREFIX } from "../setup-bot.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe("first-run step list", () => {
  const ALL = { canImport: true, canTeam: true, canConnectApps: true };

  it("has the owner's seven screens in order, ending on done", () => {
    expect(FIRST_RUN_STEPS.map((s) => s.id)).toEqual(["name", "team", "tools", "context", "notes", "projects", "done"]);
    expect(FIRST_RUN_STEPS.map((s) => s.label)).toEqual([
      "Name your assistant",
      "Your team",
      "Your coding tools",
      "Bring in your context",
      "Note taker",
      "Project management",
      "Done",
    ]);
    const shown = firstRunStepsFor(ALL);
    expect(firstRunStepNumber("name", shown)).toBe(1);
    expect(firstRunStepNumber("team", shown)).toBe(2);
    expect(firstRunStepNumber("tools", shown)).toBe(3);
    expect(firstRunStepNumber("context", shown)).toBe(4);
    expect(firstRunStepNumber("notes", shown)).toBe(5);
    expect(firstRunStepNumber("projects", shown)).toBe(6);
    expect(firstRunStepNumber("done", shown)).toBe(7);
  });

  it("leaves out each screen its host cannot run", () => {
    expect(firstRunStepsFor(ALL).map((s) => s.id)).toEqual(FIRST_RUN_STEPS.map((s) => s.id));
    // Slice 1 and 4 hosts (no team or app hosts): exactly the screens they had.
    expect(firstRunStepsFor({ canImport: true }).map((s) => s.id)).toEqual(["name", "tools", "context", "done"]);
    const without = firstRunStepsFor({ canImport: false });
    expect(without.map((s) => s.id)).toEqual(["name", "tools", "done"]);
    expect(nextFirstRunStep("tools", without)).toBe("done");
    expect(firstRunStepsFor({ ...ALL, canImport: false }).map((s) => s.id)).toEqual([
      "name",
      "team",
      "tools",
      "notes",
      "projects",
      "done",
    ]);
  });

  it('"Just me" leaves out the company-only app screens', () => {
    expect(firstRunStepsFor({ ...ALL, personal: true }).map((s) => s.id)).toEqual([
      "name",
      "team",
      "tools",
      "context",
      "done",
    ]);
  });

  it("walks forward and back through the listed steps only", () => {
    const shown = firstRunStepsFor(ALL);
    expect(nextFirstRunStep("name", shown)).toBe("team");
    expect(nextFirstRunStep("team", shown)).toBe("tools");
    expect(nextFirstRunStep("tools", shown)).toBe("context");
    expect(nextFirstRunStep("context", shown)).toBe("notes");
    expect(nextFirstRunStep("notes", shown)).toBe("projects");
    expect(nextFirstRunStep("projects", shown)).toBe("done");
    expect(nextFirstRunStep("done", shown)).toBeNull();
    expect(prevFirstRunStep("done", shown)).toBe("projects");
    expect(prevFirstRunStep("team", shown)).toBe("name");
    expect(prevFirstRunStep("name", shown)).toBeNull();
  });

  it("labels the forward button with the next step's name", () => {
    const shown = firstRunStepsFor(ALL);
    expect(firstRunNextLabel("name", shown)).toBe("Next: Your team");
    expect(firstRunNextLabel("team", shown)).toBe("Next: Your coding tools");
    expect(firstRunNextLabel("tools", shown)).toBe("Next: Bring in your context");
    expect(firstRunNextLabel("context", shown)).toBe("Next: Note taker");
    expect(firstRunNextLabel("notes", shown)).toBe("Next: Project management");
    expect(firstRunNextLabel("projects", shown)).toBe("Next: Done");
    expect(firstRunNextLabel("done", shown)).toBe("");
  });

  it("offers Finish with defaults only where it would skip something", () => {
    const shown = firstRunStepsFor(ALL);
    for (const id of ["name", "team", "tools", "context", "notes"] as const) {
      expect(firstRunOffersFinish(id, shown)).toBe(true);
    }
    // Next to Done both buttons would do the same thing.
    expect(firstRunOffersFinish("projects", shown)).toBe(false);
    expect(firstRunOffersFinish("done", shown)).toBe(false);
  });

  it("is data-driven: bars, labels and Back follow the list", () => {
    const short: FirstRunStep[] = [FIRST_RUN_STEPS[0]!, { id: "team", label: "Your team" }, { id: "done", label: "Done" }];
    expect(firstRunStepNumber("done", short)).toBe(3);
    expect(firstRunNextLabel("name", short)).toBe("Next: Your team");
    expect(prevFirstRunStep("done", short)).toBe("team");
    expect(firstRunOffersFinish("team", short)).toBe(false);
  });

  it("the coding tools step is required only while no tool is ready", () => {
    expect(firstRunCanLeave("tools", { claude: false, codex: false, grok: false })).toBe(false);
    expect(firstRunCanLeave("tools", null)).toBe(false);
    expect(firstRunCanLeave("tools", { codex: true })).toBe(true);
    expect(firstRunCanLeave("name", null)).toBe(true);
    expect(firstRunCanLeave("team", null)).toBe(true);
    expect(firstRunCanLeave("notes", null)).toBe(true);
    expect(firstRunFinishTarget({ claude: false })).toBe("tools");
    expect(firstRunFinishTarget({ claude: true })).toBe("done");
  });
});

describe("assistant name", () => {
  it("follows the host's display-name rule", () => {
    expect(assistantNameIssue("Pickles")).toBeNull();
    expect(assistantNameIssue("Dr. O'Neil-Smith")).toBeNull();
    expect(assistantNameIssue("  ")).toBe("Give your assistant a name.");
    expect(assistantNameIssue("R2D2")).toBe("Use letters, spaces, apostrophes, periods and hyphens.");
    expect(assistantNameIssue("-dash")).not.toBeNull();
    expect(assistantNameIssue("a".repeat(ASSISTANT_NAME_MAX))).toBeNull();
    expect(assistantNameIssue("a".repeat(ASSISTANT_NAME_MAX + 1))).toBe("Keep the name under 35 characters.");
  });
});

describe("assistant name whitespace", () => {
  it("collapses tabs and runs of spaces, which is what the host keeps and checks", () => {
    expect(normalizeAssistantName(" Mr\tBiscuit  Pants ")).toBe("Mr Biscuit Pants");
    expect(assistantNameIssue(" Mr\tBiscuit  Pants ")).toBeNull();
    const kickoff = firstRunKickoff({ name: "Mr\tBiscuit  Pants", runtime: "claude", toolsReady: ["claude"] });
    expect(kickoff).toContain('"name":"Mr Biscuit Pants"');
    expect(kickoff).toContain("I chose your name, Mr Biscuit Pants,");
    expect(firstRunIntro({ name: "Mr\tBiscuit", runtime: "claude" })).toContain("Hi, I'm Mr Biscuit,");
    expect(firstRunHandoffNotice({ name: "Mr  Biscuit", runtime: "claude", toolsReady: ["claude"] })).toContain(
      "I named you Mr Biscuit,",
    );
  });
});

describe("handoff kickoff", () => {
  const handoff = { name: "Pickles", runtime: "claude" as const, toolsReady: ["claude", "codex"] as const };

  it("carries a one-line JSON note naming the settled steps", () => {
    const note = JSON.parse(firstRunHandoffNote(handoff));
    expect(note).toEqual({
      from: "desktop-visual-first-run",
      v: 1,
      done: ["name", "codingTools"],
      name: "Pickles",
      runtime: "claude",
      toolsReady: ["claude", "codex"],
    });
  });

  it("starts with the setup template's prefix, says what not to ask again, and stays inside the CLI limits", () => {
    const kickoff = firstRunKickoff(handoff, { noun: "Mac" });
    expect(kickoff.startsWith(SETUP_BOT_KICKOFF_PREFIX)).toBe(true);
    expect(kickoff).toContain(firstRunHandoffNote(handoff));
    expect(kickoff).toContain("never ask about it again");
    expect(kickoff).toContain("Claude Code is signed in on this Mac");
    expect(kickoff).toContain("do not ask whether I want HQ explained first");
    // `validate_kickoff`: one line, no control characters, under 2000.
    // eslint-disable-next-line no-control-regex
    expect(kickoff).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(kickoff.length).toBeLessThan(2000);
    expect(kickoff).not.toContain(String.fromCharCode(0x2014));
  });

  it("stays under 2000 characters with the longest name and every tool", () => {
    const longest = firstRunKickoff(
      { name: "A".repeat(ASSISTANT_NAME_MAX), runtime: "grok", toolsReady: ["claude", "codex", "grok"] },
      { noun: "computer" },
    );
    expect(longest.length).toBeLessThan(2000);
  });

  it("tells a setup bot that already existed what was settled, without restarting its kickoff", () => {
    const notice = firstRunHandoffNotice(handoff, { noun: "Mac" });
    expect(notice.startsWith(SETUP_BOT_KICKOFF_PREFIX)).toBe(false);
    expect(notice).toContain(firstRunHandoffNote(handoff));
    expect(notice).toContain("never ask about it again");
    expect(notice).toContain("signed in on this Mac: Claude Code, Codex");
    // eslint-disable-next-line no-control-regex
    expect(notice).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(notice.length).toBeLessThan(2000);
  });

  it("the hello names the assistant and the tool, on one line under 500 characters", () => {
    const intro = firstRunIntro({ name: "Pickles", runtime: "codex" }, { noun: "PC" });
    expect(intro).toContain("Hi, I'm Pickles, your HQ assistant.");
    expect(intro).toContain("signed in Codex");
    expect(intro).toContain("your PC");
    expect(intro.length).toBeLessThan(500);
    expect(intro).not.toContain("\n");
  });
});

describe("import handoff (Bring in your context)", () => {
  const imported = {
    summary: { companies: 3, projects: 9, sessions: 508 },
    report: "workspace/imports/20261008T090807Z/report.json",
  };
  const handoff = { name: "Pickles", runtime: "claude" as const, toolsReady: ["claude"] as const, imported };

  it("adds the counts and the report path to the handoff JSON and marks import done", () => {
    const note = JSON.parse(firstRunHandoffNote(handoff));
    expect(note.done).toEqual(["name", "codingTools", "import"]);
    expect(note.import).toEqual({ companies: 3, projects: 9, sessions: 508, report: imported.report });
  });

  it("carries only whole counts under plain keys and a clean path, never anything else", () => {
    const json = firstRunImportJson({
      summary: { companies: 2.7, "bad key": 4, report: 9, negative: -1, ok_key: 5 } as Record<string, number>,
      report: "/tmp/r.json\nrm -rf /",
    });
    expect(json).toEqual({ companies: 2, ok_key: 5 });
    const long = firstRunImportJson({ summary: { projects: 1 }, report: "a".repeat(FIRST_RUN_REPORT_PATH_MAX + 1) });
    expect(long).toEqual({ projects: 1 });
  });

  it("never sends an absolute path: the report is HQ-relative or left out", () => {
    for (const report of [
      "/Users/pat/hq/workspace/imports/x/report.json",
      "~/hq/report.json",
      "C:\\Users\\pat\\hq\\report.json",
      "\\\\server\\share\\report.json",
      "workspace/../../etc/report.json",
    ]) {
      expect(handoffReportPath(report)).toBeNull();
      const leaky = { summary: { companies: 1 }, report };
      const sent = [
        firstRunHandoffNote({ ...handoff, imported: leaky }),
        firstRunKickoff({ ...handoff, imported: leaky }, { noun: "Mac" }),
        firstRunImportNotice(leaky),
        firstRunHandoffNotice({ ...handoff, imported: leaky }, { noun: "Mac" }),
      ];
      for (const text of sent) {
        expect(text).not.toContain(report);
        expect(text).not.toMatch(/\/Users\/|~\/|[A-Za-z]:\\/);
        expect(text).not.toContain('"report"');
      }
    }
    expect(handoffReportPath("workspace/imports/x/report.json")).toBe("workspace/imports/x/report.json");
  });

  it("the kickoff says the import is finished and stays inside the CLI limits with the longest path", () => {
    const kickoff = firstRunKickoff(handoff, { noun: "Mac" });
    expect(kickoff).toContain(firstRunHandoffNote(handoff));
    expect(kickoff).toContain("The context import is finished");
    const longest = firstRunKickoff(
      {
        name: "A".repeat(ASSISTANT_NAME_MAX),
        runtime: "grok",
        toolsReady: ["claude", "codex", "grok"],
        imported: {
          summary: { companies: 99999, projects: 99999, sessions: 99999, a: 1, b: 2, c: 3, d: 4, e: 5 },
          report: "r".repeat(FIRST_RUN_REPORT_PATH_MAX),
        },
      },
      { noun: "computer" },
    );
    expect(longest.length).toBeLessThan(FIRST_RUN_KICKOFF_MAX);
    // eslint-disable-next-line no-control-regex
    expect(longest).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("without an import the kickoff is exactly slice 1's", () => {
    const plain = { name: "Pickles", runtime: "claude" as const, toolsReady: ["claude"] as const };
    expect(firstRunKickoff({ ...plain, imported: null })).toBe(firstRunKickoff(plain));
    expect(JSON.parse(firstRunHandoffNote(plain)).done).toEqual(["name", "codingTools"]);
  });

  it("a notice tells an assistant created before the scan finished, in one line", () => {
    const notice = firstRunImportNotice(imported);
    expect(notice.startsWith(SETUP_BOT_KICKOFF_PREFIX)).toBe(false);
    const json = notice.match(/Handoff from the app: (\{.*?\})\. /)?.[1];
    expect(JSON.parse(json!)).toEqual({
      from: "desktop-visual-first-run",
      v: 1,
      done: ["import"],
      import: { companies: 3, projects: 9, sessions: 508, report: imported.report },
    });
    expect(notice).toContain("do not ask me to import it again");
    // eslint-disable-next-line no-control-regex
    expect(notice).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(notice.length).toBeLessThan(2000);
    expect(notice).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("never again", () => {
  it("remembers that the takeover was finished or left for chat", () => {
    const storage = memoryStorage();
    expect(hasFinishedVisualFirstRun(storage)).toBe(false);
    markVisualFirstRunFinished(storage);
    expect(hasFinishedVisualFirstRun(storage)).toBe(true);
    expect(storage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
  });
});

describe("first-run routing", () => {
  const base = { hasBots: true, welcomeSetupRun: false, welcomeSetupOwed: true, flag: true, finished: false } as const;

  it("flag on, first run: the takeover", () => {
    expect(firstRunRoute(base)).toBe("visual");
  });

  it("flag off: today's path, as soon as the flag answers", () => {
    expect(firstRunRoute({ ...base, flag: false })).toBe("legacy");
    expect(firstRunRoute({ ...base, flag: false, welcomeSetupOwed: null })).toBe("legacy");
  });

  it("waits while the flag or the host's setup answer is not in", () => {
    expect(firstRunRoute({ ...base, flag: null })).toBe("pending");
    expect(firstRunRoute({ ...base, welcomeSetupOwed: null })).toBe("pending");
  });

  it("never opens the takeover after it was finished, after setup ran, or where setup is not owed", () => {
    expect(firstRunRoute({ ...base, finished: true })).toBe("legacy");
    expect(firstRunRoute({ ...base, welcomeSetupRun: true })).toBe("legacy");
    expect(firstRunRoute({ ...base, welcomeSetupOwed: false })).toBe("legacy");
    expect(firstRunRoute({ ...base, hasBots: false })).toBe("legacy");
  });
});

describe("one assistant create at a time", () => {
  function deferred(): { promise: Promise<FirstRunAssistantResult>; resolve: (r: FirstRunAssistantResult) => void } {
    let resolve!: (r: FirstRunAssistantResult) => void;
    const promise = new Promise<FirstRunAssistantResult>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("shows creating at once and ignores repeat starts while it runs and after it succeeds", async () => {
    const pending = deferred();
    const run = vi.fn(() => pending.promise);
    const states: FirstRunCreation[] = [];
    const starter = createFirstRunAssistantStarter(run, (s) => states.push(s));

    starter.start("Pickles");
    // Pending state is synchronous with the press.
    expect(starter.current()).toEqual({ state: "creating", name: "Pickles" });
    starter.start("Pickles");
    starter.start("Other");
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true, bot: { agentUid: "agt_1", name: "setup" } });
    await vi.waitFor(() => expect(starter.current().state).toBe("ready"));
    starter.start("Pickles");
    starter.retry();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(states.map((s) => s.state)).toEqual(["creating", "ready"]);
  });

  it("a failure says why, and Retry runs again with the same name", async () => {
    const run = vi
      .fn<(name: string) => Promise<FirstRunAssistantResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "Could not create setup." })
      .mockResolvedValueOnce({ ok: true, bot: { agentUid: "agt_1", name: "setup" } });
    const starter = createFirstRunAssistantStarter(run, () => {});
    starter.start("Pickles");
    await vi.waitFor(() =>
      expect(starter.current()).toEqual({ state: "failed", name: "Pickles", reason: "Could not create setup." }),
    );
    starter.retry();
    expect(starter.current().state).toBe("creating");
    await vi.waitFor(() => expect(starter.current().state).toBe("ready"));
    expect(run).toHaveBeenNthCalledWith(2, "Pickles");
  });

  it("a create that throws is a failure with a written sentence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const starter = createFirstRunAssistantStarter(() => Promise.reject(new Error("boom")), () => {});
    starter.start("Pickles");
    await vi.waitFor(() => expect(starter.current().state).toBe("failed"));
    const current = starter.current();
    expect(current.state === "failed" ? current.reason : "").toBe("Could not start your assistant. Please try again.");
    warn.mockRestore();
  });
});

describe("team and app handoff (Your team, Note taker, Project management)", () => {
  const base = { name: "Pickles", runtime: "claude" as const, toolsReady: ["claude"] as const };
  const team = { kind: "company" as const, how: "joined" as const, name: "Acme Robotics", slug: "acme-robotics" };
  const apps = { notes: { name: "Granola", domain: "granola.ai" }, projects: null };

  it("emits the exact shape the setup worker reads", () => {
    const note = JSON.parse(firstRunHandoffNote({ ...base, team, apps }));
    expect(note).toEqual({
      from: "desktop-visual-first-run",
      v: 1,
      done: ["name", "codingTools", "company", "noteTaker", "projectManagement"],
      name: "Pickles",
      runtime: "claude",
      toolsReady: ["claude"],
      team: { kind: "company", how: "joined", name: "Acme Robotics", slug: "acme-robotics" },
      apps: { notes: { name: "Granola", domain: "granola.ai" }, projects: "skipped" },
    });
    expect(JSON.parse(firstRunHandoffNote({ ...base, team: { kind: "personal" } })).team).toEqual({ kind: "personal" });
  });

  it("marks only the screens that were passed, in the flow's order", () => {
    expect(firstRunDoneSteps({ team: { kind: "personal" } })).toEqual(["name", "codingTools", "company"]);
    expect(firstRunDoneSteps({ apps: { projects: null } })).toEqual(["name", "codingTools", "projectManagement"]);
    expect(firstRunDoneSteps({ imported: { summary: { projects: 1 }, report: null }, team, apps })).toEqual([
      "name",
      "codingTools",
      "company",
      "import",
      "noteTaker",
      "projectManagement",
    ]);
    // Without the later screens the note is exactly slice 4's.
    expect(firstRunHandoffNote({ ...base, team: null, apps: null })).toBe(firstRunHandoffNote(base));
  });

  it("never carries a path, a control character or a bad slug or domain", () => {
    expect(firstRunTeamJson({ kind: "company", how: "created", name: "/Users/pat/hq", slug: "x" })).toBeNull();
    expect(firstRunTeamJson({ kind: "company", how: "created", name: "~/hq", slug: null })).toBeNull();
    expect(firstRunTeamJson({ kind: "company", how: "created", name: "Acme", slug: "../etc" })).toEqual({
      kind: "company",
      how: "created",
      name: "Acme",
    });
    expect(firstRunTeamJson({ kind: "company", how: "created", name: "Bad\u0007Name", slug: null })).toBeNull();
    expect(firstRunAppsJson({ notes: { name: "Evil", domain: "/etc/passwd" }, projects: { name: "C:\\x", domain: "linear.app" } })).toEqual({
      notes: "skipped",
      projects: "skipped",
    });
    const leaky = firstRunHandoffNote({ ...base, team: { kind: "company", how: "joined", name: "/Users/pat", slug: null } });
    expect(leaky).not.toMatch(/\/Users\/|~\/|[A-Za-z]:\\/);
    expect(JSON.parse(leaky).done).not.toContain("company");
  });

  it("the kickoff says the company question is settled and stays inside the CLI limits", () => {
    const kickoff = firstRunKickoff({ ...base, team, apps }, { noun: "Mac" });
    expect(kickoff).toContain(firstRunHandoffNote({ ...base, team, apps }));
    expect(kickoff).toContain("The company question is settled (I joined Acme Robotics)");
    expect(kickoff).toContain("The note taker and project management choices are in the handoff");
    expect(firstRunKickoffCarry({ ...base, team, apps }, { noun: "Mac" })).toMatchObject({ settled: true, importWhole: true });
  });

  it("with everything set the kickoff stays under the limit and the report path still reaches the bot", () => {
    const everything = {
      name: "A".repeat(ASSISTANT_NAME_MAX),
      runtime: "grok" as const,
      toolsReady: ["claude", "codex", "grok"] as const,
      imported: {
        summary: { companies: 99999, projects: 99999, sessions: 99999, a: 1, b: 2, c: 3 },
        report: "workspace/imports/" + "r".repeat(FIRST_RUN_REPORT_PATH_MAX - 30) + "/report.json",
      },
      team: { kind: "company" as const, how: "created" as const, name: "W".repeat(80), slug: "w".repeat(60) },
      apps: {
        notes: { name: "N".repeat(60), domain: "a".repeat(60) + ".com" },
        projects: { name: "P".repeat(60), domain: "linear.app" },
      },
    };
    const carry = firstRunKickoffCarry(everything, { noun: "computer" });
    expect(carry.kickoff.length).toBeLessThan(FIRST_RUN_KICKOFF_MAX);
    // eslint-disable-next-line no-control-regex
    expect(carry.kickoff).not.toMatch(/[\u0000-\u001f\u007f]/);
    // The team and apps did not fit: the host sends them as a settled notice.
    expect(carry.settled).toBe(false);
    const settled = firstRunSettledNotice({ team: everything.team, apps: everything.apps })!;
    expect(settled.length).toBeLessThan(2000);
    expect(JSON.parse(settled.match(/Handoff from the app: (\{.*?\})\. /)![1]!).done).toEqual([
      "company",
      "noteTaker",
      "projectManagement",
    ]);
    // Some message carries import.report: the kickoff when it fit, else the import note.
    const report = everything.imported.report;
    const carrier = carry.importWhole ? carry.kickoff : firstRunImportNotice(everything.imported);
    expect(carrier).toContain(`"report":"${report}"`);
    expect(carry.importWhole).toBe(true);
    // The realistic case (the kickoff goes out at the name step, before the
    // later screens): the report rides in the kickoff itself.
    const atName = firstRunKickoffCarry({ ...everything, team: null, apps: null });
    expect(atName.importWhole).toBe(true);
    expect(atName.kickoff).toContain(`"report":"${report}"`);
  });

  it("a settled notice tells an assistant created earlier, once, in one line", () => {
    expect(firstRunSettledNotice({})).toBeNull();
    expect(firstRunSettledNotice({ team: null, apps: {} })).toBeNull();
    const notice = firstRunSettledNotice({ team: { kind: "personal" }, apps: { notes: null } })!;
    expect(notice.startsWith("Setup note from the HQ desktop app:")).toBe(true);
    expect(notice.startsWith(SETUP_BOT_KICKOFF_PREFIX)).toBe(false);
    const json = notice.match(/Handoff from the app: (\{.*?\})\. /)?.[1];
    expect(JSON.parse(json!)).toEqual({
      from: "desktop-visual-first-run",
      v: 1,
      done: ["company", "noteTaker"],
      team: { kind: "personal" },
      apps: { notes: "skipped" },
    });
    expect(notice).toContain("do not ask me to join or start a company");
    // eslint-disable-next-line no-control-regex
    expect(notice).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(notice.length).toBeLessThan(2000);
    for (const dash of FIRST_RUN_BANNED_DASHES) expect(notice).not.toContain(dash);
  });

  it("the settled notice carries an import that was not delivered yet, and no absolute path", () => {
    const notice = firstRunSettledNotice({
      imported: { summary: { companies: 2 }, report: "/Users/pat/hq/workspace/imports/r.json" },
      team,
    })!;
    const json = JSON.parse(notice.match(/Handoff from the app: (\{.*?\})\. /)?.[1] ?? "{}");
    expect(json.done).toEqual(["company", "import"]);
    expect(json.import).toEqual({ companies: 2 });
    expect(notice).not.toContain("/Users/");
  });
});
