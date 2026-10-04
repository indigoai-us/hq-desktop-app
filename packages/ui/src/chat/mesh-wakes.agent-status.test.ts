import { describe, expect, it } from "vitest";

import { createChatWakeBus } from "./chat-api";
import { routeMeshWake } from "./mesh-wakes";

const TS = "2026-10-03T10:00:00.000Z";
const SENT = "2026-10-03T09:59:58.000Z";

function recording() {
  const wakes = createChatWakeBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  for (const name of ["agent:status", "agent:dm-status", "dm:new-message", "channel:new-message", "reply:new"] as const) {
    wakes.on(name, (payload) => events.push({ name, payload }));
  }
  return { wakes, events };
}

describe("routeMeshWake: agent_status", () => {
  it("routes the DM shape to agent:dm-status and nothing else", () => {
    const { wakes, events } = recording();
    const payload = {
      type: "agent_status",
      agentUid: "agt_nova",
      withPersonUid: "prs_me",
      status: "Searching the web",
      ts: TS,
      sentAt: SENT,
      rootEventId: "evt_root",
    };
    expect(routeMeshWake(JSON.stringify(payload), wakes)).toBeNull();
    expect(events).toEqual([
      {
        name: "agent:dm-status",
        payload: {
          agentUid: "agt_nova",
          withPersonUid: "prs_me",
          status: "Searching the web",
          ts: TS,
          sentAt: SENT,
          rootEventId: "evt_root",
        },
      },
    ]);
  });

  it("routes the DM shape when the payload arrives as an object, without the optional fields", () => {
    const { wakes, events } = recording();
    routeMeshWake({ type: "agent_status", agentUid: "agt_nova", withPersonUid: "prs_me", status: "Working", ts: TS }, wakes);
    expect(events).toEqual([
      { name: "agent:dm-status", payload: { agentUid: "agt_nova", withPersonUid: "prs_me", status: "Working", ts: TS } },
    ]);
  });

  it("routes the channel shape to agent:status as before", () => {
    const { wakes, events } = recording();
    const payload = { type: "agent_status", channelId: "chn_1", agentUid: "agt_nova", status: "reading", threadRoot: "evt_r", ts: TS };
    expect(routeMeshWake(JSON.stringify(payload), wakes)).toBeNull();
    expect(events).toEqual([
      { name: "agent:status", payload: { channelId: "chn_1", agentUid: "agt_nova", status: "reading", threadRoot: "evt_r", ts: TS } },
    ]);
  });

  it("emits nothing for an agent_status it cannot place", () => {
    const { wakes, events } = recording();
    expect(routeMeshWake({ type: "agent_status", agentUid: "agt_nova", status: "x", ts: TS }, wakes)).toBeNull();
    expect(events).toEqual([]);
  });
});
