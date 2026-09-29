import { describe, expect, it } from "vitest";
import {
  filterHumanMessages,
  humanRecencyKey,
  isHumanMessage,
  orderChannelsForViewer,
} from "./humanMessage.js";

describe("isHumanMessage", () => {
  it("keeps a plain human message (no audience, no flags)", () => {
    expect(isHumanMessage({ fromPersonUid: "prs_abc" })).toBe(true);
  });

  it("hides explicit mesh events even when audience is human", () => {
    expect(
      isHumanMessage({ audience: "human", isMeshEvent: true }),
    ).toBe(false);
  });

  it("hides explicit system events even when audience is human", () => {
    expect(
      isHumanMessage({ audience: "human", isSystemEvent: true }),
    ).toBe(false);
  });

  it("keeps a bot reply whose audience is `both`", () => {
    expect(
      isHumanMessage({ audience: "both", fromPersonUid: "bot_izzy" }),
    ).toBe(true);
  });

  it("hides a message whose audience is `bot`", () => {
    expect(
      isHumanMessage({ audience: "bot", fromPersonUid: "prs_abc" }),
    ).toBe(false);
  });

  it("hides a message whose audience is `mesh`", () => {
    expect(isHumanMessage({ audience: "mesh" })).toBe(false);
  });

  it("hides a bot-uid sender when audience is absent", () => {
    expect(isHumanMessage({ fromPersonUid: "bot_izzy" })).toBe(false);
    expect(isHumanMessage({ fromPersonUid: "agent_neo" })).toBe(false);
    expect(isHumanMessage({ fromPersonUid: "agt_042" })).toBe(false);
    expect(isHumanMessage({ fromPersonUid: "sys_notify" })).toBe(false);
  });

  it("keeps a bot-uid sender when audience is explicitly human", () => {
    expect(
      isHumanMessage({ audience: "human", fromPersonUid: "bot_izzy" }),
    ).toBe(true);
  });

  it("filterHumanMessages preserves order of kept items", () => {
    const rows = [
      { id: 1, fromPersonUid: "prs_a" },
      { id: 2, audience: "bot" },
      { id: 3, audience: "both", fromPersonUid: "bot_x" },
      { id: 4, isMeshEvent: true },
    ];
    expect(filterHumanMessages(rows).map((r) => r.id)).toEqual([1, 3]);
  });
});

describe("humanRecencyKey", () => {
  it("prefers lastHumanMessageAt in humanOnly mode", () => {
    const key = humanRecencyKey(
      {
        lastActivityAt: "2026-09-29T10:00:00Z",
        lastHumanMessageAt: "2026-09-29T09:00:00Z",
      },
      true,
    );
    expect(key).toBe(Date.parse("2026-09-29T09:00:00Z"));
  });

  it("falls back to lastActivityAt when lastHumanMessageAt is absent", () => {
    const key = humanRecencyKey(
      { lastActivityAt: "2026-09-29T10:00:00Z" },
      true,
    );
    expect(key).toBe(Date.parse("2026-09-29T10:00:00Z"));
  });

  it("uses lastActivityAt when the flag is off", () => {
    const key = humanRecencyKey(
      {
        lastActivityAt: "2026-09-29T10:00:00Z",
        lastHumanMessageAt: "2026-09-29T09:00:00Z",
      },
      false,
    );
    expect(key).toBe(Date.parse("2026-09-29T10:00:00Z"));
  });
});

describe("orderChannelsForViewer", () => {
  const rows = [
    {
      id: "quiet-human",
      lastActivityAt: "2026-09-29T09:00:00Z",
      lastHumanMessageAt: "2026-09-29T09:00:00Z",
    },
    {
      id: "noisy-bot",
      lastActivityAt: "2026-09-29T11:00:00Z",
      lastHumanMessageAt: "2026-09-29T08:00:00Z",
    },
  ];

  it("flag off: noisy-bot wins (newer lastActivityAt)", () => {
    const order = orderChannelsForViewer(rows, false).map((r) => r.id);
    expect(order).toEqual(["noisy-bot", "quiet-human"]);
  });

  it("flag on: quiet-human wins (newer human message)", () => {
    const order = orderChannelsForViewer(rows, true).map((r) => r.id);
    expect(order).toEqual(["quiet-human", "noisy-bot"]);
  });

  it("ties preserve input order (stable)", () => {
    const same = [
      { id: "a", lastActivityAt: "2026-09-29T10:00:00Z" },
      { id: "b", lastActivityAt: "2026-09-29T10:00:00Z" },
      { id: "c", lastActivityAt: "2026-09-29T10:00:00Z" },
    ];
    expect(orderChannelsForViewer(same, false).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("no human messages: falls back to lastActivityAt in humanOnly mode", () => {
    const noHuman = [
      { id: "later-bot", lastActivityAt: "2026-09-29T11:00:00Z" },
      { id: "earlier-bot", lastActivityAt: "2026-09-29T09:00:00Z" },
    ];
    expect(orderChannelsForViewer(noHuman, true).map((r) => r.id)).toEqual([
      "later-bot",
      "earlier-bot",
    ]);
  });
});
