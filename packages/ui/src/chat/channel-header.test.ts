import { describe, expect, it } from "vitest";
import { liveMemberCount, memberCountLabel, pinnedNoteText } from "./channel-header.js";
import type { ChannelStatusModel, StatusPersonRow } from "./channel-status-model.js";

function person(uid: string, online: boolean): StatusPersonRow {
  return { personUid: uid, displayName: uid, online } as StatusPersonRow;
}

describe("US-015 channel header extras (home-channel)", () => {
  it("labels the member count with singular and plural", () => {
    expect(memberCountLabel(7)).toBe("7 members");
    expect(memberCountLabel(1)).toBe("1 member");
    expect(memberCountLabel(0)).toBeNull();
    expect(memberCountLabel(undefined)).toBeNull();
  });

  it("collapses the pinned description to its first non-empty line", () => {
    expect(pinnedNoteText("\n# Storyboard review Thu 14:00\nmore")).toBe(
      "Storyboard review Thu 14:00",
    );
    expect(pinnedNoteText("  ")).toBeNull();
    expect(pinnedNoteText(null)).toBeNull();
  });

  it("counts online members and agents once each from the presence-backed model", () => {
    const status = {
      members: [person("prs_a", true), person("prs_b", false)],
      agents: [person("agt_c", true), person("prs_a", true)],
    } as unknown as ChannelStatusModel;
    expect(liveMemberCount(status)).toBe(2);
    expect(liveMemberCount(null)).toBe(0);
  });
});
