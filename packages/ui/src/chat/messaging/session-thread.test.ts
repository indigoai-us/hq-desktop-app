import { describe, expect, it } from "vitest";
import {
  coalesceWorkSessionWires,
  createSessionThread,
  excerptFromBody,
  isDesktopLiveSessionId,
  parseWorkMeshSpawnId,
} from "./session-thread";

describe("session-thread model", () => {
  it("builds a message-origin session", () => {
    const thread = createSessionThread({
      origin: {
        kind: "message",
        eventId: "evt_1",
        excerpt: "How did you build sessions?",
        author: "Stefan Johnson",
      },
      actorKind: "human",
      actorName: "Stefan Johnson",
      now: "2026-09-10T12:00:00.000Z",
    });
    expect(thread.origin.kind).toBe("message");
    expect(thread.title).toContain("How did you build sessions?");
    expect(thread.turns[0]?.text).toContain("Stefan Johnson");
  });

  it("builds a channel-origin session", () => {
    const thread = createSessionThread({
      origin: {
        kind: "channel",
        channelId: "chn_1",
        channelTitle: "hq-desktop-sessions-testing",
      },
      actorKind: "agent",
      actorName: "Deacon",
      now: "2026-09-10T12:00:00.000Z",
    });
    expect(thread.origin.kind).toBe("channel");
    expect(thread.title).toContain("hq-desktop-sessions-testing");
    expect(thread.actorKind).toBe("agent");
  });

  it("does not treat mesh spawn ids as desktop sessions", () => {
    expect(
      isDesktopLiveSessionId(
        "ws_spawn_cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG|hq-desktop-sessions-testing|US-001",
      ),
    ).toBe(false);
    expect(isDesktopLiveSessionId("93e492d5-477d-4854-a0ba-732365372d11")).toBe(true);
    expect(
      parseWorkMeshSpawnId(
        "ws_spawn_cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG|hq-desktop-sessions-testing|US-001",
      ),
    ).toEqual({
      project: "hq-desktop-sessions-testing",
      taskId: "US-001",
    });
  });

  it("keeps one work_session card per session id", () => {
    const rows = coalesceWorkSessionWires([
      {
        eventId: "a",
        systemEvent: { type: "work_session", sessionId: "ws_spawn_x|p|US-001" },
      },
      {
        eventId: "b",
        systemEvent: { type: "work_session", sessionId: "ws_spawn_x|p|US-001" },
      },
      { eventId: "c", systemEvent: { type: "member_added" } },
    ]);
    expect(rows.map((row) => row.eventId)).toEqual(["b", "c"]);
  });

  it("clips excerpts", () => {
    expect(excerptFromBody("short")).toBe("short");
    expect(excerptFromBody("x".repeat(200)).endsWith("…")).toBe(true);
  });
});
