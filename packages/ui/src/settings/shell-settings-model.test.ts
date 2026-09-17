import { describe, expect, it } from "vitest";

import type { Workspace } from "../chat/workspaces.js";
import {
  DEFAULT_WINDOW_TRANSPARENCY,
  MAX_WINDOW_OPACITY,
  MIN_SLIDER_WINDOW_OPACITY,
} from "./appearance-seam.js";
import {
  appearanceThemeOptions,
  applyColorTheme,
  applyUiSize,
  applyWindowOpacity,
  calendarAccountLabel,
  currentColorTheme,
  hasAppearanceHost,
  readHostWindowOpacity,
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

  it("does not expose revoked memberships as active company rows", () => {
    const lists = settingsCompanyLists([
      ws({ slug: "active", displayName: "Active" }),
      ws({
        slug: "removed",
        displayName: "Removed",
        cloudUid: "co_removed",
        membershipStatus: "revoked",
      }),
    ]);
    expect(lists.active.map((row) => row.slug)).toEqual(["active"]);
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

describe("window opacity", () => {
  function fakeRoot(dataset: Record<string, string> = {}) {
    const vars = new Map<string, string>();
    const root = {
      dataset,
      style: {
        setProperty: (k: string, v: string) => vars.set(k, v),
      },
    } as unknown as HTMLElement;
    return { root, vars };
  }

  it("asks the host to apply the inverse transparency and keeps the legacy var", () => {
    const { root, vars } = fakeRoot({ windowTransparency: "35" });
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener("hq:appearance-request", (event) =>
      seen.push((event as CustomEvent).detail),
    );
    expect(applyWindowOpacity(72, root, target)).toBe(72);
    expect(seen).toEqual([{ colorTheme: "system", windowTransparency: 28 }]);
    expect(vars.get("--hq-window-opacity")).toBe("72%");
    // Host present → host owns the surface vars; no fallback write.
    expect(vars.has("--hq-window-transparency-factor")).toBe(false);
    expect(vars.has("--hq-window-alpha-light")).toBe(false);
  });

  it("writes the transparency vars itself when no host is installed", () => {
    const { root, vars } = fakeRoot();
    const target = new EventTarget();
    applyWindowOpacity(60, root, target);
    expect(vars.get("--hq-window-transparency-factor")).toBe("0.40");
    expect(vars.get("--hq-window-alpha-light")).toBe("0.60");
    expect(vars.get("--hq-window-alpha-dark")).toBe("0.73");
    applyWindowOpacity(100, root, target);
    expect(vars.get("--hq-window-transparency-factor")).toBe("0.00");
    expect(vars.get("--hq-window-alpha-light")).toBe("1.00");
    expect(vars.get("--hq-window-alpha-dark")).toBe("1.00");
  });

  // Regression: the floor must be able to express the shipped default
  // (DEFAULT_WINDOW_TRANSPARENCY = 65 → opacity 35). A 50 floor made the
  // default unrepresentable, so a fresh install seeded the slider at 50 and
  // the first drag visibly jumped the window.
  it("clamps to a slider range that can express the shipped default", () => {
    const { root } = fakeRoot();
    expect(MIN_SLIDER_WINDOW_OPACITY).toBe(
      MAX_WINDOW_OPACITY - DEFAULT_WINDOW_TRANSPARENCY,
    );
    expect(applyWindowOpacity(35, root, null)).toBe(35);
    expect(applyWindowOpacity(10, root, null)).toBe(MIN_SLIDER_WINDOW_OPACITY);
    expect(applyWindowOpacity(140, root, null)).toBe(100);
  });

  // Regression (CRITICAL): the host's request listener applies `detail` RAW —
  // it does NOT merge with its current preference, and normalizeColorTheme
  // (undefined) === "system", which deletes data-force-theme and resets the
  // native window theme. A partial {windowTransparency} payload therefore reset
  // a user's forced Light/Dark on every launch.
  it("carries the current colorTheme so the host's normalize cannot clobber it", () => {
    for (const theme of ["light", "dark"] as const) {
      const { root } = fakeRoot({ windowTransparency: "35", forceTheme: theme });
      const target = new EventTarget();
      const seen: Array<Record<string, unknown>> = [];
      target.addEventListener("hq:appearance-request", (event) =>
        seen.push((event as CustomEvent).detail as Record<string, unknown>),
      );
      applyWindowOpacity(72, root, target);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.colorTheme).toBe(theme);
      expect(seen[0]!.windowTransparency).toBe(28);
    }
  });

  it("reports the forced theme in the host's vocabulary (absent === system)", () => {
    expect(currentColorTheme(fakeRoot({ forceTheme: "light" }).root)).toBe("light");
    expect(currentColorTheme(fakeRoot({ forceTheme: "dark" }).root)).toBe("dark");
    // Absent attribute means "system" to the host — NOT this module's
    // dark-defaulting normalizeColorTheme.
    expect(currentColorTheme(fakeRoot().root)).toBe("system");
  });

  it("reads the host marker as slider opacity", () => {
    expect(hasAppearanceHost(fakeRoot().root)).toBe(false);
    expect(readHostWindowOpacity(fakeRoot().root)).toBeNull();
    const { root } = fakeRoot({ windowTransparency: "65" });
    expect(hasAppearanceHost(root)).toBe(true);
    // transparency 65 is the shipped default → opacity 35, and the read must
    // report it verbatim rather than clamping it up to the old 50 floor.
    expect(readHostWindowOpacity(root)).toBe(35);
    expect(readHostWindowOpacity(fakeRoot({ windowTransparency: "20" }).root)).toBe(80);
    expect(readHostWindowOpacity(fakeRoot({ windowTransparency: "nope" }).root)).toBeNull();
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
