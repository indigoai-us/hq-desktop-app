import { describe, expect, it } from "vitest";
import {
  filterHumanMessages,
  compareHumanRecency,
  humanRecencyKey,
  humanRecencyState,
  isUndatedNoHumanRow,
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

describe("isHumanMessage inferFromUid option", () => {
  it("default infers non-human from an agent uid with no audience", () => {
    expect(isHumanMessage({ fromPersonUid: "agt_izzy" })).toBe(false);
  });
  it("inferFromUid false keeps an untagged agent message", () => {
    expect(
      isHumanMessage({ fromPersonUid: "agt_izzy" }, { inferFromUid: false }),
    ).toBe(true);
  });
  it("inferFromUid false still hides explicit non-human signals", () => {
    const opts = { inferFromUid: false };
    expect(isHumanMessage({ fromPersonUid: "agt_izzy", audience: "bot" }, opts)).toBe(false);
    expect(isHumanMessage({ audience: "mesh" }, opts)).toBe(false);
    expect(isHumanMessage({ isSystemEvent: true }, opts)).toBe(false);
    expect(isHumanMessage({ isMeshEvent: true }, opts)).toBe(false);
  });
});

describe("humanRecencyState", () => {
  it("known: the server sent lastHumanMessageAt", () => {
    expect(
      humanRecencyState({ lastHumanMessageAt: "2026-09-29T09:00:00Z" }),
    ).toBe("known");
  });

  it("none: the server sent hasHumanMessage false", () => {
    expect(humanRecencyState({ hasHumanMessage: false })).toBe("none");
  });

  it("unknown: neither field, an explicit null, or a stray true", () => {
    expect(humanRecencyState({ lastActivityAt: "2026-09-29T10:00:00Z" })).toBe(
      "unknown",
    );
    expect(
      humanRecencyState({ lastHumanMessageAt: null, hasHumanMessage: null }),
    ).toBe("unknown");
    expect(humanRecencyState({ hasHumanMessage: true })).toBe("unknown");
  });

  it("a human time wins when a row carries both fields", () => {
    expect(
      humanRecencyState({
        lastHumanMessageAt: "2026-09-29T09:00:00Z",
        hasHumanMessage: false,
      }),
    ).toBe("known");
  });
});

describe("humanRecencyKey", () => {
  it("known: uses lastHumanMessageAt in humanOnly mode", () => {
    const key = humanRecencyKey(
      {
        lastActivityAt: "2026-09-29T10:00:00Z",
        lastHumanMessageAt: "2026-09-29T09:00:00Z",
      },
      true,
    );
    expect(key).toBe(Date.parse("2026-09-29T09:00:00Z"));
  });

  it("unknown: falls back to lastActivityAt in humanOnly mode", () => {
    // Neither field arrived: an older server, a 1:1 DM, or a channel the
    // server has not examined. Absent is not "none", so the row keeps its
    // activity order instead of sinking to the bottom.
    const key = humanRecencyKey(
      { lastActivityAt: "2026-09-29T10:00:00Z" },
      true,
    );
    expect(key).toBe(Date.parse("2026-09-29T10:00:00Z"));
  });

  it("unknown: falls back to lastMessageAt when lastActivityAt is absent", () => {
    const key = humanRecencyKey({ lastMessageAt: "2026-09-29T07:00:00Z" }, true);
    expect(key).toBe(Date.parse("2026-09-29T07:00:00Z"));
  });

  it("none: the key is the creation time, never bot or session activity", () => {
    const key = humanRecencyKey(
      {
        lastActivityAt: "2026-09-29T10:00:00Z",
        lastMessageAt: "2026-09-29T10:00:00Z",
        hasHumanMessage: false,
        createdAt: "2026-09-02T08:00:00Z",
      },
      true,
    );
    expect(key).toBe(Date.parse("2026-09-02T08:00:00Z"));
  });

  it("none without a creation time: the key is 0, never bot or session activity", () => {
    const row = {
      lastActivityAt: "2026-09-29T10:00:00Z",
      lastMessageAt: "2026-09-29T10:00:00Z",
      hasHumanMessage: false,
    };
    expect(humanRecencyKey(row, true)).toBe(0);
    expect(isUndatedNoHumanRow(row, true)).toBe(true);
    expect(isUndatedNoHumanRow(row, false)).toBe(false);
    expect(
      isUndatedNoHumanRow({ ...row, createdAt: "2026-09-02T08:00:00Z" }, true),
    ).toBe(false);
    expect(isUndatedNoHumanRow({ lastActivityAt: null }, true)).toBe(false);
  });

  it("uses lastActivityAt when the flag is off, in every state", () => {
    const at = Date.parse("2026-09-29T10:00:00Z");
    expect(
      humanRecencyKey(
        {
          lastActivityAt: "2026-09-29T10:00:00Z",
          lastHumanMessageAt: "2026-09-29T09:00:00Z",
        },
        false,
      ),
    ).toBe(at);
    expect(
      humanRecencyKey(
        { lastActivityAt: "2026-09-29T10:00:00Z", hasHumanMessage: false },
        false,
      ),
    ).toBe(at);
    expect(
      humanRecencyKey({ lastActivityAt: "2026-09-29T10:00:00Z" }, false),
    ).toBe(at);
  });
});

describe("compareHumanRecency", () => {
  const known = { lastHumanMessageAt: "2026-09-20T09:00:00Z" };
  const unknown = { lastActivityAt: "2026-09-10T09:00:00Z" };
  // Bot activity on the 30th; created on the 15th.
  const none = {
    lastActivityAt: "2026-09-30T09:00:00Z",
    hasHumanMessage: false,
    createdAt: "2026-09-15T00:00:00Z",
  };

  it("humanOnly: a known-none row sits at its creation time on the same timeline", () => {
    // Created on the 15th: below a message typed on the 20th, above activity
    // on the 10th. Its own bot activity on the 30th moves nothing.
    expect(compareHumanRecency(none, known, true)).toBeGreaterThan(0);
    expect(compareHumanRecency(known, none, true)).toBeLessThan(0);
    expect(compareHumanRecency(none, unknown, true)).toBeLessThan(0);
  });

  it("humanOnly: a known-none row created after another row's last human message sorts above it", () => {
    const createdToday = { hasHumanMessage: false, createdAt: "2026-09-30T08:00:00Z" };
    expect(compareHumanRecency(createdToday, known, true)).toBeLessThan(0);
  });

  it("humanOnly: known-none rows order by creation time, newest first", () => {
    const older = { hasHumanMessage: false, createdAt: "2026-08-01T00:00:00Z" };
    const newer = { hasHumanMessage: false, createdAt: "2026-09-01T00:00:00Z" };
    expect(compareHumanRecency(newer, older, true)).toBeLessThan(0);
  });

  it("humanOnly: a known-none row without a creation time is the bottom tier", () => {
    const undated = { hasHumanMessage: false, lastActivityAt: "2026-09-30T09:00:00Z" };
    const ancient = { hasHumanMessage: false, createdAt: "2020-01-01T00:00:00Z" };
    const neverActive = { lastActivityAt: null };
    expect(compareHumanRecency(undated, ancient, true)).toBeGreaterThan(0);
    expect(compareHumanRecency(undated, known, true)).toBeGreaterThan(0);
    expect(compareHumanRecency(undated, unknown, true)).toBeGreaterThan(0);
    // Below even a row with no activity at all.
    expect(compareHumanRecency(undated, neverActive, true)).toBeGreaterThan(0);
    expect(compareHumanRecency(neverActive, undated, true)).toBeLessThan(0);
    // Two such rows tie: the caller's tie-break (title) orders them.
    expect(compareHumanRecency(undated, { hasHumanMessage: false }, true)).toBe(0);
  });

  it("flag off: hasHumanMessage and createdAt are ignored", () => {
    expect(compareHumanRecency(none, known, false)).toBeLessThan(0);
    expect(
      compareHumanRecency({ hasHumanMessage: false }, { lastActivityAt: null }, false),
    ).toBe(0);
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

  it("unknown rows: humanOnly orders them by lastActivityAt (older server)", () => {
    // An older server sends neither field for any row. The order must match
    // the flag-off order instead of collapsing to input or title order.
    const noFields = [
      { id: "earlier", lastActivityAt: "2026-09-29T09:00:00Z" },
      { id: "later", lastActivityAt: "2026-09-29T11:00:00Z" },
    ];
    expect(orderChannelsForViewer(noFields, true).map((r) => r.id)).toEqual([
      "later",
      "earlier",
    ]);
  });

  it("humanOnly: a bot-only channel sits at its creation time, below a channel typed in since", () => {
    const meshRows = [
      {
        id: "mesh-busy-today",
        lastActivityAt: "2026-09-30T15:00:00Z", // constantly bumped by mesh
        hasHumanMessage: false,
        createdAt: "2026-06-01T00:00:00Z",
      },
      {
        id: "typed-yesterday",
        lastActivityAt: "2026-09-28T09:00:00Z",
        lastHumanMessageAt: "2026-09-28T09:00:00Z",
      },
    ];
    expect(orderChannelsForViewer(meshRows, true).map((r) => r.id)).toEqual([
      "typed-yesterday",
      "mesh-busy-today",
    ]);
  });

  it("humanOnly: a channel created today with no message yet sits above older human rows", () => {
    const rows = [
      {
        id: "typed-yesterday",
        lastActivityAt: "2026-09-29T09:00:00Z",
        lastHumanMessageAt: "2026-09-29T09:00:00Z",
      },
      {
        id: "created-today",
        lastActivityAt: null,
        hasHumanMessage: false,
        createdAt: "2026-09-30T10:00:00Z",
      },
    ];
    expect(orderChannelsForViewer(rows, true).map((r) => r.id)).toEqual([
      "created-today",
      "typed-yesterday",
    ]);
  });

  it("humanOnly: the three states together", () => {
    const mixed = [
      { id: "none-old", hasHumanMessage: false, createdAt: "2026-07-01T00:00:00Z", lastActivityAt: "2026-09-30T23:00:00Z" },
      { id: "unknown-dm", lastActivityAt: "2026-09-29T12:00:00Z" },
      { id: "none-undated", hasHumanMessage: false, lastActivityAt: "2026-09-30T22:00:00Z" },
      { id: "known-new", lastHumanMessageAt: "2026-09-30T08:00:00Z", lastActivityAt: "2026-09-30T08:00:00Z" },
      { id: "none-new", hasHumanMessage: false, createdAt: "2026-09-15T00:00:00Z" },
      { id: "known-old", lastHumanMessageAt: "2026-09-01T08:00:00Z", lastActivityAt: "2026-09-30T21:00:00Z" },
    ];
    expect(orderChannelsForViewer(mixed, true).map((r) => r.id)).toEqual([
      "known-new", // typed 30 September
      "unknown-dm", // no fields: activity 29 September
      "none-new", // known none: created 15 September
      "known-old", // typed 1 September; its later bot activity is ignored
      "none-old", // known none: created 1 July
      "none-undated", // known none, no creation time: bottom tier
    ]);
  });
});
