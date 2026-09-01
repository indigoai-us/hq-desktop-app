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
});
