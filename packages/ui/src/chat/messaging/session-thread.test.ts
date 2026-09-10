import { describe, expect, it } from "vitest";
import { createSessionThread, excerptFromBody } from "./session-thread";

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

  it("clips excerpts", () => {
    expect(excerptFromBody("short")).toBe("short");
    expect(excerptFromBody("x".repeat(200)).endsWith("…")).toBe(true);
  });
});
