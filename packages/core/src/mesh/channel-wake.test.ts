import { describe, expect, it } from "vitest";

import {
  channelWakeFromPayload,
  isTargetedMeshWake,
  mqttPayloadToText,
  parseDmDeliveredWake,
  parseReplyThreadWake,
} from "./channel-wake.js";

describe("channelWakeFromPayload", () => {
  it("extracts the targeted channel slice from a channel wake", () => {
    expect(
      channelWakeFromPayload(
        JSON.stringify({
          type: "channel",
          channelId: "chn_x",
          eventId: "evt_1",
          createdAt: "2026-08-18T12:00:00.000Z",
          fromPersonUid: "prs_bob",
        }),
      ),
    ).toEqual({
      channelId: "chn_x",
      eventId: "evt_1",
      createdAt: "2026-08-18T12:00:00.000Z",
      fromPersonUid: "prs_bob",
    });
  });

  it("ignores dm wakes and junk", () => {
    expect(
      channelWakeFromPayload(JSON.stringify({ type: "dm", eventId: "e" })),
    ).toBeNull();
    expect(channelWakeFromPayload("not-json")).toBeNull();
    expect(channelWakeFromPayload("")).toBeNull();
  });
});

describe("parseDmDeliveredWake", () => {
  it("extracts fromPersonUid from a type:dm wake", () => {
    expect(
      parseDmDeliveredWake(
        JSON.stringify({
          type: "dm",
          eventId: "evt_dm",
          createdAt: "2026-08-22T12:00:00.000Z",
          fromPersonUid: "agt_deacon",
        }),
      ),
    ).toEqual({
      fromPersonUid: "agt_deacon",
      eventId: "evt_dm",
      createdAt: "2026-08-22T12:00:00.000Z",
    });
  });

  it("keeps direction out so callers can skip self-sync", () => {
    expect(
      parseDmDeliveredWake({
        type: "dm",
        fromPersonUid: "prs_me",
        direction: "out",
      }),
    ).toEqual({ fromPersonUid: "prs_me", direction: "out" });
  });

  it("ignores channel wakes", () => {
    expect(
      parseDmDeliveredWake({ type: "channel", channelId: "chn_x" }),
    ).toBeNull();
  });
});

describe("isTargetedMeshWake", () => {
  it("treats channel and thread payloads as targeted", () => {
    expect(
      isTargetedMeshWake(JSON.stringify({ type: "channel", channelId: "c" })),
    ).toBe(true);
    expect(
      isTargetedMeshWake(
        JSON.stringify({ type: "thread", scope: "channel", eventId: "e" }),
      ),
    ).toBe(true);
    expect(isTargetedMeshWake(JSON.stringify({ type: "dm" }))).toBe(false);
    expect(
      isTargetedMeshWake(
        JSON.stringify({
          type: "dm",
          fromPersonUid: "agt_deacon",
          eventId: "evt_1",
        }),
      ),
    ).toBe(true);
    expect(isTargetedMeshWake("")).toBe(false);
  });
});

describe("parseReplyThreadWake", () => {
  it("reads hq-pro type:thread ids and ignores work-mesh thread_event", () => {
    expect(
      parseReplyThreadWake(
        JSON.stringify({
          type: "thread",
          scope: "channel",
          rootEventId: "evt_root",
          eventId: "evt_reply",
          channelId: "chn_x",
        }),
      ),
    ).toEqual({
      rootEventId: "evt_root",
      eventId: "evt_reply",
      scope: "channel",
      channelId: "chn_x",
    });
    expect(
      parseReplyThreadWake(
        JSON.stringify({ type: "thread_event", threadId: "t1" }),
      ),
    ).toBeNull();
  });
});

describe("mqttPayloadToText", () => {
  it("decodes bytes", () => {
    expect(mqttPayloadToText(new TextEncoder().encode("hi"))).toBe("hi");
    expect(mqttPayloadToText("hi")).toBe("hi");
  });
});
