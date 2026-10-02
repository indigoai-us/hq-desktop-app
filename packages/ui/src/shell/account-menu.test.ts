import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PLACEHOLDERS,
  accountPageId,
  accountPlaceholderForPage,
  accountRoleRows,
  ownLiveWork,
} from "./account-menu.js";

describe("account menu (US-010)", () => {
  it("routes Profile, Billing, and Settings to US-035 placeholders", () => {
    expect(accountPlaceholderForPage(accountPageId("profile"))).toEqual(
      ACCOUNT_PLACEHOLDERS.profile,
    );
    expect(accountPlaceholderForPage(accountPageId("billing"))?.title).toBe("Billing");
    expect(accountPlaceholderForPage(accountPageId("settings"))?.story).toBe("US-035");
    expect(accountPlaceholderForPage("rail-secrets")).toBeNull();
  });

  it("lists company role rows and skips personal and role-less workspaces", () => {
    expect(
      accountRoleRows([
        { uid: "co_indigo", label: "Indigo", role: "owner", kind: "company" },
        { uid: "co_blank", label: "Blank", role: null, kind: "company" },
        { uid: "prs_me", label: "Personal", role: "owner", kind: "personal" },
      ]),
    ).toEqual([{ uid: "co_indigo", label: "Indigo", role: "owner" }]);
  });

  it("reads the signed-in person's live work from a PresenceStore snapshot", () => {
    const snapshot = new Map([
      ["co_other", new Map([["prs_else", { status: "online" as const, actorType: "human" as const, at: "" }]])],
      ["co_indigo", new Map([["prs_me", { status: "online" as const, actorType: "human" as const, at: "" }]])],
    ]);
    expect(ownLiveWork(snapshot, "prs_me", { co_indigo: "Indigo" })).toEqual({
      live: true,
      work: "Working in Indigo",
    });
    expect(ownLiveWork(snapshot, "prs_away").live).toBe(false);
  });
});
