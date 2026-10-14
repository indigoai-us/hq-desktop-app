// OWNER-R27: session history from the HQ workspace folder, in the shape the
// native list_local_sessions command returns (placeholder ids and titles).
import { ok, failure } from "@hq/platform";
import { describe, expect, it, vi } from "vitest";
import { createLocalSessionsReader, formatGap, formatLength, formatWhen, localSessionsFromNative, localSessionsWindow, sessionKindLabel } from "./telemetry-local-sessions";

export const NATIVE_PAGE = {
  total: 3,
  medianGapMinutes: 42.5,
  rows: [
    { sessionId: "00000000-0000-4000-8000-000000000003", startedAt: "2026-10-03T10:00:00Z", company: "acme", project: "proj-a", title: "Title A", lastAt: "2026-10-03T11:20:00Z", outcome: "Handed off", threadPath: "workspace/threads/T-20261003-112000-a.json", kind: "you" },
    { sessionId: "00000000-0000-4000-8000-000000000002", startedAt: "2026-10-02T09:00:00Z", company: null, project: "proj-b", title: null, lastAt: null, outcome: null, threadPath: null },
    { sessionId: "00000000-0000-4000-8000-000000000001", startedAt: "2026-10-01T08:00:00Z", company: null, project: null, title: null, lastAt: "2026-10-01T08:00:30Z", outcome: "Checkpointed", threadPath: "workspace/threads/T-2026-10-01-0800-b.json", kind: "agent" },
  ],
};

describe("OWNER-R27 local session history", () => {
  it("parses rows with real lengths and outcomes only where a record exists; never a token number", () => {
    const page = localSessionsFromNative(NATIVE_PAGE);
    expect(page.total).toBe(3);
    expect(page.medianGapMinutes).toBe(42.5);
    expect(page.rows.map((r) => [r.company, r.project, r.title, r.length, r.outcome, r.threadPath])).toEqual([
      ["acme", "proj-a", "Title A", "1h 20m", "Handed off", "workspace/threads/T-20261003-112000-a.json"],
      // No title of its own: the cell stays empty (the project has its own column).
      ["", "proj-b", "", "", "", ""],
      ["", "", "", "<1m", "Checkpointed", "workspace/threads/T-2026-10-01-0800-b.json"],
    ]);
    expect(Object.keys(page.rows[0]!)).not.toContain("tokens");
    // Kind: "you" by default (missing or unknown values too), else agent or lane.
    expect(page.rows.map((r) => r.kind)).toEqual(["you", "you", "agent"]);
    const lane = localSessionsFromNative({ total: 1, medianGapMinutes: null, rows: [{ sessionId: "x", startedAt: "", kind: "lane" }, { sessionId: "y", startedAt: "", kind: "robot" }] });
    expect(lane.rows.map((r) => [r.kind, sessionKindLabel(r.kind)])).toEqual([["lane", "Lane"], ["you", ""]]);
    expect(() => localSessionsFromNative({})).toThrow();
  });

  it("asks the native command for the chosen range and page", async () => {
    const listLocalSessions = vi.fn(async () => ok(NATIVE_PAGE));
    const read = createLocalSessionsReader({ listLocalSessions }, () => Date.UTC(2026, 9, 3, 12))!;
    await read("7d", { offset: 0, limit: 10 });
    expect(listLocalSessions).toHaveBeenCalledWith({ from: "2026-09-27", to: "2026-10-03" }, { offset: 0, limit: 10 });
    expect(localSessionsWindow("90d", Date.UTC(2026, 9, 3)).from).toBe("2026-07-06");
  });

  it("fails plainly and is absent on hosts without the command", async () => {
    expect(createLocalSessionsReader({})).toBeNull();
    const read = createLocalSessionsReader({ listLocalSessions: async () => failure("unavailable", "no") })!;
    await expect(read("30d", { offset: 0, limit: 10 })).rejects.toThrow();
  });

  it("formats lengths and the median gap", () => {
    expect(formatLength("2026-10-03T10:00:00Z", "2026-10-03T10:45:00Z")).toBe("45m");
    expect(formatLength("2026-10-03T10:00:00Z", "2026-10-03T12:00:00Z")).toBe("2h");
    expect(formatLength("2026-10-03T10:00:00Z", "bad")).toBe("");
    expect(formatGap(2.3)).toBe("2m");
    expect(formatGap(95)).toBe("1h 35m");
    expect(formatGap(null)).toBe("");
    expect(formatLength("2026-10-03T10:00:00Z", "2026-10-03T11:12:00Z")).toBe("1h 12m");
    expect(formatLength("2026-10-03T10:00:00Z", "2026-10-03T10:04:00Z")).toBe("4m");
    expect(formatWhen("2026-10-05T10:19:00")).toBe("Oct 5, 10:19");
    expect(formatWhen("2026-10-05T22:19:00")).toBe("Oct 5, 22:19");
    expect(formatWhen("nope")).toBe("");
  });
});
