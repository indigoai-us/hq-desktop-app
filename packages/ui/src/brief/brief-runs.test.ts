import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import {
  BRIEF_START_TIMEOUT_MS,
  BRIEF_STALL_TIMEOUT_MS,
  advanceBriefRun,
  briefJobMessage,
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
    expect(parseBriefStatus(JSON.stringify({ run_id: RUN, state: "queued" }))).toBeNull();
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

  it("the job message starts with the skill invocation and names the run and company", () => {
    const msg = briefJobMessage("brief-20261008-090000", "indigo");
    expect(msg.startsWith("/daily-brief indigo --run-id brief-20261008-090000")).toBe(true);
    expect(msg).toContain("workspace/brief/brief-20261008-090000/status.json");
    // The company is always the first argument and said again in plain words,
    // so a bot in several companies never picks one itself.
    const indigo = briefJobMessage("brief-20261009-090122", "indigo");
    expect(indigo.split("\n")[0]).toBe("/daily-brief indigo --run-id brief-20261009-090122");
    expect(indigo).toContain("for company indigo");
    expect(indigo).toContain("do not pick another company");
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
