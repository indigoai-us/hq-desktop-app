// @vitest-environment happy-dom

// Interpretation of a `/setup` session's event stream into the native
// #welcome card: step ticking, the one-line status, question detection, the
// finish, and the resume record. Realistic sequences taken from what the
// skill actually says.

import { beforeEach, describe, expect, it } from "vitest";

import {
  classifySetupFailure,
  parseSetupCard,
  SETUP_RUN_DONE,
  SETUP_RUN_SESSION_KEY,
  SETUP_RUN_STEPS,
  clearSetupRunRecord,
  interpretSetupRun,
  loadSetupRunRecord,
  saveSetupRunRecord,
  setupRunContinueLabel,
  setupRunStatusSentence,
  setupRunTrailingQuestion,
  type SetupRunEvent,
} from "./setup-run";

const say = (text: string): SetupRunEvent => ({ kind: "assistantMessage", text });
const tool = (name = "Bash"): SetupRunEvent => ({ kind: "toolCall", id: "t1", name });
const result: SetupRunEvent = { kind: "toolResult", id: "t1", isError: false };
const turnDone: SetupRunEvent = { kind: "turnDone", status: "success", error: null };
const user = (text: string): SetupRunEvent => ({ kind: "userMessage", text });

describe("step labels", () => {
  it("are exactly Tools · HQ Cloud · About you · Import · Connect · Your first moves, in order", () => {
    expect(SETUP_RUN_STEPS.map((step) => step.label)).toEqual([
      "Tools",
      "HQ Cloud",
      "Import",
      "About you",
      "Connect",
      "Your first moves",
    ]);
  });
});

describe("interpretSetupRun — steps", () => {
  it("starts on Tools with nothing said yet", () => {
    const state = interpretSetupRun([], "starting");
    expect(state.step).toBe(0);
    expect(state.stepStatuses.tools).toBe("running");
    expect(state.statusLine).toBe("");
    expect(state.question).toBeNull();
    expect(state.done).toBe(false);
    expect(state.ended).toBe(false);
  });

  it("ticks Tools → HQ Cloud → About you → Your first moves from the skill's own prose", () => {
    const events: SetupRunEvent[] = [
      say("Let me start by checking what's already in place on this Mac."),
      tool(),
      result,
      say("All the tools are actually reachable. Next, the HQ Cloud connection."),
      tool(),
      result,
      say("Signed in as jacob@example.com — your companies are synced."),
      say("Now let's get to know you a little.\n\n**What's your name?**"),
      turnDone,
    ];
    const state = interpretSetupRun(events, "idle");
    expect(state.step).toBe(3);
    expect(state.stepStatuses).toEqual({
      tools: "done",
      cloud: "done",
      import: "done",
      you: "running",
      connect: "pending",
      moves: "pending",
    });
  });

  it("never walks backwards when a later sentence mentions an earlier phase", () => {
    const events: SetupRunEvent[] = [
      say("Signed in as jacob@example.com."),
      say("Now let's get to know you."),
      say("By the way, the installer also updated one tool earlier."),
    ];
    const state = interpretSetupRun(events);
    expect(state.step).toBe(3);
    expect(state.stepStatuses.tools).toBe("done");
    expect(state.stepStatuses.you).toBe("running");
  });

  it("honours the explicit [hq-setup] marker over prose", () => {
    const events: SetupRunEvent[] = [
      say("[hq-setup] step=cloud status=running\nConnecting this Mac to HQ Cloud."),
      say("[hq-setup] step=cloud status=done"),
    ];
    const state = interpretSetupRun(events);
    expect(state.stepStatuses.tools).toBe("done");
    expect(state.stepStatuses.cloud).toBe("done");
    expect(state.stepStatuses.import).toBe("running");
    expect(state.step).toBe(2);
  });

  it("ignores sub-agent chatter (parentToolUseId) for step detection", () => {
    const events: SetupRunEvent[] = [
      say("Checking what's already in place."),
      { kind: "assistantMessage", text: "Here is your welcome page.", parentToolUseId: "sub1" },
    ];
    const state = interpretSetupRun(events);
    expect(state.step).toBe(0);
  });
});

