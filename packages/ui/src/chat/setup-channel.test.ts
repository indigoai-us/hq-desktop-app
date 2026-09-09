import { describe, expect, it } from "vitest";

import type { Channel } from "./channels.js";
import {
  applySidebarFilters,
  groupByDay,
  normalizeConversations,
} from "./sidebar-model.js";
import {
  isSetupChannel,
  SETUP_CHANNEL,
  SETUP_CHANNEL_DISPLAY_NAME,
  SETUP_CHANNEL_ID,
  SETUP_HERO,
  SETUP_HERO_RETURNING,
  hasRunWelcomeSetup,
  markWelcomeSetupRun,
  SETUP_ROW_ID,
  setupCompanies,
  setupCompanyActionLabel,
  setupHeroFor,
  withoutSeededCreateCompanyCards,
  withSetupChannel,
  withSetupPin,
} from "./setup-channel.js";
import type { Workspace } from "./workspaces.js";

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: false,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
  ...over,
});

const PERSONAL = workspace({
  slug: "personal",
  displayName: "Personal",
  kind: "personal",
  state: "personal",
  cloudUid: "prs_me",
  hasLocalFolder: true,
});

const realChannel = (over: Partial<Channel> = {}): Channel => ({
  channelId: "ch_1",
  name: "general",
  scope: "company",
  companyUid: "org_1",
  membership: "joined",
  ...over,
});

describe("isSetupChannel", () => {
  it("matches only the setup wire id", () => {
    expect(isSetupChannel(SETUP_CHANNEL_ID)).toBe(true);
    expect(isSetupChannel("ch_setup")).toBe(false);
    expect(isSetupChannel(null)).toBe(false);
    expect(isSetupChannel(undefined)).toBe(false);
  });
});

describe("withSetupChannel", () => {
  it("prepends the synthetic channel when no real setup channel exists", () => {
    const out = withSetupChannel([realChannel()]);
    expect(out[0]).toBe(SETUP_CHANNEL);
    expect(out).toHaveLength(2);
  });

  it("dedupes against a real server-listed setup channel (real row wins)", () => {
    const real = realChannel({
      channelId: SETUP_CHANNEL_ID,
      name: "setup",
      unread: 3,
    });
    const out = withSetupChannel([realChannel(), real]);
    expect(out).toHaveLength(2);
    expect(out.filter((c) => c.channelId === SETUP_CHANNEL_ID)).toEqual([real]);
  });

  it("never mutates its input", () => {
    const input = [realChannel()];
    withSetupChannel(input);
    expect(input).toHaveLength(1);
  });

  // The 2026-09 rename is display-only. A migrated user's server row arrives
  // named "welcome" but under the UNCHANGED wire id, so the dedupe still fires
  // and the rail shows exactly one conversation. If the id had been renamed
  // too, this list would carry both a #setup and a #welcome row.
  it("yields a single row for a migrated user whose server row is named welcome", () => {
    const migrated = realChannel({
      channelId: SETUP_CHANNEL_ID,
      name: "welcome",
      unread: 2,
    });
    const out = withSetupChannel([realChannel(), migrated]);
    expect(out.filter((c) => isSetupChannel(c.channelId))).toEqual([migrated]);
    expect(out).toHaveLength(2);
  });
});

describe("setup channel rename invariants", () => {
  it("displays as welcome while routing on the unchanged setup wire id", () => {
    expect(SETUP_CHANNEL_DISPLAY_NAME).toBe("welcome");
    expect(SETUP_CHANNEL.name).toBe(SETUP_CHANNEL_DISPLAY_NAME);
    // Load-bearing: the id is the backend/Slack-bridge route key and the key
    // every user's history is stored under. Renaming it would orphan history
    // and break already-shipped clients.
    expect(SETUP_CHANNEL_ID).toBe("setup");
    expect(SETUP_ROW_ID).toBe("ch:setup");
  });
});

describe("withSetupPin", () => {
  it("adds the setup row id without duplicating it", () => {
    expect(withSetupPin([])).toEqual([SETUP_ROW_ID]);
    expect(withSetupPin(["dm:prs_1"])).toEqual([SETUP_ROW_ID, "dm:prs_1"]);
    expect(withSetupPin([SETUP_ROW_ID])).toEqual([SETUP_ROW_ID]);
  });

  it("leaves the setup row out when the user dismissed the default pin", () => {
    expect(withSetupPin([], { dismissed: true })).toEqual([]);
    expect(withSetupPin(["dm:prs_1"], { dismissed: true })).toEqual([
      "dm:prs_1",
    ]);
    // Strips a stale stored id too, so the row cannot sneak back in.
    expect(
      withSetupPin([SETUP_ROW_ID, "dm:prs_1"], { dismissed: true }),
    ).toEqual(["dm:prs_1"]);
  });

  it("never mutates its input", () => {
    const input = [SETUP_ROW_ID, "dm:prs_1"];
    withSetupPin(input, { dismissed: true });
    withSetupPin(input);
    expect(input).toEqual([SETUP_ROW_ID, "dm:prs_1"]);
  });
});

describe("withSetupChannel activity slot", () => {
  it("stamps the synthetic row with the requested activity", () => {
    const at = Date.parse("2026-09-02T00:00:00.000Z");
    const out = withSetupChannel([realChannel()], { activityAt: at });
    expect(out[0]).toMatchObject({ channelId: SETUP_CHANNEL_ID, arrivedAt: at });
    // The shared constant is untouched.
    expect(SETUP_CHANNEL.arrivedAt).toBeUndefined();
  });

  it("does not stamp a real server-listed setup channel", () => {
    const real = realChannel({ channelId: SETUP_CHANNEL_ID, name: "setup" });
    const out = withSetupChannel([real], { activityAt: Date.now() });
    expect(out).toEqual([real]);
  });
});

