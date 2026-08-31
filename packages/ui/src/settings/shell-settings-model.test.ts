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
  PROFILE_SKELETON_DELAY_MS,
  profileFromMemberProfile,
  profilePanePhase,
  roleLabel,
  settingsCompanyLists,
  type ProfilePanePhase,
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

const PROFILE_PHASES: ProfilePanePhase[] = [
  "ready",
  "loading",
  "error",
  "empty",
];

describe("profilePanePhase", () => {
  it("returns ready whenever a profile is present, even while fetching or errored", () => {
    expect(
      profilePanePhase({ hasProfile: true, fetching: true, error: null }),
    ).toBe("ready");
    expect(
      profilePanePhase({ hasProfile: true, fetching: false, error: "fail" }),
    ).toBe("ready");
    expect(
      profilePanePhase({ hasProfile: true, fetching: true, error: "fail" }),
    ).toBe("ready");
  });

  it("returns loading when there is no profile and a fetch is in flight", () => {
    expect(
      profilePanePhase({ hasProfile: false, fetching: true, error: null }),
    ).toBe("loading");
  });

  it("prefers loading over error when there is no profile yet", () => {
    expect(
      profilePanePhase({ hasProfile: false, fetching: true, error: "fail" }),
    ).toBe("loading");
  });

  it("returns error when there is no profile, fetching is done, and error is set", () => {
    expect(
      profilePanePhase({ hasProfile: false, fetching: false, error: "fail" }),
    ).toBe("error");
  });

  it("returns empty when there is no profile, no error, and not fetching", () => {
    expect(
      profilePanePhase({ hasProfile: false, fetching: false, error: null }),
    ).toBe("empty");
  });

  it("treats a blank error as empty rather than error", () => {
    expect(
      profilePanePhase({ hasProfile: false, fetching: false, error: "" }),
    ).toBe("empty");
  });

  it("covers every ProfilePanePhase branch", () => {
    const seen = new Set<ProfilePanePhase>([
      profilePanePhase({ hasProfile: false, fetching: true, error: null }),
      profilePanePhase({ hasProfile: false, fetching: false, error: "fail" }),
      profilePanePhase({ hasProfile: false, fetching: false, error: null }),
      profilePanePhase({ hasProfile: true, fetching: false, error: "fail" }),
    ]);
    expect([...seen].sort()).toEqual([...PROFILE_PHASES].sort());
  });
});

describe("PROFILE_SKELETON_DELAY_MS", () => {
  it("is 150ms so fast loads do not flash a skeleton", () => {
    expect(PROFILE_SKELETON_DELAY_MS).toBe(150);
  });
});

describe("profileFromMemberProfile", () => {
  it("returns null unless trimmed displayName is non-empty", () => {
    expect(profileFromMemberProfile({})).toBeNull();
    expect(profileFromMemberProfile({ displayName: null })).toBeNull();
    expect(profileFromMemberProfile({ displayName: "   " })).toBeNull();
    expect(
      profileFromMemberProfile({
        displayName: "",
        email: "ada@example.com",
      }),
    ).toBeNull();
  });

  it("builds initial, fullName, first-word displayName, and trimmed email", () => {
    expect(
      profileFromMemberProfile({
        displayName: "Ada Lovelace",
        email: " ada@example.com ",
      }),
    ).toEqual({
      initial: "A",
      fullName: "Ada Lovelace",
      displayName: "Ada",
      email: "ada@example.com",
      verified: true,
    });
  });

  it("uppercases the first letter and treats missing email as unverified", () => {
    expect(
      profileFromMemberProfile({ displayName: " ada" }),
    ).toEqual({
      initial: "A",
      fullName: "ada",
      displayName: "ada",
      email: "",
      verified: false,
    });
  });
});