describe("interpretSetupRun — status line", () => {
  it("uses the latest short plain sentence and drops markdown, commands, and links", () => {
    const events: SetupRunEvent[] = [
      say("Let me start by checking what's already in place."),
      say("```\n$ hq --version\n```\nhttps://example.com/x\n**Installing** the missing pieces now. This may take a minute."),
    ];
    const state = interpretSetupRun(events);
    expect(state.statusLine).toBe("Installing the missing pieces now.");
  });

  it("does not use the question as the status line", () => {
    expect(setupRunStatusSentence("Now let's get to know you.\n\n**What's your name?**")).toBe(
      "Now let's get to know you.",
    );
    expect(setupRunStatusSentence("**What's your name?**")).toBe("");
  });

  it("caps very long sentences", () => {
    const long = `${"word ".repeat(60)}end.`;
    const line = setupRunStatusSentence(long);
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("interpretSetupRun — questions", () => {
  it("renders a structured questionRequest with options as a choice question", () => {
    const events: SetupRunEvent[] = [
      say("Signed in as jacob@example.com."),
      {
        kind: "questionRequest",
        requestId: "req-1",
        questions: [
          {
            id: "q1",
            header: "Scope",
            text: "What do you mostly want help with first?",
            options: [
              { label: "Marketing", description: "Content and campaigns" },
              { label: "Engineering", description: null },
            ],
            multiSelect: false,
          },
        ],
      },
    ];
    const state = interpretSetupRun(events, "needsYou");
    expect(state.question).toEqual({
      kind: "choice",
      header: "Scope",
      requestId: "req-1",
      questionId: "q1",
      text: "What do you mostly want help with first?",
      options: [
        { label: "Marketing", description: "Content and campaigns" },
        { label: "Engineering", description: null },
      ],
      multiSelect: false,
    });
  });

  it("retires a structured question once this client answered it", () => {
    const events: SetupRunEvent[] = [
      { kind: "questionRequest", requestId: "req-1", questions: [{ id: "q1", text: "Pick one?", options: [{ label: "A" }] }] },
    ];
    expect(interpretSetupRun(events, "needsYou", ["req-1"]).question).toBeNull();
  });

  it("retires a structured question once the agent has moved on", () => {
    const events: SetupRunEvent[] = [
      { kind: "questionRequest", requestId: "req-1", questions: [{ id: "q1", text: "Pick one?", options: [{ label: "A" }] }] },
      tool(),
    ];
    expect(interpretSetupRun(events, "working").question).toBeNull();
  });

  it("renders a trailing bold question as a text question once the turn ends", () => {
    const events: SetupRunEvent[] = [
      say("Now let's get to know you.\n\n**What's your name?**"),
      turnDone,
    ];
    const state = interpretSetupRun(events, "idle");
    expect(state.question).toEqual({ kind: "text", text: "What's your name?" });
    expect(state.statusLine).toBe("Now let's get to know you.");
  });

  it("holds a trailing question back while the agent is still working on the turn", () => {
    const events: SetupRunEvent[] = [say("Quick check first — are the tools reachable?")];
    expect(interpretSetupRun(events, "working").question).toBeNull();
  });

  it("clears the text question once the person answered", () => {
    const events: SetupRunEvent[] = [
      say("**What's your name?**"),
      turnDone,
      user("Jacob"),
    ];
    expect(interpretSetupRun(events, "working").question).toBeNull();
  });

  it("asks the next text question after the answer, one at a time", () => {
    const events: SetupRunEvent[] = [
      say("**What's your name?**"),
      turnDone,
      user("Jacob"),
      say("Nice to meet you, Jacob.\n\n**What do you do?**"),
      turnDone,
    ];
    const state = interpretSetupRun(events, "idle");
    expect(state.question).toEqual({ kind: "text", text: "What do you do?" });
    expect(state.stepStatuses.you).toBe("running");
  });

  it("renders a permission request as a plain permission card, without tool text", () => {
    const events: SetupRunEvent[] = [
      say("Checking what's already in place."),
      { kind: "permissionRequest", requestId: "perm-1", toolName: "Bash" },
    ];
    const state = interpretSetupRun(events, "needsYou");
    expect(state.question?.kind).toBe("permission");
    expect(state.question && "requestId" in state.question ? state.question.requestId : null).toBe("perm-1");
    expect(JSON.stringify(state.question)).not.toContain("Bash");
    expect(interpretSetupRun(events, "needsYou", ["perm-1"]).question).toBeNull();
  });

  it("trailing-question helper strips markdown and ignores non-questions", () => {
    expect(setupRunTrailingQuestion("Hello.\n\n**What do you do?**")).toBe("What do you do?");
    expect(setupRunTrailingQuestion("All done.")).toBeNull();
  });
});

describe("interpretSetupRun — finish and stop", () => {
  it("finishes when the agent says the person is set up, ticking every step", () => {
    const events: SetupRunEvent[] = [
      say("Signed in as jacob@example.com."),
      say("You're all set — here's your welcome page (private to you): https://x.example/welcome\n\nYour first move:\n\n  /plan my first project"),
      turnDone,
    ];
    const state = interpretSetupRun(events, "idle");
    expect(state.done).toBe(true);
    expect(state.ended).toBe(false);
    expect(state.question).toBeNull();
    expect(Object.values(state.stepStatuses)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(state.summary).toBe(SETUP_RUN_DONE.summary);
  });

  it("finishes on the explicit moves=done marker", () => {
    const state = interpretSetupRun([say("[hq-setup] step=moves status=done")]);
    expect(state.stepStatuses.moves).toBe("done");
    expect(state.step).toBe(5);
  });

  it("reports a session that exited before finishing as ended, not done", () => {
    const events: SetupRunEvent[] = [say("Checking what's already in place."), { kind: "exited", code: 1 }];
    const state = interpretSetupRun(events, "ended");
    expect(state.ended).toBe(true);
    expect(state.done).toBe(false);
    expect(state.question).toBeNull();
  });

  it("treats an ended phase with no exit event as ended too", () => {
    expect(interpretSetupRun([say("Checking tools.")], "ended").ended).toBe(true);
  });

  it("names an expired sign-in as an auth failure, from an error event or the agent's last words", () => {
    const viaEvent = interpretSetupRun(
      [say("Checking tools."), { kind: "error", message: "Failed to refresh OAuth token: conflict" }, { kind: "exited", code: 1 }],
      "ended",
    );
    expect(viaEvent.ended).toBe(true);
    expect(viaEvent.failure).toEqual({ kind: "auth", message: "Failed to refresh OAuth token: conflict" });

    const viaProse = interpretSetupRun(
      [say("Failed to authenticate: OAuth session expired and could not be refreshed"), { kind: "turnDone", status: "error", error: null }],
      "ended",
    );
    expect(viaProse.failure?.kind).toBe("auth");

    const other = interpretSetupRun([say("Checking tools."), { kind: "error", message: "Process crashed" }, { kind: "exited", code: 1 }], "ended");
    expect(other.failure).toEqual({ kind: "other", message: "Process crashed" });

    // A clean finish and a quiet stop carry no failure.
    expect(interpretSetupRun([say("You're all set up.")], "working").failure).toBeNull();
    expect(interpretSetupRun([say("Checking tools."), { kind: "exited", code: 0 }], "ended").failure?.kind).toBe("other");
  });

  it("classifySetupFailure tells sign-in trouble from the rest and ignores blank text", () => {
    expect(classifySetupFailure("OAuth session expired")?.kind).toBe("auth");
    expect(classifySetupFailure("Please sign in to Claude")?.kind).toBe("auth");
    expect(classifySetupFailure("Not logged in")?.kind).toBe("auth");
    expect(classifySetupFailure("Invalid API key · credential rejected")?.kind).toBe("auth");
    expect(classifySetupFailure("Something else broke")?.kind).toBe("other");
    expect(classifySetupFailure("   ")).toBeNull();
  });
});

describe("resume record", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips the session id and step", () => {
    expect(loadSetupRunRecord()).toBeNull();
    saveSetupRunRecord({ sessionId: "sess-1", step: 2, status: "running" });
    expect(window.localStorage.getItem(SETUP_RUN_SESSION_KEY)).toBeTruthy();
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 2, status: "running" });
    clearSetupRunRecord();
    expect(loadSetupRunRecord()).toBeNull();
  });

  it("keeps the outcome and treats an old record without one as still running", () => {
    saveSetupRunRecord({ sessionId: "sess-1", step: 3, status: "done" });
    expect(loadSetupRunRecord()?.status).toBe("done");
    saveSetupRunRecord({ sessionId: "sess-1", step: 1, status: "ended" });
    expect(loadSetupRunRecord()?.status).toBe("ended");
    window.localStorage.setItem(SETUP_RUN_SESSION_KEY, JSON.stringify({ sessionId: "sess-1", step: 1 }));
    expect(loadSetupRunRecord()?.status).toBe("running");
    window.localStorage.setItem(SETUP_RUN_SESSION_KEY, JSON.stringify({ sessionId: "sess-1", step: 1, status: "bogus" }));
    expect(loadSetupRunRecord()?.status).toBe("running");
  });

  it("clamps a bad step and rejects garbage", () => {
    window.localStorage.setItem(SETUP_RUN_SESSION_KEY, JSON.stringify({ sessionId: "s", step: 99 }));
    expect(loadSetupRunRecord()).toEqual({ sessionId: "s", step: 5, status: "running" });
    window.localStorage.setItem(SETUP_RUN_SESSION_KEY, "{not json");
    expect(loadSetupRunRecord()).toBeNull();
    window.localStorage.setItem(SETUP_RUN_SESSION_KEY, JSON.stringify({ step: 1 }));
    expect(loadSetupRunRecord()).toBeNull();
  });

  it("tolerates unavailable storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
      removeItem: () => {
        throw new Error("nope");
      },
    };
    expect(() => saveSetupRunRecord({ sessionId: "s", step: 0, status: "running" }, broken)).not.toThrow();
    expect(loadSetupRunRecord(broken)).toBeNull();
    expect(() => clearSetupRunRecord(broken)).not.toThrow();
  });

  it("labels the resume affordance N of 6", () => {
    expect(setupRunContinueLabel(0)).toBe("Continue setup (1 of 6)");
    expect(setupRunContinueLabel(2)).toBe("Continue setup (3 of 6)");
    expect(setupRunContinueLabel(9)).toBe("Continue setup (6 of 6)");
  });
});

