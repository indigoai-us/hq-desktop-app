import { describe, expect, it } from "vitest";
import {
  LIVE_READ_FIXTURE,
  liveSessionsForProject,
  parseLiveReadResponse,
} from "./live.js";

describe("parseLiveReadResponse", () => {
  it("parses the contract fixture", () => {
    const parsed = parseLiveReadResponse(LIVE_READ_FIXTURE);
    expect(parsed?.contractVersion).toBe(1);
    expect(parsed?.participants).toHaveLength(3);
    expect(parsed?.participants[0]?.sessions[0]?.taskId).toBe("US-015");
    expect(parsed?.participants[1]?.actorType).toBe("agent");
    expect(parsed?.participants[2]?.presence).toBe("offline");
  });

  it("defaults omitted source to hooks and ignores unknown keys", () => {
    const parsed = parseLiveReadResponse({
      contractVersion: 1,
      generatedAt: "2026-09-04T00:00:00.000Z",
      participants: [
        {
          actorUid: "prs_a",
          actorType: "human",
          displayName: "Ada",
          presence: "online",
          lastSeenAt: "2026-09-04T00:00:00.000Z",
          prompt: "NEVER",
          sessions: [
            {
              sessionId: "s1",
              harness: "codex",
              contextStatus: "bound",
              projectId: "p",
              status: "active",
              startedAt: "2026-09-04T00:00:00.000Z",
              lastTurnAt: "2026-09-04T00:01:00.000Z",
              turnCount: 2,
              transcript: "NEVER",
            },
          ],
        },
      ],
    });
    expect(parsed?.participants[0]?.sessions[0]?.source).toBe("hooks");
    expect(
      (parsed?.participants[0] as { prompt?: unknown } | undefined)?.prompt,
    ).toBeUndefined();
  });

  it("returns null for unusable payloads", () => {
    expect(parseLiveReadResponse(null)).toBeNull();
    expect(parseLiveReadResponse({})).toBeNull();
    expect(parseLiveReadResponse({ participants: "nope" })).toBeNull();
  });

  it("skips participants without presence or actorUid", () => {
    const parsed = parseLiveReadResponse({
      participants: [
        { actorUid: "", presence: "online" },
        { actorUid: "prs_x", presence: "maybe" },
        {
          actorUid: "prs_ok",
          presence: "offline",
          displayName: "Ok",
          sessions: [],
        },
      ],
    });
    expect(parsed?.participants.map((p) => p.actorUid)).toEqual(["prs_ok"]);
  });
});

describe("liveSessionsForProject", () => {
  it("returns bound sessions for the project with actor metadata", () => {
    const rows = liveSessionsForProject(LIVE_READ_FIXTURE, "work-mesh-live");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actorUid).sort()).toEqual([
      "agt_ralph",
      "prs_corey",
    ]);
    expect(rows.every((r) => r.taskId === "US-015")).toBe(true);
  });

  it("ignores sessions without matching projectId", () => {
    expect(liveSessionsForProject(LIVE_READ_FIXTURE, "other")).toEqual([]);
    expect(liveSessionsForProject(LIVE_READ_FIXTURE, "")).toEqual([]);
  });
});
