import { describe, expect, it } from "vitest";

import type { ConversationRow } from "./sidebar-model.js";
import {
  composerPlaceholderFor,
  DIRECT_MESSAGE_PLACEHOLDER,
  GROUP_MESSAGE_PLACEHOLDER,
  isRawParticipantUid,
  resolveConversationRow,
  resolveConversationTitle,
} from "./conversation-title.js";

const AGENT_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";

function dm(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: `dm:${AGENT_UID}`,
    kind: "dm",
    title: AGENT_UID,
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    personUid: AGENT_UID,
    ...overrides,
  };
}

function channel(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "ch:hq-desktop",
    kind: "channel",
    title: "hq-desktop",
    companyUid: "cmp_acme",
    unreadDot: false,
    lastActivityAt: 1,
    pinned: false,
    channelId: "hq-desktop",
    ...overrides,
  };
}

describe("isRawParticipantUid", () => {
  it("is empty-safe", () => {
    expect(isRawParticipantUid(null)).toBe(false);
    expect(isRawParticipantUid(undefined)).toBe(false);
    expect(isRawParticipantUid("")).toBe(false);
    expect(isRawParticipantUid("   ")).toBe(false);
  });

  it("detects known participant uid shapes", () => {
    expect(isRawParticipantUid(AGENT_UID)).toBe(true);
    expect(isRawParticipantUid("usr_01ABCDEF")).toBe(true);
    expect(isRawParticipantUid("prs_ada")).toBe(true);
    expect(isRawParticipantUid("prs_01KQ2RY9VB1S105X2GZ2EPHKWY")).toBe(true);
    expect(isRawParticipantUid("person-corey")).toBe(true);
    expect(isRawParticipantUid("email:ada@example.com")).toBe(true);
    expect(isRawParticipantUid("xy_01KQ2RY9VB1S105X2GZ2")).toBe(true);
  });

  it("does not flag human titles or short channel ids", () => {
    expect(isRawParticipantUid("Polar Data Agent")).toBe(false);
    expect(isRawParticipantUid("Direct message")).toBe(false);
    expect(isRawParticipantUid("Ada")).toBe(false);
    expect(isRawParticipantUid("chn_proj")).toBe(false);
    expect(isRawParticipantUid("launch")).toBe(false);
    expect(isRawParticipantUid("ops-team01")).toBe(false);
    expect(isRawParticipantUid("xy_abcdef")).toBe(false);
  });
});

describe("resolveConversationRow", () => {
  it("matches by id, then DM personUid without a channelId", () => {
    const rail = dm({ title: "Polar Data Agent" });
    expect(resolveConversationRow(dm(), [rail])).toBe(rail);
    expect(
      resolveConversationRow(
        dm({ id: "dm:other" }),
        [rail],
      ),
    ).toBe(rail);
    expect(
      resolveConversationRow(dm(), [
        { ...rail, channelId: "chn_group", kind: "group", id: "ch:chn_group" },
      ]),
    ).toBeNull();
    expect(resolveConversationRow(null, [rail])).toBeNull();
    expect(resolveConversationRow(dm(), [])).toBeNull();
  });
});

describe("resolveConversationTitle", () => {
  it("prefers a non-uid rail title", () => {
    const rail = dm({ title: "Polar Data Agent" });
    expect(resolveConversationTitle(dm(), [rail])).toBe("Polar Data Agent");
  });

  it("falls back to a non-uid row title, else a neutral DM/group placeholder", () => {
    expect(resolveConversationTitle(dm({ title: "Scout" }), [])).toBe("Scout");
    expect(resolveConversationTitle(dm(), [])).toBe(DIRECT_MESSAGE_PLACEHOLDER);
    expect(
      resolveConversationTitle(
        {
          id: "grp:1",
          kind: "group",
          title: AGENT_UID,
          companyUid: null,
          unreadDot: false,
          lastActivityAt: 0,
          pinned: false,
        },
        [],
      ),
    ).toBe(GROUP_MESSAGE_PLACEHOLDER);
  });

  it("leaves channel titles unchanged even when they look like identifiers", () => {
    expect(resolveConversationTitle(channel(), [])).toBe("hq-desktop");
    expect(
      resolveConversationTitle(channel({ title: "chn_missing" }), []),
    ).toBe("chn_missing");
  });

  it("returns empty when there is no row", () => {
    expect(resolveConversationTitle(null, [])).toBe("");
  });
});

describe("composerPlaceholderFor", () => {
  it("uses Reply… without a row", () => {
    expect(composerPlaceholderFor(null, "")).toBe("Reply…");
  });

  it("hides the uid behind a generic send prompt for placeholder titles", () => {
    expect(
      composerPlaceholderFor(dm(), DIRECT_MESSAGE_PLACEHOLDER),
    ).toBe("Send a message — or type @ to mention an agent…");
    expect(
      composerPlaceholderFor(
        { ...dm(), kind: "group", id: "grp:1" },
        GROUP_MESSAGE_PLACEHOLDER,
      ),
    ).toBe("Send a message — or type @ to mention an agent…");
  });

  it("keeps the existing Message formats once a real title is known", () => {
    expect(composerPlaceholderFor(dm({ title: "Polar Data Agent" }), "Polar Data Agent")).toBe(
      "Message Polar Data Agent — or type @ to mention an agent…",
    );
    expect(composerPlaceholderFor(channel(), "launch")).toBe(
      "Message # launch — or type @ to mention an agent…",
    );
  });
});
