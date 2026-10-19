import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import {
  BRIEF_QUIET_MS,
  BRIEF_START_TIMEOUT_MS,
  BRIEF_STALL_TIMEOUT_MS,
  advanceBriefRun,
  briefJobMessage,
  failedMessage,
  stillWorkingLine,
  waitingStep,
  briefRunFolder,
  briefRunId,
  briefRunPath,
  checkBriefBot,
  isBriefRunId,
  latestReadyRun,
  parseBriefIndex,
  parseBriefStatus,
  pickBriefBot,
  previousReadyRun,
  relativeRunLabel,
  runIdTime,
  stepRun,
  type BriefCreatePhase,
} from "./brief-runs.js";
import { sweepPath } from "./brief-data.js";

describe("run id and folder resolution", () => {
  it("mints brief-YYYYMMDD-HHMMSS in local time", () => {
    expect(briefRunId(new Date(2026, 9, 8, 7, 4, 9))).toBe("brief-20261008-070409");
    expect(briefRunId(new Date(2026, 0, 1, 23, 59, 59))).toBe("brief-20260101-235959");
  });

  it("round-trips the id back to its local time", () => {
    const at = new Date(2026, 9, 8, 7, 4, 9);
    expect(runIdTime(briefRunId(at))?.getTime()).toBe(at.getTime());
    expect(runIdTime("brief-1791500000")?.getTime()).toBe(1791500000 * 1000);
    expect(runIdTime("nope")).toBeNull();
  });

  it("resolves each run file inside workspace/brief/<run_id>/", () => {
    expect(briefRunFolder("brief-20261008-070409")).toBe("workspace/brief/brief-20261008-070409");
    expect(briefRunPath("brief-20261008-070409", "status.json")).toBe("workspace/brief/brief-20261008-070409/status.json");
    expect(briefRunPath("brief-20261008-070409", "housekeeping.json")).toBe(
      "workspace/brief/brief-20261008-070409/housekeeping.json",
    );
    // The skill's own fallback id is accepted too.
    expect(briefRunPath("brief-1791500000", "brief.json")).toBe("workspace/brief/brief-1791500000/brief.json");
  });

  it("refuses ids that could leave the brief folder", () => {
    for (const bad of ["../secrets", "brief-20261008-070409/../../x", "2026-10-08", "", "brief-", "brief-2026"]) {
      expect(isBriefRunId(bad)).toBe(false);
      expect(() => briefRunFolder(bad)).toThrow();
    }
  });

  it("sweepPath reads the run folder when there is a run, the per-day folder otherwise", () => {
    const now = new Date(2026, 9, 9, 7, 40);
    expect(sweepPath(now, "brief-20261009-074000")).toBe("workspace/brief/brief-20261009-074000/brief-data.json");
    expect(sweepPath(now, null)).toBe("workspace/brief/2026-10-09/brief-data.json");
    expect(sweepPath(now)).toBe("workspace/brief/2026-10-09/brief-data.json");
  });
});

