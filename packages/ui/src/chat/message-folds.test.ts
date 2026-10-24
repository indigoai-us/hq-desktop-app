import { describe, expect, it } from "vitest";

import {
  countsTowardUnread,
  foldLabel,
  groupIntoFolds,
  type FoldRun,
} from "./message-folds";
import { pairUnreadsFromInboxPage } from "./live-catchup";
import { createChatWakeBus } from "./chat-api";
import { routeMeshWake } from "./mesh-wakes";

const OFF = { agents: false, system: false };

type Msg = {
  eventId: string;
  fromPersonUid?: string;
  fromDisplayName?: string;
  audience?: string | null;
  isSystemEvent?: boolean;
};

const H = (id: string): Msg => ({ eventId: id, fromPersonUid: "prs_ada", fromDisplayName: "Ada", audience: "human" });
const A = (id: string, uid = "agt_scout", name = "Scout"): Msg => ({ eventId: id, fromPersonUid: uid, fromDisplayName: name, audience: "agent" });
const S = (id: string): Msg => ({ eventId: id, fromDisplayName: "HQ", isSystemEvent: true });

describe("groupIntoFolds", () => {
  it("H,A,A,S,H gives two human rows around one fold of three", () => {
    const rows = groupIntoFolds([H("1"), A("2"), A("3"), S("4"), H("5")], OFF);
    expect(rows.map((r) => r.kind)).toEqual(["message", "fold", "message"]);
    const fold = rows[1] as FoldRun<Msg>;
    expect(fold.items.map((m) => m.eventId)).toEqual(["2", "3", "4"]);
    expect(fold.key).toBe("fold:2");
    expect(foldLabel(fold)).toBe("2 agent updates · 1 system");
  });

  it("folds a trailing run at the end of the conversation", () => {
    const rows = groupIntoFolds([H("1"), A("2"), S("3")], OFF);
    expect(rows.map((r) => r.kind)).toEqual(["message", "fold"]);
    expect((rows[1] as FoldRun<Msg>).items).toHaveLength(2);
  });

  it("folds a leading run and keeps separate runs separate", () => {
    const rows = groupIntoFolds([A("1"), H("2"), A("3"), H("4"), S("5")], OFF);
    expect(rows.map((r) => r.kind)).toEqual(["fold", "message", "fold", "message", "fold"]);
  });

  it("renders every message as a row when there is no filter", () => {
    const rows = groupIntoFolds([H("1"), A("2"), S("3")], null);
    expect(rows.every((r) => r.kind === "message")).toBe(true);
  });

  it("keeps a type as rows when its switch is on", () => {
    const rows = groupIntoFolds([H("1"), A("2"), S("3"), H("4")], { agents: true, system: false });
    expect(rows.map((r) => r.kind)).toEqual(["message", "message", "fold", "message"]);
  });

  it("collects at most three distinct senders in first-seen order", () => {
    const rows = groupIntoFolds(
      [A("1", "agt_a", "A"), A("2", "agt_a", "A"), A("3", "agt_b", "B"), A("4", "agt_c", "C"), A("5", "agt_d", "D")],
      OFF,
    );
    const fold = rows[0] as FoldRun<Msg>;
    expect(fold.senders.map((s) => s.uid)).toEqual(["agt_a", "agt_b", "agt_c"]);
    expect(fold.agentCount).toBe(5);
  });

  it("uses a precomputed type when given", () => {
    const rows = groupIntoFolds(
      [{ eventId: "1", type: "system" as const }, { eventId: "2", type: "people" as const }],
      OFF,
    );
    expect(rows.map((r) => r.kind)).toEqual(["fold", "message"]);
  });
});

describe("foldLabel", () => {
  it("handles singular and plural and omits zero segments", () => {
    expect(foldLabel({ agentCount: 1, systemCount: 0 })).toBe("1 agent update");
    expect(foldLabel({ agentCount: 6, systemCount: 1 })).toBe("6 agent updates · 1 system");
    expect(foldLabel({ agentCount: 0, systemCount: 2 })).toBe("2 system");
  });

  it("adds hide when open", () => {
    expect(foldLabel({ agentCount: 6, systemCount: 1 }, true)).toBe("hide 6 agent updates · 1 system");
  });
});

describe("unread exclusion", () => {
  it("countsTowardUnread is false for hidden types and true otherwise", () => {
    expect(countsTowardUnread({ audience: "agent" }, OFF)).toBe(false);
    expect(countsTowardUnread({ isSystemEvent: true }, OFF)).toBe(false);
    expect(countsTowardUnread({ isMeshEvent: true }, OFF)).toBe(false);
    expect(countsTowardUnread({ audience: "human" }, OFF)).toBe(true);
    expect(countsTowardUnread({}, OFF)).toBe(true);
    expect(countsTowardUnread(null, OFF)).toBe(true);
    expect(countsTowardUnread({ audience: "agent" }, { agents: true, system: false })).toBe(true);
  });

  it("does not infer a type from the sender uid", () => {
    expect(countsTowardUnread({ fromPersonUid: "bot_x" } as never, OFF)).toBe(true);
  });

  it("inbox catch-up skips hidden messages when counting unread", () => {
    const page = {
      events: [
        { fromPersonUid: "prs_ada", createdAt: "2026-10-23T01:00:00Z", audience: "human" },
        { fromPersonUid: "prs_ada", createdAt: "2026-10-23T01:01:00Z", audience: "agent" },
        { fromPersonUid: "prs_bo", createdAt: "2026-10-23T01:02:00Z", isSystemEvent: true },
      ],
    };
    const counted = pairUnreadsFromInboxPage(page, { since: "2026-10-23T00:00:00Z", messageTypes: OFF });
    expect(counted.pairUnreads).toEqual([{ withPersonUid: "prs_ada", unreadCount: 1 }]);
    const legacy = pairUnreadsFromInboxPage(page, { since: "2026-10-23T00:00:00Z" });
    expect(legacy.pairUnreads).toEqual([
      { withPersonUid: "prs_ada", unreadCount: 2 },
      { withPersonUid: "prs_bo", unreadCount: 1 },
    ]);
  });

  it("mesh wakes carry the type markers the rail gates on", () => {
    const wakes = createChatWakeBus();
    const seen: unknown[] = [];
    wakes.on("channel:new-message", (p) => seen.push(p));
    wakes.on("dm:new-message", (p) => seen.push(p));
    routeMeshWake(JSON.stringify({ type: "channel", channelId: "chn_1", audience: "agent" }), wakes);
    routeMeshWake(JSON.stringify({ type: "dm", fromPersonUid: "prs_ada", isSystemEvent: true }), wakes);
    routeMeshWake(JSON.stringify({ type: "dm", fromPersonUid: "prs_bo" }), wakes);
    expect(seen).toEqual([
      { channelId: "chn_1", audience: "agent" },
      { fromPersonUid: "prs_ada", isSystemEvent: true },
      { fromPersonUid: "prs_bo" },
    ]);
  });
});
