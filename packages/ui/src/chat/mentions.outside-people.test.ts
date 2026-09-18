/**
 * Mentioning people from outside the open channel's company.
 *
 * The server used to refuse the whole message when a mention named somebody
 * who was not an active member of the channel's company, so the picker hid
 * those rows. It now adds such a person to that one channel as a guest and
 * delivers the mention, so the picker offers them again.
 *
 * The reason the rows were hidden — two identical, unpickable "Jacob Posel"
 * entries, one of them a different person — still has to be solved, and is
 * solved by labelling instead of hiding.
 */

import { describe, expect, it } from "vitest";
import {
  disambiguateMentionTargets,
  filterMentionCandidates,
  mentionTargetLabel,
  mentionTargetsFromContacts,
  mentionUidTag,
  mergeMentionRosters,
  type MentionTarget,
} from "./mentions.js";

const INDIGO_JACOB = "prs_01KQ7NTBRY8X2QAA4S8AAF26W6";
const OUTSIDE_JACOB = "prs_01KQ2ZJV5X8CF37JP3VWDWS1NJ";

/** The tenant roster row: has an email and a company. */
const indigoJacob: MentionTarget = {
  participantUid: INDIGO_JACOB,
  participantType: "human",
  displayName: "Jacob Posel",
  email: "jacob@getindigo.ai",
  companyUid: "cmp_indigo",
  companyName: "Indigo",
};

/** The display-name map row: a name and nothing else. */
const outsideJacobRows = mentionTargetsFromContacts([
  { personUid: OUTSIDE_JACOB, displayName: "Jacob Posel" },
]);

describe("people outside the channel's company are offered again", () => {
  it("keeps a display-name-map row that no tenant roster contains", () => {
    const roster = mergeMentionRosters([indigoJacob], outsideJacobRows);
    expect(roster.map((row) => row.participantUid).sort()).toEqual(
      [INDIGO_JACOB, OUTSIDE_JACOB].sort(),
    );
  });

  it("offers that row in the picker for a typed query", () => {
    const roster = mergeMentionRosters([indigoJacob], outsideJacobRows);
    const shown = filterMentionCandidates(roster, "jacob", []);
    expect(shown.map((row) => row.participantUid).sort()).toEqual(
      [INDIGO_JACOB, OUTSIDE_JACOB].sort(),
    );
  });
});

describe("two people who share a display name are told apart", () => {
  it("never renders two identical rows for different uids", () => {
    const roster = mergeMentionRosters([indigoJacob], outsideJacobRows);
    const labels = roster.map((row) => mentionTargetLabel(row));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toHaveLength(2);
  });

  it("labels the known row by its company and the bare row by a uid tag", () => {
    const roster = mergeMentionRosters([indigoJacob], outsideJacobRows);
    const known = roster.find((row) => row.participantUid === INDIGO_JACOB);
    const outside = roster.find((row) => row.participantUid === OUTSIDE_JACOB);
    expect(known?.disambiguator).toBe("Indigo");
    expect(outside?.disambiguator).toBe(mentionUidTag(OUTSIDE_JACOB));
    expect(mentionTargetLabel(outside!)).toBe(
      `Jacob Posel (${mentionUidTag(OUTSIDE_JACOB)})`,
    );
  });

  it("prefers an email over a uid tag when the row has one", () => {
    const [withEmail, bare] = disambiguateMentionTargets([
      {
        participantUid: OUTSIDE_JACOB,
        participantType: "human",
        displayName: "Jacob Posel",
        email: "jacob@getenabled.ai",
      },
      indigoJacob,
    ]).sort((a, b) => a.participantUid.localeCompare(b.participantUid));
    expect([withEmail?.disambiguator, bare?.disambiguator]).toContain(
      "jacob@getenabled.ai",
    );
  });

  it("adds no label at all when the name does not collide", () => {
    const [only] = disambiguateMentionTargets(outsideJacobRows);
    expect(only?.disambiguator).toBeUndefined();
    expect(mentionTargetLabel(only!)).toBe("Jacob Posel");
  });

  it("the uid tag is a short tail, never the raw uid and never a name", () => {
    const tag = mentionUidTag(OUTSIDE_JACOB);
    expect(tag).toBe("id …DWS1NJ");
    expect(tag).not.toContain("prs_");
    expect(OUTSIDE_JACOB).toContain(tag.slice(-6));
  });
});