describe("parseBriefIndex", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const base = {
    window: { from: "2026-10-03T00:00:00Z", to: "2026-10-08T09:00:00Z" },
    catch_up: false,
    lead: "decisions",
    counts: { decisions: 3, shipped: 5, incidents: 1 },
    headline: "Three calls wait on you",
  };

  it("returns entries newest first with every field mapped", () => {
    const text = [
      line({ ...base, run_id: "brief-20261006-080000", created_at: "2026-10-06T15:00:00Z", state: "ready" }),
      line({ ...base, run_id: "brief-20261008-090000", created_at: "2026-10-08T16:00:00Z", state: "ready", catch_up: true }),
      line({ ...base, run_id: "brief-20261007-090000", created_at: "2026-10-07T16:00:00Z", state: "failed" }),
    ].join("\n");
    const { entries, skipped } = parseBriefIndex(text);
    expect(skipped).toBe(0);
    expect(entries.map((e) => e.runId)).toEqual(["brief-20261008-090000", "brief-20261007-090000", "brief-20261006-080000"]);
    expect(entries[0]).toEqual({
      runId: "brief-20261008-090000",
      createdAt: "2026-10-08T16:00:00Z",
      window: { from: "2026-10-03T00:00:00Z", to: "2026-10-08T09:00:00Z" },
      state: "ready",
      catchUp: true,
      lead: "decisions",
      counts: { decisions: 3, shipped: 5, incidents: 1 },
      headline: "Three calls wait on you",
      durationMs: null,
      finishedAt: null,
    });
  });

  it("skips blank, malformed and unsafe lines and counts them", () => {
    const text = [
      "",
      "{not json",
      line({ ...base, run_id: "../../etc", created_at: "2026-10-08T16:00:00Z", state: "ready" }),
      line({ ...base, run_id: "brief-20261008-090000", created_at: "2026-10-08T16:00:00Z", state: "done" }),
      line({ ...base, run_id: "brief-20261008-100000", created_at: "2026-10-08T17:00:00Z", state: "ready" }),
      "   ",
    ].join("\r\n");
    const { entries, skipped } = parseBriefIndex(text);
    expect(entries.map((e) => e.runId)).toEqual(["brief-20261008-100000"]);
    expect(skipped).toBe(3);
  });

  it("keeps the last line for a run listed twice", () => {
    const text = [
      line({ ...base, run_id: "brief-20261008-090000", created_at: "2026-10-08T16:00:00Z", state: "failed" }),
      line({ ...base, run_id: "brief-20261008-090000", created_at: "2026-10-08T16:00:00Z", state: "ready", headline: "Retry" }),
    ].join("\n");
    const { entries } = parseBriefIndex(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe("ready");
    expect(entries[0]!.headline).toBe("Retry");
  });

  it("falls back to the id's time and safe defaults when fields are missing", () => {
    const { entries } = parseBriefIndex(line({ run_id: "brief-20261008-090000", state: "ready", counts: { decisions: "x" } }));
    expect(entries[0]!.createdAt).toBe(new Date(2026, 9, 8, 9, 0, 0).toISOString());
    expect(entries[0]!.window).toBeNull();
    expect(entries[0]!.counts).toEqual({ decisions: 0, shipped: 0, incidents: 0 });
    expect(entries[0]!.catchUp).toBe(false);
  });

  it("latestReadyRun skips failed and running runs; stepRun walks older and newer", () => {
    const text = [
      line({ ...base, run_id: "brief-20261008-100000", created_at: "2026-10-08T17:00:00Z", state: "running" }),
      line({ ...base, run_id: "brief-20261008-090000", created_at: "2026-10-08T16:00:00Z", state: "failed" }),
      line({ ...base, run_id: "brief-20261007-090000", created_at: "2026-10-07T16:00:00Z", state: "ready" }),
      line({ ...base, run_id: "brief-20261006-090000", created_at: "2026-10-06T16:00:00Z", state: "ready" }),
    ].join("\n");
    const { entries } = parseBriefIndex(text);
    expect(latestReadyRun(entries)?.runId).toBe("brief-20261007-090000");
    expect(latestReadyRun([])).toBeNull();
    const mid = stepRun(entries, "brief-20261007-090000");
    expect(mid.newer?.runId).toBe("brief-20261008-090000");
    expect(mid.older?.runId).toBe("brief-20261006-090000");
    expect(stepRun(entries, "brief-20261006-090000").older).toBeNull();
    expect(stepRun(entries, "brief-20261008-100000").newer).toBeNull();
    expect(stepRun(entries, null)).toEqual({ older: null, newer: null, index: -1 });
  });
});

describe("relativeRunLabel", () => {
  const now = new Date(2026, 9, 8, 15, 0);
  it("labels by created time, never 'today'", () => {
    expect(relativeRunLabel(new Date(2026, 9, 8, 14, 59, 30).toISOString(), now)).toBe("Just now");
    expect(relativeRunLabel(new Date(2026, 9, 8, 14, 20).toISOString(), now)).toBe("40m ago");
    expect(relativeRunLabel(new Date(2026, 9, 8, 9, 14).toISOString(), now)).toBe("5h ago · 9:14 AM");
    expect(relativeRunLabel(new Date(2026, 9, 7, 9, 14).toISOString(), now)).toBe("Yesterday · 9:14 AM");
    expect(relativeRunLabel(new Date(2026, 9, 5, 9, 14).toISOString(), now)).toBe("Mon, Oct 5 · 9:14 AM");
    for (const h of [1, 5, 9]) expect(relativeRunLabel(new Date(2026, 9, 8, h).toISOString(), now)).not.toMatch(/today/i);
  });
});

