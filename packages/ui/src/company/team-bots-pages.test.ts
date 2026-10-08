import { describe, expect, it } from "vitest";
import {
  addInvite,
  emptyInviteDraft,
  filterBots,
  mergeBotRows,
  inviteRoleFields,
  metadata,
  pauseAllowed,
  pendingInvitesFromTelemetry,
  revokeInvite,
  type BotListRow,
  type PendingInvite,
} from "./team-bots-pages.js";

const sam: PendingInvite = {
  id: "inv-sam",
  email: "sam@restorecolorado.org",
  role: "guest",
  prefixes: ["restore-colorado/"],
  groups: [],
  sentLabel: "2d ago",
  sentBy: "Maggie",
};

describe("US-027 team and bots", () => {
  it("keeps the scroll budget inside one percent", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
  });

  it("shows prefixes and hides groups for Guest", () => {
    expect(inviteRoleFields("guest")).toEqual({ showPrefixes: true, showGroups: false });
    expect(inviteRoleFields("member")).toEqual({ showPrefixes: false, showGroups: true });
    expect(inviteRoleFields("owner").showGroups).toBe(true);
    expect(inviteRoleFields("admin").showGroups).toBe(true);
  });

  it("drops a pending invite only after Revoke is confirmed", () => {
    const held = revokeInvite([sam], sam.id, false);
    expect(held).toEqual([sam]);
    const gone = revokeInvite([sam], sam.id, true);
    expect(gone).toEqual([]);
  });

  it("stores a guest invite with prefixes and no groups", () => {
    const draft = {
      ...emptyInviteDraft(),
      email: "sam@restorecolorado.org",
      role: "guest" as const,
      prefixesText: "restore-colorado/\n",
      groups: ["Engineering"],
    };
    const [row] = addInvite([], draft, "Maggie");
    expect(row.prefixes).toEqual(["restore-colorado/"]);
    expect(row.groups).toEqual([]);
  });

  it("reads pending invites from the team telemetry payload", () => {
    const rows = pendingInvitesFromTelemetry({
      invites: [{ email: "priya@vyg.ai", role: "member", sentBy: "Corey", sentLabel: "5h ago" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("priya@vyg.ai");
  });

  it("filters bots and refuses Pause until confirmed", () => {
    const rows: BotListRow[] = [
      { uid: "a", name: "deacon", kind: "local", live: true, status: "live", detail: "", canPause: true },
      { uid: "b", name: "nightly", kind: "cloud", live: false, status: "idle", detail: "", canPause: true },
    ];
    expect(filterBots(rows, "local").map((r) => r.uid)).toEqual(["a"]);
    expect(filterBots(rows, "live")).toHaveLength(1);
    expect(filterBots(rows, "all")).toHaveLength(0 + 2);
    expect(pauseAllowed(false)).toBe(false);
    expect(pauseAllowed(true)).toBe(true);
  });

  it("lists a bot once when it is both local and on the cloud roster", () => {
    const local: BotListRow[] = [
      { uid: "agt_buddy", name: "buddy", kind: "local", live: true, status: "running", detail: "claude", canPause: true },
    ];
    const cloud: BotListRow[] = [
      { uid: "agt_buddy", name: "Buddy", kind: "cloud", live: false, status: "ready", detail: "Indigo", canPause: false },
      { uid: "agt_scout", name: "Scout", kind: "cloud", live: false, status: "ready", detail: "Indigo", canPause: true },
    ];
    const rows = mergeBotRows(local, cloud);
    expect(rows.map((r) => r.uid)).toEqual(["agt_buddy", "agt_scout"]);
    expect(rows[0].kind).toBe("local");
    expect(rows[0].canPause).toBe(true);
    expect(mergeBotRows([], [cloud[1], cloud[1]])).toHaveLength(1);
  });
});
