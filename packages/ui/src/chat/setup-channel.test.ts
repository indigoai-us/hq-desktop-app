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
  SETUP_CHANNEL_ID,
  SETUP_ROW_ID,
  withSetupChannel,
  withSetupPin,
} from "./setup-channel.js";

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
    expect(setupRow?.title).toBe("setup");
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