describe("status polling state machine", () => {
  const RUN = "brief-20261008-090000";
  const status = (o: Record<string, unknown>) => ({ text: JSON.stringify({ run_id: RUN, started_at: "s", ...o }) });
  const waiting: BriefCreatePhase = { kind: "waiting", runId: RUN, sentAt: 1_000 };

  it("parses status.json and clamps progress", () => {
    expect(parseBriefStatus(JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping", progress: 4 }))?.progress).toBe(1);
    expect(parseBriefStatus("{oops")).toBeNull();
  });

  // hq-core 16.0.30 writes state running|ready|failed. A status.json for this
  // run is proof the skill started, whatever word it carries.
  it("a status for this run with a state word it does not know counts as started", () => {
    for (const word of ["queued", "starting", "sweeping", "", 7, null]) {
      expect(parseBriefStatus(JSON.stringify({ run_id: RUN, state: word }))?.state).toBe("running");
      const next = advanceBriefRun(waiting, status({ state: word }), 5_000);
      expect(next).toMatchObject({ kind: "running", runId: RUN });
    }
    // No state at all, and a status written without its run_id inside this run's own folder.
    expect(advanceBriefRun(waiting, status({}), 5_000)).toMatchObject({ kind: "running" });
    expect(advanceBriefRun(waiting, { text: JSON.stringify({ step: "Sweeping" }) }, 5_000)).toMatchObject({ kind: "running", step: "Sweeping" });
    expect(parseBriefStatus(JSON.stringify({ state: "running" }))).toBeNull();
    expect(parseBriefStatus("[]")).toBeNull();
  });

  it("each 16.0.30 status word lands: running, ready, failed", () => {
    const running = advanceBriefRun(waiting, status({ state: "running", step: "Reading your calendar", progress: 0.2, updated_at: "a" }), 5_000);
    expect(running).toMatchObject({ kind: "running", step: "Reading your calendar", progress: 0.2 });
    expect(advanceBriefRun(running, status({ state: "ready", progress: 1, updated_at: "b" }), 6_000)).toEqual({ kind: "ready", runId: RUN });
    expect(advanceBriefRun(running, status({ state: "failed", error: "Calendar is not connected." }), 6_000)).toEqual({
      kind: "failed",
      runId: RUN,
      message: "Calendar is not connected.",
    });
    // A fast run that wrote running then ready between two polls still lands.
    expect(advanceBriefRun(waiting, status({ state: "ready", progress: 1 }), 2_000)).toEqual({ kind: "ready", runId: RUN });
    expect(advanceBriefRun(waiting, status({ state: "failed", error: "Calendar is not connected." }), 2_000)).toMatchObject({ kind: "failed" });
    // The activity words the skill writes all survive.
    const activity = ["running", "done", "skipped", "failed"].map((state, i) => ({ at: `t${i}`, label: `step ${i}`, state }));
    expect(parseBriefStatus(JSON.stringify({ run_id: RUN, state: "running", activity }))?.activity.map(a => a.state)).toEqual([
      "running",
      "done",
      "skipped",
      "failed",
    ]);
  });

  it("waits while no status file exists, then fails after the start timeout", () => {
    expect(advanceBriefRun(waiting, { text: null }, 2_000)).toBe(waiting);
    expect(advanceBriefRun(waiting, { error: "denied" }, 2_000)).toBe(waiting);
    const late = advanceBriefRun(waiting, { text: null }, 1_000 + BRIEF_START_TIMEOUT_MS + 1);
    expect(late.kind).toBe("failed");
  });

  it("moves waiting -> running with the step text, and tracks change", () => {
    const r1 = advanceBriefRun(waiting, status({ state: "running", step: "Sweeping your day", progress: 0.3, updated_at: "a" }), 5_000);
    expect(r1).toMatchObject({ kind: "running", step: "Sweeping your day", progress: 0.3, lastChangeAt: 5_000 });
    const same = advanceBriefRun(r1, status({ state: "running", step: "Sweeping your day", progress: 0.3, updated_at: "a" }), 9_000);
    expect(same).toMatchObject({ kind: "running", lastChangeAt: 5_000 });
    const moved = advanceBriefRun(same, status({ state: "running", step: "Writing your brief", progress: 0.9, updated_at: "b" }), 12_000);
    expect(moved).toMatchObject({ step: "Writing your brief", progress: 0.9, lastChangeAt: 12_000 });
  });

  it("a mid-write unreadable status keeps the running phase", () => {
    const r1 = advanceBriefRun(waiting, status({ state: "running", step: "x", progress: 0.2 }), 5_000);
    expect(advanceBriefRun(r1, { text: "{\"run_id\":" }, 6_000)).toBe(r1);
  });

  it("fails a run whose status stops changing", () => {
    const r1 = advanceBriefRun(waiting, status({ state: "running", step: "Sweeping", progress: 0.3, updated_at: "a" }), 5_000);
    const stalled = advanceBriefRun(r1, status({ state: "running", step: "Sweeping", progress: 0.3, updated_at: "a" }), 5_000 + BRIEF_STALL_TIMEOUT_MS + 1);
    expect(stalled).toMatchObject({ kind: "failed", runId: RUN });
    const gone = advanceBriefRun(r1, { text: null }, 5_000 + BRIEF_STALL_TIMEOUT_MS + 1);
    expect(gone.kind).toBe("failed");
  });

  it("ends ready or failed, carrying the skill's error", () => {
    expect(advanceBriefRun(waiting, status({ state: "ready", progress: 1 }), 5_000)).toEqual({ kind: "ready", runId: RUN });
    expect(advanceBriefRun(waiting, status({ state: "failed", error: "GitHub is not signed in." }), 5_000)).toEqual({
      kind: "failed",
      runId: RUN,
      message: "GitHub is not signed in.",
    });
    expect(advanceBriefRun(waiting, status({ state: "failed" }), 5_000)).toMatchObject({ kind: "failed", message: expect.any(String) });
  });

  it("a failure written as `status:` (the 2026-10-13 skill_not_found run) ends the run on the heal path, never the bot's sentence", () => {
    const written = {
      text: JSON.stringify({
        run_id: RUN,
        status: "failed",
        error: "skill_not_found",
        message: "No daily-brief skill is installed in this HQ.",
      }),
    };
    expect(parseBriefStatus(written.text)).toMatchObject({ state: "failed", error: "skill_not_found", message: "No daily-brief skill is installed in this HQ." });
    expect(advanceBriefRun(waiting, written, 5_000)).toEqual({
      kind: "failed",
      runId: RUN,
      message: "Your brief is taking longer than expected.",
      heal: "skill-not-found",
    });
    // The job asks for exactly this when the skill is missing (state + error).
    expect(advanceBriefRun(waiting, status({ state: "failed", error: "skill_not_found" }), 5_000)).toMatchObject({ heal: "skill-not-found" });
    // `state` wins when both are present, and a bare code is never shown as the message.
    expect(advanceBriefRun(waiting, status({ state: "running", status: "failed", step: "Sweeping" }), 5_000)).toMatchObject({ kind: "running" });
    expect(failedMessage({ state: "failed", error: "skill_not_found", message: null })).toBe("Your brief is taking longer than expected.");
    expect(failedMessage({ state: "failed", error: "skill_not_found", message: "No daily-brief skill is installed in this HQ." })).toBe(
      "Your brief is taking longer than expected.",
    );
    expect(failedMessage({ state: "failed", error: "The sweep could not read GitHub.", message: null })).toBe("The sweep could not read GitHub.");
  });

  it("a cancelled run ends like a failure, with the person's own reason", () => {
    expect(advanceBriefRun(waiting, status({ state: "cancelled", step: "Sweeping your day" }), 5_000)).toEqual({
      kind: "failed",
      runId: RUN,
      message: "You cancelled this brief.",
    });
    expect(parseBriefStatus(JSON.stringify({ run_id: RUN, state: "cancelled", error: "Stopped at Sweeping your day." }))?.state).toBe("cancelled");
  });

  // The raw operator text ("Sent to Jellybean", "Check that it is running")
  // never reaches the person: waiting and the start timeout are plain lines.
  it("never names the bot or tells the person to check it while waiting or on the start timeout", () => {
    const named: BriefCreatePhase = { kind: "waiting", runId: RUN, sentAt: 1_000, bot: "Jellybean" };
    expect(waitingStep("Jellybean")).toBe("Getting your brief started");
    expect(waitingStep(null)).toBe("Getting your brief started");
    expect(stillWorkingLine(named, 1_000 + BRIEF_QUIET_MS)).toBe("Still getting your brief started…");
    expect(stillWorkingLine(named, 1_000 + BRIEF_QUIET_MS - 1)).toBeNull();
    const late = advanceBriefRun(named, { text: null }, 1_000 + BRIEF_START_TIMEOUT_MS + 1);
    expect(late).toEqual({ kind: "failed", runId: RUN, message: "Your brief is taking longer than expected.", heal: "start-timeout" });
    expect(advanceBriefRun(waiting, { text: null }, 1_000 + BRIEF_START_TIMEOUT_MS + 1)).toMatchObject({ heal: "start-timeout" });
    for (const line of [waitingStep("Jellybean"), stillWorkingLine(named, 1_000 + BRIEF_QUIET_MS), (late as { message: string }).message]) {
      expect(line).not.toMatch(/Jellybean|bot|check that it is running/i);
    }
    // A late start still wins over the clock: status arriving at the limit moves to running.
    expect(advanceBriefRun(named, status({ state: "running", step: "Starting", progress: 0.02 }), 1_000 + BRIEF_START_TIMEOUT_MS + 1)).toMatchObject({ kind: "running", step: "Starting" });
  });

  it("ignores a status written for another run and never moves terminal phases", () => {
    const other = { text: JSON.stringify({ run_id: "brief-20261007-090000", state: "ready" }) };
    expect(advanceBriefRun(waiting, other, 5_000)).toBe(waiting);
    const done: BriefCreatePhase = { kind: "ready", runId: RUN };
    expect(advanceBriefRun(done, status({ state: "failed" }), 5_000)).toBe(done);
    const idle: BriefCreatePhase = { kind: "idle" };
    expect(advanceBriefRun(idle, status({ state: "ready" }), 5_000)).toBe(idle);
  });
});

describe("the bot that runs the job", () => {
  const bot = (o: Partial<LocalBotRow>): LocalBotRow =>
    ({
      name: "pickles",
      agentUid: "agt_1",
      ownerUid: "prs_me",
      runtime: "claude",
      state: "running",
      pid: 1,
      processAlive: true,
      online: true,
      lastHeartbeatAt: null,
      daemonInstalled: true,
      daemonLoaded: true,
      dir: "/x",
      ...o,
    }) as LocalBotRow;

  it("prefers the setup bot, then the first personal bot on this computer", () => {
    const setup = bot({ name: "mochi", agentUid: "agt_s", workerId: "setup" });
    const personal = bot({ name: "pip", agentUid: "agt_p", kind: "personal" });
    const company = bot({ name: "co", agentUid: "agt_c", kind: "company" });
    const cloud = bot({ name: "setup", agentUid: "agt_cloud", hosting: "cloud" });
    expect(pickBriefBot([company, personal, setup])?.agentUid).toBe("agt_s");
    expect(pickBriefBot([cloud, company, personal])?.agentUid).toBe("agt_p");
    expect(pickBriefBot([cloud, company])).toBeNull();
  });

  it("blocks with a fix when no bot, sign-in expired, no model, or not running", () => {
    expect(checkBriefBot([], null)).toMatchObject({ ok: false, fix: "create-bot" });
    expect(checkBriefBot([bot({ runtimeSignIn: { state: "expired" } as LocalBotRow["runtimeSignIn"] })], null)).toMatchObject({
      ok: false,
      fix: "sign-in",
    });
    expect(checkBriefBot([bot({})], { claude: false, codex: true })).toMatchObject({ ok: false, fix: "connect-model" });
    expect(checkBriefBot([bot({ state: "stopped", processAlive: false })], { claude: true })).toMatchObject({
      ok: false,
      fix: "start-bot",
    });
    expect(checkBriefBot([bot({})], { claude: true })).toMatchObject({ ok: true });
    // Unknown preflight: only the bot's own report counts.
    expect(checkBriefBot([bot({})], null)).toMatchObject({ ok: true });
  });

  it("picks the assistant by its role marker over a leftover setup-named bot, and names it as the assistant", () => {
    const leftover = bot({ name: "setup", agentUid: "agt_old", role: undefined });
    const assistant = bot({ name: "ada", agentUid: "agt_a", role: "assistant" });
    expect(pickBriefBot([leftover, assistant])?.agentUid).toBe("agt_a");
    // An assistant with the reserved handle and no display name is never called "setup".
    const expired = bot({ name: "setup", role: "assistant", runtimeSignIn: { state: "expired" } as LocalBotRow["runtimeSignIn"] });
    const check = checkBriefBot([expired], null);
    expect(check).toMatchObject({ ok: false, fix: "sign-in" });
    expect(!check.ok && check.message).toBe("Your assistant needs you to sign in to Claude again before it can build a brief.");
    expect(!check.ok && check.message).not.toMatch(/setup/);
  });

  it("shows sign in again only while the assistant's own coding tool is signed out", () => {
    const expired = bot({ name: "setup", role: "assistant", state: "stopped", processAlive: false, runtimeSignIn: { state: "expired" } as LocalBotRow["runtimeSignIn"] });
    // A fresh preflight reads Claude as signed in: the stopped bot's old marker is stale.
    expect(checkBriefBot([expired], { claude: true })).toMatchObject({ ok: false, fix: "start-bot", message: "Your assistant is not running." });
    expect(checkBriefBot([expired], { claude: false })).toMatchObject({ ok: false, fix: "sign-in" });
    // Another bot's expired sign-in never blocks the assistant.
    const other = bot({ name: "pip", agentUid: "agt_p", kind: "personal", runtimeSignIn: { state: "expired" } as LocalBotRow["runtimeSignIn"] });
    const assistant = bot({ name: "setup", agentUid: "agt_a", role: "assistant" });
    expect(checkBriefBot([other, assistant], { claude: true })).toMatchObject({ ok: true, bot: { agentUid: "agt_a" } });
  });

  it("the job message names the person scope and run", () => {
    const msg = briefJobMessage("brief-20261008-090000");
    expect(msg.split("\n")[0]).toBe("/daily-brief --all --run-id brief-20261008-090000");
    expect(msg).toContain("workspace/brief/brief-20261008-090000/status.json");
    expect(msg.split("\n")[1]).toBe("");
    expect(msg).toContain("Run the daily-brief skill now with run_id brief-20261008-090000");
    expect(msg).toContain("every company in the person's lock");
    expect(msg).not.toContain("do not pick another company");
    expect(msg).not.toContain("--welcome");
  });

  it("the job tells the bot to report a missing skill as failed with skill_not_found", () => {
    for (const personal of [false, true]) {
      const msg = briefJobMessage("brief-20261008-090000", { personal });
      expect(msg).toContain(
        'If the daily-brief skill is not installed, write workspace/brief/brief-20261008-090000/status.json with run_id brief-20261008-090000, state "failed" and error "skill_not_found", and stop.',
      );
    }
  });

});

describe("previousReadyRun", () => {
  const line = (run_id: string, created_at: string, state: string) => JSON.stringify({ run_id, created_at, state });
  const { entries } = parseBriefIndex(
    [
      line("brief-20261008-090000", "2026-10-08T15:05:00Z", "ready"),
      line("brief-20261009-090000", "2026-10-09T15:05:00Z", "ready"),
      line("brief-20261010-090000", "2026-10-10T15:05:00Z", "failed"),
      line("brief-20261010-120000", "2026-10-10T18:05:00Z", "ready"),
      line("brief-20261011-090000", "2026-10-11T15:05:00Z", "ready"),
    ].join("\n"),
  );

  it("steps back from a listed run to the next ready one, skipping failed runs", () => {
    expect(previousReadyRun(entries, "brief-20261011-090000")?.runId).toBe("brief-20261010-120000");
    expect(previousReadyRun(entries, "brief-20261010-120000")?.runId).toBe("brief-20261009-090000");
    expect(previousReadyRun(entries, "brief-20261010-090000")?.runId).toBe("brief-20261009-090000");
    expect(previousReadyRun(entries, "brief-20261008-090000")).toBeNull();
  });

  it("for a run not yet listed, takes the newest ready run that started before it", () => {
    expect(previousReadyRun(entries, "brief-20261011-093000")?.runId).toBe("brief-20261011-090000");
    expect(previousReadyRun(entries, "brief-20261010-100000")?.runId).toBe("brief-20261009-090000");
    expect(previousReadyRun(entries, "brief-20261001-090000")).toBeNull();
  });

  it("with no run id, the latest ready run; with no entries, null", () => {
    expect(previousReadyRun(entries, null)?.runId).toBe("brief-20261011-090000");
    expect(previousReadyRun([], "brief-20261011-090000")).toBeNull();
  });
});
