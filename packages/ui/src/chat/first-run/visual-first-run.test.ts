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
  hasFinishedVisualFirstRun,
  markVisualFirstRunFinished,
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
  it("slice 1 shows name, coding tools and done, in that order, ending on done", () => {
    expect(FIRST_RUN_STEPS.map((s) => s.id)).toEqual(["name", "tools", "done"]);
    expect(firstRunStepNumber("name")).toBe(1);
    expect(firstRunStepNumber("tools")).toBe(2);
    expect(firstRunStepNumber("done")).toBe(3);
    // Screens from later slices are not shown yet.
    expect(firstRunStepNumber("team")).toBe(0);
    expect(firstRunStepNumber("context")).toBe(0);
  });

  it("walks forward and back through the listed steps only", () => {
    expect(nextFirstRunStep("name")).toBe("tools");
    expect(nextFirstRunStep("tools")).toBe("done");
    expect(nextFirstRunStep("done")).toBeNull();
    expect(prevFirstRunStep("done")).toBe("tools");
    expect(prevFirstRunStep("tools")).toBe("name");
    expect(prevFirstRunStep("name")).toBeNull();
  });

  it("labels the forward button with the next step's name", () => {
    expect(firstRunNextLabel("name")).toBe("Next: Your coding tools");
    expect(firstRunNextLabel("tools")).toBe("Next: Done");
    expect(firstRunNextLabel("done")).toBe("");
  });

  it("offers Finish with defaults only where it would skip something", () => {
    expect(firstRunOffersFinish("name")).toBe(true);
    // Next to Done both buttons would do the same thing.
    expect(firstRunOffersFinish("tools")).toBe(false);
    expect(firstRunOffersFinish("done")).toBe(false);
  });

  it("is data-driven: a later slice inserts a step and bars, labels and Back follow", () => {
    const withTeam: FirstRunStep[] = [
      FIRST_RUN_STEPS[0]!,
      { id: "team", label: "Your team" },
      ...FIRST_RUN_STEPS.slice(1),
    ];
    expect(firstRunStepNumber("done", withTeam)).toBe(4);
    expect(firstRunNextLabel("name", withTeam)).toBe("Next: Your team");
    expect(prevFirstRunStep("tools", withTeam)).toBe("team");
    expect(firstRunOffersFinish("team", withTeam)).toBe(true);
  });

  it("the coding tools step is required only while no tool is ready", () => {
    expect(firstRunCanLeave("tools", { claude: false, codex: false, grok: false })).toBe(false);
    expect(firstRunCanLeave("tools", null)).toBe(false);
    expect(firstRunCanLeave("tools", { codex: true })).toBe(true);
    expect(firstRunCanLeave("name", null)).toBe(true);
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