describe("setup row through the sidebar derivation", () => {
  it("lands in the PINNED group at the top under the default 'mine' filter", () => {
    const rows = applySidebarFilters(
      normalizeConversations(withSetupChannel([realChannel()]), [], {
        pinnedIds: withSetupPin([]),
      }),
      { show: "mine" },
    );
    const grouped = groupByDay(rows);
    expect(grouped.pinned.map((r) => r.id)).toContain(SETUP_ROW_ID);
    const setupRow = grouped.pinned.find((r) => r.id === SETUP_ROW_ID);
    expect(setupRow?.kind).toBe("channel");
    // Display name after the 2026-09 rename; the channelId below is the wire
    // id, which deliberately did NOT change.
    expect(setupRow?.title).toBe("welcome");
    expect(setupRow?.channelId).toBe(SETUP_CHANNEL_ID);
  });

  it("unpinned: stays listed under TODAY (bottom), never in the collapsed LAST WEEK bucket", () => {
    const now = Date.parse("2026-09-02T15:00:00.000Z");
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const other = realChannel({
      lastActivityAt: new Date(now - 60_000).toISOString(),
    });
    const rows = applySidebarFilters(
      normalizeConversations(
        withSetupChannel([other], { activityAt: todayStart }),
        [],
        { pinnedIds: withSetupPin([], { dismissed: true }) },
      ),
      { show: "mine" },
    );
    const grouped = groupByDay(rows, now);
    expect(grouped.pinned.map((r) => r.id)).not.toContain(SETUP_ROW_ID);
    expect(grouped.lastWeek.map((r) => r.id)).not.toContain(SETUP_ROW_ID);
    expect(grouped.sections).toHaveLength(1);
    expect(grouped.sections[0].label.startsWith("TODAY")).toBe(true);
    expect(grouped.sections[0].rows.map((r) => r.id)).toEqual([
      "ch:ch_1",
      SETUP_ROW_ID,
    ]);
  });

  it("unpinned without an activity slot would sink into LAST WEEK (why the sidebar stamps it)", () => {
    const rows = normalizeConversations(withSetupChannel([]), [], {
      pinnedIds: withSetupPin([], { dismissed: true }),
    });
    expect(groupByDay(rows).lastWeek.map((r) => r.id)).toEqual([SETUP_ROW_ID]);
  });
});

describe("setup roster helpers", () => {
  it("counts every company workspace, whatever its sync state", () => {
    expect(setupCompanies(null)).toEqual([]);
    expect(setupCompanies([PERSONAL])).toEqual([]);
    const cloudOnly = workspace();
    const pending = workspace({
      slug: "beta",
      displayName: "Beta",
      cloudUid: "cmp_beta",
      membershipStatus: "pending",
    });
    const broken = workspace({
      slug: "gamma",
      displayName: "Gamma",
      cloudUid: "cmp_gamma",
      state: "broken",
      hasLocalFolder: true,
    });
    expect(
      setupCompanies([PERSONAL, cloudOnly, pending, broken]).map((c) => c.slug),
    ).toEqual(["acme", "beta", "gamma"]);
  });

  it("switches the hero copy once the roster has a company", () => {
    expect(setupHeroFor(null)).toBe(SETUP_HERO);
    expect(setupHeroFor([PERSONAL])).toBe(SETUP_HERO);
    expect(setupHeroFor([PERSONAL, workspace()])).toBe(SETUP_HERO_RETURNING);
    expect(SETUP_HERO_RETURNING.body).not.toMatch(/cmp_|prs_/);
  });

  it("labels a settled company Open and anything else Continue setup", () => {
    expect(
      setupCompanyActionLabel(
        workspace({ state: "synced", hasLocalFolder: true }),
      ),
    ).toBe("Open Acme");
    expect(setupCompanyActionLabel(workspace())).toBe(
      "Continue setup for Acme",
    );
    expect(
      setupCompanyActionLabel(
        workspace({ state: "synced", hasLocalFolder: true, membershipStatus: "pending" }),
      ),
    ).toBe("Continue setup for Acme");
    expect(
      setupCompanyActionLabel(workspace({ displayName: "", slug: "ramen-bae" })),
    ).toBe("Continue setup for Ramen Bae");
  });

  it("hides the seeded create_company card only while a company exists and none was requested", () => {
    const createCard = {
      eventId: "evt_create",
      systemEvent: { v: 1, type: "lifecycle_card", kind: "create_company" },
    };
    const summary = {
      eventId: "evt_summary",
      systemEvent: { v: 1, type: "lifecycle_card", kind: "companies_summary" },
    };
    const plain = { eventId: "evt_hello", systemEvent: undefined };
    const messages = [plain, createCard, summary];

    expect(
      withoutSeededCreateCompanyCards(messages, {
        hasCompany: true,
        createRequested: false,
      }).map((m) => m.eventId),
    ).toEqual(["evt_hello", "evt_summary"]);
    expect(
      withoutSeededCreateCompanyCards(messages, {
        hasCompany: false,
        createRequested: false,
      }),
    ).toEqual(messages);
    expect(
      withoutSeededCreateCompanyCards(messages, {
        hasCompany: true,
        createRequested: true,
      }),
    ).toEqual(messages);
  });
});

describe("welcome-first boot persistence", () => {
  it("is off until Run Setup is used, then sticks", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(hasRunWelcomeSetup(storage)).toBe(false);
    markWelcomeSetupRun(storage);
    expect(hasRunWelcomeSetup(storage)).toBe(true);
  });

  it("tolerates unavailable storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(hasRunWelcomeSetup(broken)).toBe(false);
    expect(() => markWelcomeSetupRun(broken)).not.toThrow();
  });
});
