import { describe, expect, it } from "vitest";
import {
  addMemberCandidates,
  filterAddMemberCandidates,
} from "./channel-status-model";

const SELF = "prs_me";

describe("addMemberCandidates (members popover + Add)", () => {
  it("offers company teammates and own bots, excluding members and self", () => {
    const rows = addMemberCandidates({
      selfUid: SELF,
      companyUid: "cmp_soar",
      members: [{ personUid: "prs_in" }, { personUid: "agt_in" }],
      contacts: [
        { personUid: "prs_in", displayName: "Already In" },
        { personUid: SELF, displayName: "Me" },
        { personUid: "prs_zed", displayName: "Zed Ops", email: "z@x.y" },
        { personUid: "prs_amy", displayName: "Amy Lee", avatarUrl: " https://a/x.png " },
        { personUid: "prs_nameless" },
      ],
      bots: [
        { agentUid: "agt_jimbo", ownerUid: SELF, name: "jimbo", displayName: "Jimbo" },
        { agentUid: "agt_in", ownerUid: SELF, name: "inbot" },
        { agentUid: "agt_theirs", ownerUid: "prs_other", name: "theirs" },
      ],
    });
    expect(rows).toEqual([
      { personUid: "agt_jimbo", displayName: "Jimbo", kind: "bot", handle: "jimbo" },
      { personUid: "prs_amy", displayName: "Amy Lee", kind: "person", avatarUrl: "https://a/x.png" },
      { personUid: "prs_zed", displayName: "Zed Ops", kind: "person" },
    ]);
  });

  it("drops contacts stamped with another company and keeps unstamped ones", () => {
    const rows = addMemberCandidates({
      selfUid: SELF,
      companyUid: "cmp_soar",
      contacts: [
        { personUid: "prs_a", displayName: "A", companyUid: "cmp_other" },
        { personUid: "prs_b", displayName: "B", companyUid: "cmp_soar" },
        { personUid: "prs_c", displayName: "C" },
      ],
    });
    expect(rows.map((r) => r.personUid)).toEqual(["prs_b", "prs_c"]);
  });

  it("offers no bots when self is unknown (owner check fails closed)", () => {
    const rows = addMemberCandidates({
      selfUid: null,
      bots: [{ agentUid: "agt_x", ownerUid: "", name: "x" }],
      contacts: [{ personUid: "prs_a", displayName: "A" }],
    });
    expect(rows.map((r) => r.personUid)).toEqual(["prs_a"]);
  });

  it("treats agt_ contacts as bots and dedupes across sources", () => {
    const rows = addMemberCandidates({
      selfUid: SELF,
      bots: [{ agentUid: "agt_dup", ownerUid: SELF, name: "dup", displayName: "Dup Bot" }],
      contacts: [
        { personUid: "agt_dup", displayName: "Dup From Contacts" },
        { personUid: "agt_company", displayName: "Company Bot" },
        { personUid: "prs_p", displayName: "Person" },
      ],
    });
    expect(rows.map((r) => [r.personUid, r.kind, r.displayName])).toEqual([
      ["agt_company", "bot", "Company Bot"],
      ["agt_dup", "bot", "Dup Bot"],
      ["prs_p", "person", "Person"],
    ]);
  });

  it("falls back to the handle, then the uid, for a bot without a display name", () => {
    const rows = addMemberCandidates({
      selfUid: SELF,
      bots: [
        { agentUid: "agt_h", ownerUid: SELF, name: "handle-only" },
        { agentUid: "agt_u", ownerUid: SELF },
      ],
    });
    expect(rows.map((r) => r.displayName)).toEqual(["agt_u", "handle-only"]);
  });

  it("returns an empty list with no inputs", () => {
    expect(addMemberCandidates({})).toEqual([]);
  });
});

describe("filterAddMemberCandidates", () => {
  const rows = addMemberCandidates({
    selfUid: SELF,
    bots: [{ agentUid: "agt_jimbo", ownerUid: SELF, name: "jimbo", displayName: "Jimbo" }],
    contacts: [{ personUid: "prs_amy", displayName: "Amy Lee" }],
  });
  it("matches name, handle, and uid case-insensitively; blank returns all", () => {
    expect(filterAddMemberCandidates(rows, "").length).toBe(2);
    expect(filterAddMemberCandidates(rows, "JIM").map((r) => r.personUid)).toEqual(["agt_jimbo"]);
    expect(filterAddMemberCandidates(rows, "prs_").map((r) => r.personUid)).toEqual(["prs_amy"]);
    expect(filterAddMemberCandidates(rows, "nobody")).toEqual([]);
  });
});
