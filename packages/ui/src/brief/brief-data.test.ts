import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarToday, configureBriefSeed, gatherBriefInput, signalsByKind, type BriefAdapter } from "./brief-data.js";
import { octoberEightBrief } from "./brief-fixture.js";

const NOW = new Date(2026, 9, 8, 7, 40);
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
const err = (code: string) => Promise.resolve({ ok: false as const, reason: "error" as const, code });

function fakeAdapter(): BriefAdapter & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    identity: { whoami: () => ok({ personUid: "prs_me", email: "corey@getindigo.ai", displayName: "Corey Epstein" }) },
    meetings: {
      listUpcoming: () =>
        ok([
          { id: "e1", summary: "Dev standup", start: { dateTime: at(8, 9) }, end: { dateTime: at(8, 9, 30) }, status: "confirmed" },
          {
            id: "e2",
            summary: "Zach and Jeff onboarding",
            start: { dateTime: at(8, 10) },
            end: { dateTime: at(8, 11) },
            status: "confirmed",
            attendees: [{ email: "corey@getindigo.ai" }, { email: "zach@acme.com" }],
          },
          { id: "e3", summary: "Cut30 office hours", start: { dateTime: at(8, 13) }, end: { dateTime: at(8, 14) }, status: "confirmed" },
          { id: "e4", summary: "Tomorrow thing", start: { dateTime: at(9, 9) }, end: { dateTime: at(9, 10) }, status: "confirmed" },
          { id: "e5", summary: "Cancelled", start: { dateTime: at(8, 15) }, end: { dateTime: at(8, 16) }, status: "cancelled" },
        ]),
      listRecorded: (companyId) =>
        companyId === "cmp_indigo"
          ? ok({
              meetings: [
                { meetingId: "m1", title: "Sales sync", startTime: at(7, 9), hasSignals: true, companyId: "cmp_indigo" },
                { meetingId: "m0", title: "Last week", startTime: at(1, 9), hasSignals: true, companyId: "cmp_indigo" },
              ],
            })
          : err("http-500"),
      getRecorded: () =>
        ok({
          signals: {
            decision: [{ presigned_url: "u-d1" }, { presigned_url: "u-d2" }],
            action_item: [{ presigned_url: "u-a1" }],
            question: [{ presigned_url: "u-q1" }],
            risk: [{ title: "Pipeline thin in Q4" }],
            summary: [{ presigned_url: "u-s" }],
          },
        }),
      readRecordedBody: (url) => {
        bodies.push(url);
        return ok(
          url === "u-q1"
            ? "---\ntype: question\n---\n# Question\nKeep the no-self-merge rule? It slows every PR."
            : "---\ntype: action\n---\nSend Jacob the memo folder.",
        );
      },
    },
    notifications: {
      fetchDmThreads: () =>
        ok({
          threads: [
            { peerUid: "prs_izzy", peerName: "Izzy Park", lastActivityAt: at(7, 15) },
            { peerUid: "prs_hassaan", peerName: "Hassaan Ali", lastActivityAt: at(7, 16), lastFromSelf: true },
            { peerUid: "prs_old", peerName: "Old Thread", lastActivityAt: at(1, 16) },
          ],
        }),
    },
    agents: {
      listLocalSessions: () =>
        ok({
          total: 2,
          rows: [
            { sessionId: "s1", startedAt: at(7, 13, 40), company: "indigo", project: "hq-core", title: "Bot parity" },
            { sessionId: "s2", startedAt: at(7, 14), company: "acme", project: "acme-secret", title: "Acme pricing" },
          ],
        }),
    },
  };
}

const companies = [
  { uid: "cmp_indigo", slug: "indigo", label: "Indigo" },
  { uid: "cmp_liverecover", slug: "liverecover", label: "LiveRecover" },
];

afterEach(() => configureBriefSeed(null));

