import { describe, expect, it } from "vitest";

import { coalesceWorkSessionWires } from "./work-session-wires.js";

describe("coalesceWorkSessionWires", () => {
  it("keeps the latest card per session and preserves other rows", () => {
    const rows = [
      { eventId: "old", systemEvent: { type: "work_session", sessionId: "s1" } },
      { eventId: "other", systemEvent: { type: "message" } },
      { eventId: "new", systemEvent: { type: "work_session", sessionId: "s1" } },
    ];

    expect(coalesceWorkSessionWires(rows).map(({ eventId }) => eventId)).toEqual([
      "other",
      "new",
    ]);
  });
});
