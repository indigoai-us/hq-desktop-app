import { describe, expect, it } from "vitest";

import type { Workspace } from "../chat/workspaces.js";
import {
  appearanceThemeOptions,
  applyColorTheme,
  applyUiSize,
  calendarAccountLabel,
  companyAvatarWash,
  membershipStatusLabel,
  normalizeColorTheme,
  roleLabel,
  settingsCompanyLists,
} from "./shell-settings-model.js";

function ws(partial: Partial<Workspace>): Workspace {
  return {
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    cloudUid: "co_indigo",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "owner",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...partial,
  };
}

describe("settingsCompanyLists", () => {
  it("splits active companies, pending invites, and personal", () => {
    const lists = settingsCompanyLists([
      ws({ slug: "indigo", displayName: "Indigo", role: "owner" }),
      ws({
        slug: "acme",
        displayName: "Acme",
        cloudUid: "co_acme",
        role: "member",
        membershipStatus: "pending",
      }),
      ws({
        slug: "personal",
        displayName: "Personal",
        kind: "personal",
        cloudUid: "prs_me",
        role: "owner",
      }),
    ]);
    expect(lists.active.map((r) => r.name)).toEqual(["Indigo"]);
    expect(lists.active[0]?.role).toBe("Owner");
    expect(lists.active[0]?.initials).toBe("IN");
    expect(lists.pending).toHaveLength(1);
    expect(lists.pending[0]?.status).toBe("Invite");
    expect(lists.personal?.personal).toBe(true);
  });

  it("synthesizes a Personal row when memberships have none", () => {
    const lists = settingsCompanyLists(
      [ws({ slug: "indigo", displayName: "Indigo" })],
      "Stefan Johnson",
    );
    expect(lists.personal?.name).toBe("Personal");
    expect(lists.personal?.role).toBe("Owner");
  });

  it("is empty-safe and still offers Personal", () => {
    const lists = settingsCompanyLists(null);
    expect(lists.active).toEqual([]);
    expect(lists.pending).toEqual([]);
    expect(lists.personal?.personal).toBe(true);
  });
});

describe("role + status labels", () => {
  it("title-cases known roles and statuses", () => {
    expect(roleLabel("admin")).toBe("Admin");
    expect(roleLabel(null)).toBe("Member");
    expect(membershipStatusLabel("pending")).toBe("Invite");
    expect(membershipStatusLabel(undefined)).toBe("Active");
  });
});

describe("appearance theme", () => {
  it("normalizes unknown values to dark (current V2 default)", () => {
    expect(normalizeColorTheme("nope")).toBe("dark");
    expect(normalizeColorTheme("light")).toBe("light");
  });

  it("offers only Dark on the desktop shell (pinned-dark window)", () => {
    const desktop = appearanceThemeOptions(true);
    expect(desktop.map((t) => t.id)).toEqual(["dark"]);
  });

  it("offers System/Light/Dark on the web shell", () => {
    const web = appearanceThemeOptions(false);
    expect(web.map((t) => t.id)).toEqual(["system", "light", "dark"]);
  });

  it("applies and clears data-force-theme", () => {
    const attrs = new Map<string, string>();
    const fakeRoot = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;
    const store: Record<string, string> = {};
    const storage = {
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    applyColorTheme("light", fakeRoot, storage);
    expect(attrs.get("data-force-theme")).toBe("light");
    applyColorTheme("system", fakeRoot, storage);
    expect(attrs.has("data-force-theme")).toBe(false);
    expect(store["hq-work-color-theme"]).toBe("system");
  });
});

describe("interface density", () => {
  it("sets data-ui-size except for default", () => {
    const attrs = new Map<string, string>();
    const fakeRoot = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;
    applyUiSize("compact", fakeRoot);
    expect(attrs.get("data-ui-size")).toBe("compact");
    applyUiSize("default", fakeRoot);
    expect(attrs.has("data-ui-size")).toBe(false);
  });
});

describe("companyAvatarWash", () => {
  it("is stable for the same key", () => {
    expect(companyAvatarWash("co_indigo")).toEqual(
      companyAvatarWash("co_indigo"),
    );
    expect(companyAvatarWash("co_indigo")).not.toEqual(
      companyAvatarWash("co_other"),
    );
  });
});

describe("calendarAccountLabel", () => {
  it("prefers email then display name", () => {
    expect(calendarAccountLabel({ email: "stefan@getindigo.ai" })).toBe(
      "stefan@getindigo.ai",
    );
    expect(calendarAccountLabel({ displayName: "Work" })).toBe("Work");
    expect(calendarAccountLabel(null)).toBe("Calendar");
  });
});