describe("gatherBriefInput", () => {
  it("maps every live source into the brief input", async () => {
    const log = vi.fn();
    const { input, failures } = await gatherBriefInput(fakeAdapter(), { now: NOW, companies, log, lastBriefAt: null });
    expect(input.userName).toBe("Corey");
    expect(input.calendarToday.map((e) => [e.title, e.kind])).toEqual([
      ["Dev standup", "team"],
      ["Zach and Jeff onboarding", "ext"],
      ["Cut30 office hours", "learn"],
    ]);
    expect(input.meetingsYesterday).toEqual([
      expect.objectContaining({ id: "m1", title: "Sales sync", decisions: 2, actions: 1, risks: 1, questions: 1 }),
    ]);
    expect(input.decisions).toEqual([
      expect.objectContaining({ title: "Keep the no-self-merge rule?", action: "decide", origin: { companyUid: "cmp_indigo", repo: "Sales sync" } }),
    ]);
    expect(input.actionItems.map((a) => a.title)).toEqual(["Send Jacob the memo folder."]);
    expect(input.risks).toEqual([expect.objectContaining({ title: "Pipeline thin in Q4", severity: "watch" })]);
    expect(input.team.map((t) => t.name)).toEqual(["Izzy", "Hassaan"]);
    expect(input.waitingOn).toEqual([{ id: "prs_hassaan", who: "Hassaan", what: "to reply to your DM" }]);
    expect(input.dmCount).toBe(2);
    expect(input.sessions.map((s) => s.company)).toEqual(["indigo", "acme"]);
    expect(input.companies).toEqual(["cmp_indigo", "indigo", "cmp_liverecover", "liverecover"]);
    expect(input.shipped).toEqual([]);
    // The second company's list failed: logged and recorded, not swallowed.
    expect(failures).toEqual(["meetings LiveRecover"]);
    expect(log).toHaveBeenCalledWith("meetings LiveRecover failed", "meetings LiveRecover: error (http-500)");
  });

  it("still returns a brief when every source is missing or failing", async () => {
    const log = vi.fn();
    const broken: BriefAdapter = {
      identity: { whoami: () => err("http-401") },
      meetings: { listUpcoming: () => Promise.reject(new Error("offline")) },
      notifications: null,
    };
    const { input, failures } = await gatherBriefInput(broken, { now: NOW, companies, log });
    expect([...failures].sort()).toEqual(["calendar", "dm threads", "identity", "meetings", "sessions"]);
    expect(log).toHaveBeenCalledTimes(5);
    expect(input.calendarToday).toEqual([]);
    expect(input.decisions).toEqual([]);
    expect(input.userName).toBe("");
  });

  it("caps signal body reads", async () => {
    const adapter = fakeAdapter();
    await gatherBriefInput(adapter, { now: NOW, companies, log: () => {} });
    expect(adapter.bodies.length).toBeLessThanOrEqual(10);
    expect(adapter.bodies).not.toContain("u-s");
  });

  it("serves the seed instead of the adapter when one is configured", async () => {
    configureBriefSeed(() => octoberEightBrief(NOW));
    const adapter = fakeAdapter();
    const spy = vi.spyOn(adapter.meetings!, "listUpcoming");
    const { input } = await gatherBriefInput(adapter, { now: NOW, companies });
    expect(input.decisions).toHaveLength(4);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parsers", () => {
  it("drops events without a timed start today", () => {
    expect(calendarToday([{ id: "x", summary: "All day", start: { date: "2026-10-08" }, end: {} }], NOW, "a@b.c")).toEqual([]);
  });

  it("groups signal types and ignores unknown ones", () => {
    const out = signalsByKind({ signals: { decisions: [{}], key_point: [{}], risks: [{}, {}] } });
    expect([out.decisions.length, out.risks.length, out.actions.length]).toEqual([1, 2, 0]);
  });
});

describe("mergePastMeetings", () => {
  it("adds today's earlier recorded calls the calendar feed no longer lists, once", async () => {
    const { mergePastMeetings } = await import("./brief-data.js");
    const now = new Date("2026-10-09T21:00:00Z");
    const cal = [{ id: "c1", title: "Standup", start: "2026-10-09T16:00:00Z", kind: "team" as const }];
    const rec = [
      { id: "r1", title: "standup", start: "2026-10-09T16:05:00Z", kind: "team" as const },
      { id: "r2", title: "Jacob / Amir", start: "2026-10-09T15:00:00Z", kind: "team" as const },
      { id: "r3", title: "Later", start: "2026-10-09T23:00:00Z", kind: "team" as const },
    ];
    expect(mergePastMeetings(cal, rec, now).map((e) => e.id)).toEqual(["r2", "c1"]);
  });
});
