import { describe, expect, it } from "vitest";
import {
  companyInvitesFromWorkspaces,
  inviteClaimOutcome,
  isCompanyInviteRequest,
  mergeCompanyInvites,
} from "./company-invite-requests.js";
import type { NotificationItem } from "./notifications-model.js";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

function item(
  partial: Partial<NotificationItem> & Pick<NotificationItem, "id" | "serverType">,
): NotificationItem {
  return {
    displayKind: "generic",
    typeIcon: "generic",
    actorName: "Acme",
    actorInitials: "AC",
    verbText: "Invite",
    contextLine: "",
    status: "unread",
    createdAt: "",
    createdAtMs: 0,
    timestampLabel: "",
    actionKind: null,
    actionRef: "acme",
    actionButtons: [],
    targetRef: "co_acme",
    actorPersonUid: null,
    sourceEventId: null,
    actionUsed: false,
    ...partial,
  };
}

describe("company invite requests", () => {
  it("turns a pending company workspace into one request", () => {
    const rows = companyInvitesFromWorkspaces([
      {
        slug: "acme",
        displayName: "Acme",
        kind: "company",
        membershipStatus: "pending",
        cloudUid: "co_acme",
        invitedBy: "ada@acme.com",
      },
      {
        slug: "personal",
        displayName: "Personal",
        kind: "company",
        membershipStatus: "pending",
      },
      {
        slug: "live",
        displayName: "Live",
        kind: "company",
        membershipStatus: "active",
      },
    ]);
    expect(rows.map((row) => row.actionRef)).toEqual(["acme"]);
    expect(rows[0]?.targetRef).toBe("co_acme");
    expect(rows[0]?.verbText).toBe("Invite to join Acme");
    expect(isCompanyInviteRequest(rows[0]!)).toBe(true);
  });

  it("keeps a server membership_invite and skips the duplicate workspace row", () => {
    const server = item({ id: "n-invite", serverType: "membership_invite" });
    const workspace = companyInvitesFromWorkspaces([
      {
        slug: "acme",
        displayName: "Acme",
        kind: "company",
        membershipStatus: "pending",
        cloudUid: "co_acme",
      },
    ]);
    expect(mergeCompanyInvites([server], workspace).map((row) => row.id)).toEqual([
      "n-invite",
    ]);
  });

  it("accept pins the company when the rail has room", () => {
    const outcome = inviteClaimOutcome(
      { ok: true, value: { claimedSlugs: ["acme"] } },
      "co_acme",
      ["co_a", "co_b"],
    );
    expect(outcome).toEqual({
      ok: true,
      companyUid: "co_acme",
      pinnedIds: ["co_a", "co_b", "co_acme"],
    });
  });

  it("accept leaves a full rail unchanged", () => {
    const full = ["a", "b", "c", "d", "e", "f"];
    const outcome = inviteClaimOutcome(
      { ok: true, value: {} },
      "co_acme",
      full,
    );
    expect(outcome).toEqual({ ok: true, companyUid: "co_acme", pinnedIds: null });
  });

  it("plan-limit refusal is a sentence and an approved upgrade link", () => {
    const outcome = inviteClaimOutcome(
      {
        ok: false,
        reason: "error",
        code: "PLAN_LIMIT_EXCEEDED",
        message: "Your plan limit is reached. Members: 5 of 5 used.",
        upgradeUrl: UPGRADE_URL,
      },
      "co_acme",
      [],
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("Your plan limit is reached. Members: 5 of 5 used.");
    expect(outcome.message).not.toContain("PLAN_LIMIT_EXCEEDED");
    expect(outcome.message).not.toContain("{");
    expect(outcome.upgradeUrl).toBe(UPGRADE_URL);
  });

  it("drops an upgrade link the host did not approve", () => {
    const outcome = inviteClaimOutcome(
      {
        ok: false,
        reason: "error",
        code: "PLAN_LIMIT_EXCEEDED",
        message: "Your plan limit is reached.",
        upgradeUrl: "https://evil.example/upgrade",
      },
      "co_acme",
      [],
    );
    expect(outcome).toMatchObject({ ok: false, upgradeUrl: null });
  });
});
