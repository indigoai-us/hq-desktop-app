import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PLACEHOLDERS,
  accountPageId,
  accountPlaceholderForPage,
  accountRoleRows,
  ownLiveWork,
  readRosterRolesCache,
  selfRoleFromRoster,
  UNKNOWN_ROLE,
  writeRosterRolesCache,
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

  it("lists one role row per company and skips the personal workspace", () => {
    expect(
      accountRoleRows(
        [
          { uid: "co_indigo", label: "Indigo", role: null, kind: "company" },
          { uid: "prs_me", label: "Personal", role: "owner", kind: "personal" },
        ],
        { co_indigo: "owner" },
      ),
    ).toEqual([{ uid: "co_indigo", label: "Indigo", role: "owner" }]);
  });

  it("never shows the cached membership role when the roster has none (QA-048 re-test)", () => {
    // Runtime case: unicom is not the open company, the native contacts read
    // carried no role, and the cached membership said owner for every company.
    const unicomRoster = { contacts: [{ personUid: "prs_me", email: "corey@x.com", displayName: "Corey" }] };
    const roles = { co_unicom: selfRoleFromRoster(unicomRoster, "prs_me", "corey@x.com") };
    expect(
      accountRoleRows(
        [
          { uid: "co_unicom", label: "unicom", role: "owner", kind: "company" },
          { uid: "co_unloaded", label: "Unloaded", role: "owner", kind: "company" },
        ],
        roles,
      ),
    ).toEqual([
      { uid: "co_unicom", label: "unicom", role: UNKNOWN_ROLE },
      { uid: "co_unloaded", label: "Unloaded", role: UNKNOWN_ROLE },
    ]);
  });

  it("shows the roster role for a company that is not open (QA-048)", () => {
    expect(
      accountRoleRows(
        [
          { uid: "co_unicom", label: "unicom", role: "owner", kind: "company" },
          { uid: "co_indigo", label: "Indigo", role: "owner", kind: "company" },
        ],
        { co_unicom: "member", co_indigo: "owner" },
      ),
    ).toEqual([
      { uid: "co_unicom", label: "unicom", role: "member" },
      { uid: "co_indigo", label: "Indigo", role: "owner" },
    ]);
  });

  it("matches the roster row by email when the person signed in under a second identity", () => {
    const rows = [{ personUid: "prs_google", email: "Corey@X.com", role: "member" }];
    expect(selfRoleFromRoster(rows, "prs_me", "corey@x.com")).toBe("member");
    expect(selfRoleFromRoster([...rows, { personUid: "prs_me", role: "owner" }], "prs_me", "corey@x.com")).toBe("owner");
  });

  it("caches roster roles per person", () => {
    localStorage.clear();
    writeRosterRolesCache("prs_me", { co_unicom: "member", co_x: null });
    expect(readRosterRolesCache("prs_me")).toEqual({ co_unicom: "member", co_x: null });
    expect(readRosterRolesCache("prs_else")).toEqual({});
  });

  it("reads the signed-in person's role from a company roster payload", () => {
    const rows = [
      { personUid: "prs_else", role: "owner" },
      { personUid: "prs_me", role: "member" },
    ];
    expect(selfRoleFromRoster(rows, "prs_me")).toBe("member");
    expect(selfRoleFromRoster({ contacts: rows }, "prs_me")).toBe("member");
    expect(selfRoleFromRoster([{ personUid: "prs_me", membershipRole: "admin" }], "prs_me")).toBe("admin");
    expect(selfRoleFromRoster(rows, "prs_missing")).toBeNull();
    expect(selfRoleFromRoster(null, "prs_me")).toBeNull();
    expect(selfRoleFromRoster(rows, "")).toBeNull();
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

  it("names the company open in the main pane over the first online company (QA-073)", () => {
    const online = { status: "online" as const, actorType: "human" as const, at: "" };
    const snapshot = new Map([["co_golden", new Map([["prs_me", online]])]]);
    const labels = { co_golden: "Golden Thread", co_hpo: "hpo" };
    expect(ownLiveWork(snapshot, "prs_me", labels, "co_hpo")).toEqual({
      live: true,
      work: "Working in hpo",
    });
    expect(ownLiveWork(snapshot, "prs_me", labels, null).work).toBe("Working in Golden Thread");
    expect(ownLiveWork(snapshot, "prs_away", labels, "co_hpo")).toEqual({ live: false, work: "" });
  });
});
