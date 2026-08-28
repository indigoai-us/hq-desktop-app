import { describe, expect, it } from "vitest";

import {
  channelCreateCandidate,
  filterSwitcher,
  switcherRowsFromConversations,
} from "./sidebar-modal-fixtures.js";
import type { ConversationRow } from "./sidebar-model.js";

function row(partial: Partial<ConversationRow>): ConversationRow {
  return {
    id: "ch:one",
    kind: "channel",
    title: "one",
    companyUid: "cmp_indigo",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: "chn_one",
    ...partial,
  };
}

describe("switcherRowsFromConversations", () => {
  it("maps live rows and does not invent a prototype roster", () => {
    expect(switcherRowsFromConversations([])).toEqual([]);
    expect(
      switcherRowsFromConversations(
        [
          row({ title: "work-mesh-testing" }),
          row({
            id: "dm:prs_ada",
            kind: "dm",
            title: "Ada",
            personUid: "prs_ada",
            channelId: undefined,
            companyUid: null,
          }),
        ],
        (uid) => (uid === "cmp_indigo" ? "Indigo" : ""),
      ),
    ).toEqual([
      {
        id: "chn_one",
        name: "work-mesh-testing",
        company: "Indigo",
        kind: "channel",
      },
      { id: "prs_ada", name: "Ada", company: "", kind: "dm" },
    ]);
  });

  it("filters the live roster only", () => {
    const rows = switcherRowsFromConversations([
      row({ title: "alpha" }),
      row({ id: "ch:beta", title: "beta", channelId: "chn_beta" }),
    ]);
    expect(filterSwitcher(rows, "alp").map((item) => item.name)).toEqual([
      "alpha",
    ]);
    expect(filterSwitcher(rows, "zzz")).toEqual([]);
  });
});

describe("channelCreateCandidate", () => {
  const rows = switcherRowsFromConversations([
    row({ title: "launch-week", id: "ch:lw", channelId: "chn_lw" }),
    row({
      id: "dm:prs_ada",
      kind: "dm",
      title: "Ada",
      personUid: "prs_ada",
      channelId: undefined,
    }),
  ]);

  it("offers creation for a channel name that doesn't exist", () => {
    expect(channelCreateCandidate(rows, "growth")).toBe("growth");
    expect(channelCreateCandidate(rows, "#growth")).toBe("growth");
  });

  it("normalizes spaces to dashes and strips leading hashes", () => {
    expect(channelCreateCandidate(rows, "  # Launch Party ")).toBe(
      "Launch-Party",
    );
  });

  it("suppresses the offer when the channel already exists (any case)", () => {
    expect(channelCreateCandidate(rows, "launch-week")).toBeNull();
    expect(channelCreateCandidate(rows, "#Launch-Week")).toBeNull();
  });

  it("does not treat a DM title as an existing channel", () => {
    expect(channelCreateCandidate(rows, "Ada")).toBe("Ada");
  });

  it("returns null for an empty or hash-only query", () => {
    expect(channelCreateCandidate(rows, "")).toBeNull();
    expect(channelCreateCandidate(rows, "  #  ")).toBeNull();
  });
});
