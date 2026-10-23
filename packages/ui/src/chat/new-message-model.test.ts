import { describe, expect, it } from "vitest";

import { findExistingConversation } from "./new-message-model";
import type { ConversationRow } from "./sidebar-model";

function row(partial: Partial<ConversationRow> & Pick<ConversationRow, "id" | "kind">): ConversationRow {
  return { title: partial.id, companyUid: null, unreadDot: false, lastActivityAt: 0, pinned: false, ...partial };
}

const members = (...uids: string[]) => uids.map((personUid) => ({ personUid, displayName: personUid }));

// iOS #44: New message offers the conversation you already have with these
// people instead of starting a second one.
describe("findExistingConversation", () => {
  const rows = [
    row({ id: "dm:prs_ada", kind: "dm", personUid: "prs_ada" }),
    row({ id: "ch:g1", kind: "group", channelId: "g1", members: members("prs_me", "prs_ada", "prs_bob"), lastActivityAt: 10 }),
    row({ id: "ch:g2", kind: "group", channelId: "g2", members: members("prs_me", "prs_ada", "prs_bob", "prs_eve") }),
    row({ id: "ch:proj", kind: "channel", channelId: "proj", members: members("prs_ada", "prs_bob") }),
  ];

  it("finds the direct message for one person", () => {
    expect(findExistingConversation(rows, ["prs_ada"])?.id).toBe("dm:prs_ada");
    expect(findExistingConversation(rows, ["prs_zed"])).toBeNull();
  });

  it("finds a group with exactly those people, allowing for you", () => {
    expect(findExistingConversation(rows, ["prs_ada", "prs_bob"])?.id).toBe("ch:g1");
  });

  it("does not match a bigger group or a project channel", () => {
    expect(findExistingConversation(rows, ["prs_bob", "prs_eve"])).toBeNull();
    expect(
      findExistingConversation(
        rows.filter((r) => r.id !== "ch:g1"),
        ["prs_ada", "prs_bob"],
      ),
    ).toBeNull();
  });
});
