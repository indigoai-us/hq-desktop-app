import { describe, expect, it, vi } from "vitest";
import { sweepToInput, parseSweep, type BriefSweep } from "./brief-sweep.js";
import { gatherBriefInput, sweepPath, adapterSweepSource, type BriefAdapter, type BriefSweepSource } from "./brief-data.js";
import { octoberEightBrief } from "./brief-fixture.js";
import sweepJson from "./fixtures/sweep-2026-10-08.json";

const sweep = sweepJson as unknown as BriefSweep;
const real = () => sweepToInput(sweep, { day: "2026-10-08", companyUid: "cmp_indigo" });

describe("sweepToInput on the real Oct 8 sweep", () => {
  it("carries the day's real PR totals and the window's PRs by repo", () => {
    const s = real();
    expect([s.merged, s.opened]).toEqual([87, 101]);
    expect(s.prWindow).toMatchObject({ from: "2026-10-04", to: "2026-10-08", total: 109, merged: 87 });
    expect(s.prWindow!.byRepo.slice(0, 3)).toEqual([
      { repo: "hq-core-staging", total: 41, merged: expect.any(Number) },
      { repo: "hq-desktop-app", total: 40, merged: expect.any(Number) },
      { repo: "hq-pro", total: 13, merged: expect.any(Number) },
    ]);
    const shippedPrs = s.shipped.reduce((n, x) => n + x.lines.length, 0);
    expect(shippedPrs).toBeGreaterThan(0);
    expect(s.shipped.every((x) => x.origin.repo?.startsWith("indigoai-us/"))).toBe(true);
  });

  it("maps fleet status, red main CI and meeting signal counts", () => {
    const s = real();
    expect(s.fleet).toEqual({ total: 44, active: 30, dormant: 10, provisioning: 4 });
    expect(s.risks).toEqual([
      expect.objectContaining({ id: "ci:hq-desktop-app", severity: "incident", title: "hq-desktop-app main CI red" }),
    ]);
    const sales = s.meetingsYesterday.find((m) => m.title === "HQ <> Sales Sync")!;
    expect([sales.decisions, sales.actions]).toEqual([3, 9]);
    expect(s.meetingsYesterday.length).toBeGreaterThanOrEqual(5);
  });

  it("leaves the owner out of their own team", () => {
    const team = sweepToInput(sweep, { day: "2026-10-08", companyUid: "cmp_indigo", selfName: "Corey Epstein" }).team;
    expect(team.some((t) => t.name === "Corey")).toBe(false);
  });

  it("labels agt_ DM senders as agents and drops the assistant", () => {
    const team = real().team;
    expect(team.find((t) => t.name === "Izzy")).toMatchObject({ isAgent: true });
    expect(team.find((t) => t.name === "Hassaan")).toMatchObject({ isAgent: false });
    expect(team.some((t) => t.name === "assistant")).toBe(false);
  });

  it("never carries another company's session titles", () => {
    const s = real();
    const other = s.sessions.filter((x) => x.company !== "cmp_indigo");
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((x) => x.title === "")).toBe(true);
  });

  it("rejects text that is not a JSON object", () => {
    expect(parseSweep("nope")).toBeNull();
    expect(parseSweep("[]")).toBeNull();
  });
});

describe("the preview fixture", () => {
  it("is real where the sweep has data and marks the rest as sample", () => {
    const day = octoberEightBrief(new Date(2026, 9, 9, 7, 40));
    expect([day.merged, day.opened]).toEqual([87, 101]);
    expect(day.decisions.every((d) => d.sample)).toBe(true);
    expect(day.waitingOn.every((w) => w.sample)).toBe(true);
    expect(day.calendarSample).toBe(true);
    expect(day.shipped.some((s) => s.sample)).toBe(false);
    expect(day.risks.filter((r) => !r.sample).map((r) => r.id)).toEqual(["ci:hq-desktop-app"]);
  });
});

describe("BriefSweepSource in gatherBriefInput", () => {
  const NOW = new Date(2026, 9, 9, 7, 40);
  const calendarEvent = { id: "e1", summary: "Live standup", start: { dateTime: new Date(2026, 9, 9, 9).toISOString() }, end: {}, status: "confirmed" };
  const adapter = (): BriefAdapter => ({
    identity: { whoami: async () => ({ ok: true as const, value: { personUid: "prs_me", email: "c@getindigo.ai", displayName: "Corey" } }) },
    meetings: { listUpcoming: async () => ({ ok: true as const, value: [calendarEvent] }) },
  });
  const companies = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo" }];

  it("reads workspace/brief/<date>/brief-data.json and merges it under the adapter", async () => {
    const reads: string[] = [];
    const source: BriefSweepSource = {
      readHqFile: async (path) => {
        reads.push(path);
        return JSON.stringify(sweepJson);
      },
    };
    const { input } = await gatherBriefInput(adapter(), { now: NOW, companies, sweep: source, log: () => {} });
    expect(reads).toEqual(["workspace/brief/2026-10-09/brief-data.json"]);
    expect(sweepPath(NOW)).toBe("workspace/brief/2026-10-09/brief-data.json");
    // Adapter wins for the calendar; the sweep fills the rest.
    expect(input.calendarToday.map((e) => e.title)).toEqual(["Live standup"]);
    expect([input.merged, input.opened]).toEqual([87, 101]);
    expect(input.fleet?.total).toBe(44);
    expect(input.risks.map((r) => r.id)).toEqual(["ci:hq-desktop-app"]);
    expect(input.shipped.length).toBeGreaterThan(0);
  });

  it("renders from the adapter alone when the file is absent", async () => {
    const { input, failures } = await gatherBriefInput(adapter(), {
      now: NOW,
      companies,
      sweep: { readHqFile: async () => null },
      log: () => {},
    });
    expect(input.merged).toBeNull();
    expect(input.fleet ?? null).toBeNull();
    expect(failures).not.toContain("sweep");
  });

  it("logs an unreadable or invalid sweep instead of swallowing it", async () => {
    const log = vi.fn();
    const bad = await gatherBriefInput(adapter(), { now: NOW, companies, sweep: { readHqFile: async () => "{oops" }, log });
    expect(bad.failures).toContain("sweep");
    const thrown = await gatherBriefInput(adapter(), {
      now: NOW,
      companies,
      sweep: { readHqFile: async () => Promise.reject(new Error("denied")) },
      log,
    });
    expect(thrown.failures).toContain("sweep");
    expect(log).toHaveBeenCalledWith("sweep failed", "denied");
  });

  it("defaults to the adapter's HQ file read", async () => {
    const getFileContent = vi.fn(async () => ({ ok: true as const, value: JSON.stringify(sweepJson) }));
    const { input } = await gatherBriefInput({ ...adapter(), files: { getFileContent } }, { now: NOW, companies, log: () => {} });
    expect(getFileContent).toHaveBeenCalledWith("workspace/brief/2026-10-09/brief-data.json");
    expect(input.merged).toBe(87);
    expect(adapterSweepSource(null)).toBeNull();
  });
});
