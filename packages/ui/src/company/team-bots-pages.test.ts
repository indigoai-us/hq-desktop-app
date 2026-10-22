import { describe, expect, it } from "vitest";
import {
  confirmedInvite,
  emptyInviteDraft,
  inviteFailureText,
  inviteRequest,
  withConfirmedInvite,
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

  it("asks the server for a guest invite with prefixes and no groups", () => {
    const draft = {
      ...emptyInviteDraft(),
      email: " sam@restorecolorado.org ",
      role: "guest" as const,
      prefixesText: "restore-colorado/\n",
      groups: ["Engineering"],
    };
    expect(inviteRequest("cmp_rc", draft)).toEqual({
      companyUid: "cmp_rc",
      inviteeEmail: "sam@restorecolorado.org",
      role: "guest",
      allowedPrefixes: ["restore-colorado/"],
    });
  });

  it("builds the pending row from the server's membership, keyed by its membership key (DEV-5255)", () => {
    const draft = { ...emptyInviteDraft(), email: "kade@example.com" };
    const confirmed = confirmedInvite(
      { membership: { membershipKey: "email:kade@example.com#cmp_a", inviteeEmail: "kade@example.com", role: "member" }, emailSent: true },
      draft,
      "Rory",
    );
    expect(confirmed?.invite.id).toBe("email:kade@example.com#cmp_a");
    expect(confirmed?.emailSent).toBe(true);
    expect(withConfirmedInvite([sam], confirmed!.invite).map((r) => r.id)).toEqual(["email:kade@example.com#cmp_a", sam.id]);
  });

  it("has no row when the server answer carries no membership (DEV-5255)", () => {
    const draft = { ...emptyInviteDraft(), email: "kade@example.com" };
    expect(confirmedInvite({}, draft, "Rory")).toBeNull();
    expect(confirmedInvite({ membership: { inviteeEmail: "kade@example.com" } }, draft, "Rory")).toBeNull();
    expect(confirmedInvite(undefined, draft, "Rory")).toBeNull();
  });

  it("turns invite refusals into plain sentences, never a machine code (DEV-5255)", () => {
    expect(inviteFailureText({ code: "MEMBERSHIP_ALREADY_EXISTS", message: "Membership already exists" })).toBe(
      "That person is already invited or on the team.",
    );
    expect(inviteFailureText({ code: "PLAN_LIMIT_EXCEEDED", message: "Your plan limit is reached. Members: 5 of 5 used." })).toBe(
      "Your plan limit is reached. Members: 5 of 5 used.",
    );
    expect(inviteFailureText({ code: "http-500", message: "POST /membership/invite failed" })).toBe(
      "Couldn't send the invite. Try again.",
    );
    expect(inviteFailureText(null)).toBe("Couldn't send the invite. Try again.");
  });

  it("maps an admin role refusal to plain language with a next step, never the raw code or server text", () => {
    const text = inviteFailureText({
      code: "ADMIN_ROLE_TARGET_RESTRICTED",
      message: "Admin can only invite at role=member; ask an owner to invite at this role",
    });
    expect(text).toBe("Admins can invite people as Members only. Choose Member, or ask an owner to send this invite.");
    expect(text).not.toMatch(/ADMIN_ROLE_TARGET_RESTRICTED|role=|[A-Z]{3,}_[A-Z]/);
  });

  it("never passes through server text for a code it does not know", () => {
    const text = inviteFailureText({ code: "SOMETHING_NEW", message: "Invalid groupIds: grp_x not in company" });
    expect(text).toBe("Couldn't send the invite. Try again.");
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