describe("guided cards", () => {
  const say = (text: string) => ({ kind: "assistantMessage", text }) as const;
  const ask = (requestId: string, header: string, options: string[], multiSelect = false) =>
    ({
      kind: "questionRequest",
      requestId,
      questions: [{ id: "q1", header, text: `${header}?`, options: options.map((label) => ({ label })), multiSelect }],
    }) as const;

  it("parses the three card kinds and rejects malformed ones", () => {
    expect(parseSetupCard('{"kind":"found","items":[{"label":"Claude Code sessions","count":12},{"label":"Plans","detail":"3 files"}]}')).toEqual({
      kind: "found",
      title: undefined,
      items: [
        { label: "Claude Code sessions", count: 12, detail: null },
        { label: "Plans", count: null, detail: "3 files" },
      ],
    });
    expect(parseSetupCard('{"kind":"integrations","items":[{"name":"Linear","auth":"oauth"},{"name":"GitHub","status":"connected"}]}')).toMatchObject({
      kind: "integrations",
      items: [
        { name: "Linear", auth: "oauth", status: "available" },
        { name: "GitHub", status: "connected" },
      ],
    });
    expect(parseSetupCard('{"kind":"secret","name":"DATABASE_URL","label":"Postgres","scope":"company","company":"hqtestco"}')).toEqual({
      kind: "secret",
      name: "DATABASE_URL",
      label: "Postgres",
      hint: null,
      scope: "company",
      company: "hqtestco",
    });
    expect(parseSetupCard('{"kind":"secret","name":"--token"}')).toBeNull();
    expect(parseSetupCard('{"kind":"integrations","items":[]}')).toBeNull();
    expect(parseSetupCard("not json")).toBeNull();
    expect(parseSetupCard('{"kind":"other"}')).toBeNull();
  });

  it("a card marker rides with the next question and carries its header", () => {
    const state = interpretSetupRun(
      [
        say('[hq-setup] step=import status=running\nQuick check for prior work.\n[hq-setup] card={"kind":"found","items":[{"label":"Claude Code sessions","count":12}]}'),
        ask("req-1", "Import", ["Import now", "Preview first", "Skip"]),
      ],
      "needsYou",
    );
    expect(state.step).toBe(2);
    expect(state.stepStatuses.import).toBe("running");
    expect(state.question).toMatchObject({ kind: "choice", header: "Import", requestId: "req-1" });
    expect(state.card).toMatchObject({ kind: "found", items: [{ label: "Claude Code sessions", count: 12 }] });
    // The marker line is never the status sentence.
    expect(state.statusLine).toBe("Quick check for prior work.");
  });

  it("the card survives the AskUserQuestion tool call that carries its question", () => {
    const state = interpretSetupRun(
      [
        say('I found a little prior history.\n\n[hq-setup] card={"kind":"found","items":[{"label":"Claude Code sessions","count":5}]}'),
        { kind: "toolCall", id: "t1", name: "AskUserQuestion" },
        ask("req-1", "Import", ["Import now", "Skip"]),
      ],
      "needsYou",
    );
    expect(state.card).toMatchObject({ kind: "found", items: [{ label: "Claude Code sessions", count: 5 }] });
    // Any other tool call means the agent moved on.
    const moved = interpretSetupRun(
      [
        say('[hq-setup] card={"kind":"found","items":[{"label":"Plans","count":1}]}'),
        { kind: "toolCall", id: "t2", name: "Bash" },
        ask("req-2", "Import", ["Import now", "Skip"]),
      ],
      "needsYou",
    );
    expect(moved.card).toBeNull();
  });

  it("the card clears once the question is answered and work resumes", () => {
    const events = [
      say('[hq-setup] card={"kind":"secret","name":"DATABASE_URL"}'),
      ask("req-1", "Secret", ["Done", "Skip"]),
    ];
    expect(interpretSetupRun(events, "needsYou").card).toMatchObject({ kind: "secret" });
    expect(interpretSetupRun(events, "needsYou", ["req-1"]).card).toBeNull();
    expect(interpretSetupRun([...events, { kind: "toolCall", id: "t1" }], "working").card).toBeNull();
    expect(interpretSetupRun([...events, { kind: "userMessage", text: "skip" }], "working").card).toBeNull();
  });

  it("connect and import steps are recognised from prose too", () => {
    expect(interpretSetupRun([say("Looks like there may be some prior Claude usage on disk. I can mine past artifacts.")]).step).toBe(2);
    expect(interpretSetupRun([say("For each system of record with a credential, let's connect it now.")]).step).toBe(4);
  });
});
