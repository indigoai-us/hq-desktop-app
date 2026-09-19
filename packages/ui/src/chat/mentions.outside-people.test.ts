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
  applyResolvedMentionEmails,
  disambiguateMentionTargets,
  filterMentionCandidates,
  mentionRowPill,
  mentionRowSubtitle,
  mentionTargetLabel,
  mentionTargetsFromContacts,
  mentionUidTag,
  mentionUidsNeedingEmail,
  mergeMentionRosters,
  outsideCompanyLabel,
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
  const outside = { outsideLabel: outsideCompanyLabel("Indigo") };

  it("never renders two identical rows for different uids", () => {
    const roster = disambiguateMentionTargets(
      mergeMentionRosters([indigoJacob], outsideJacobRows),
      outside,
    );
    const labels = roster.map((row) => mentionTargetLabel(row));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toHaveLength(2);
  });

  it("labels the known row by its company and the bare row 'outside Indigo'", () => {
    const roster = disambiguateMentionTargets(
      mergeMentionRosters([indigoJacob], outsideJacobRows),
      outside,
    );
    const known = roster.find((row) => row.participantUid === INDIGO_JACOB);
    const other = roster.find((row) => row.participantUid === OUTSIDE_JACOB);
    expect(known?.disambiguator).toBe("Indigo");
    expect(other?.disambiguator).toBe("outside Indigo");
    expect(mentionTargetLabel(other!)).toBe("Jacob Posel (outside Indigo)");
    expect(mentionRowPill(other!)).toBe("outside Indigo");
  });

  it("never shows a person a uid fragment, even with no label to fall back on", () => {
    const roster = disambiguateMentionTargets(
      mergeMentionRosters([indigoJacob], outsideJacobRows),
      // No active company resolved → still no uid tail for a human.
      { outsideLabel: outsideCompanyLabel(null) },
    );
    const other = roster.find((row) => row.participantUid === OUTSIDE_JACOB);
    expect(other?.disambiguator).toBeUndefined();
    expect(mentionTargetLabel(other!)).toBe("Jacob Posel");
    expect(mentionTargetLabel(other!)).not.toContain(
      mentionUidTag(OUTSIDE_JACOB),
    );
  });

  it("keeps the uid tag for two same-named AGENTS, which have no email", () => {
    const agents = disambiguateMentionTargets(
      [
        {
          participantUid: "agt_01AAAAAAAAAAAAAAAAAAAAAAAA",
          participantType: "agent",
          displayName: "Izzy",
        },
        {
          participantUid: "agt_01BBBBBBBBBBBBBBBBBBBBBBBB",
          participantType: "agent",
          displayName: "Izzy",
        },
      ],
      outside,
    );
    expect(agents.map((row) => row.disambiguator)).toEqual([
      mentionUidTag("agt_01AAAAAAAAAAAAAAAAAAAAAAAA"),
      mentionUidTag("agt_01BBBBBBBBBBBBBBBBBBBBBBBB"),
    ]);
    // "outside Indigo" is a human placeholder waiting on an email lookup.
    // An agent's lookup would never resolve, so it does not get that label.
    for (const row of agents)
      expect(row.disambiguator).not.toBe("outside Indigo");
  });

  it("prefers an email over the outside label when the row has one", () => {
    const roster = disambiguateMentionTargets(
      [
        {
          participantUid: OUTSIDE_JACOB,
          participantType: "human",
          displayName: "Jacob Posel",
          email: "jacob@getenabled.ai",
        },
        indigoJacob,
      ],
      outside,
    );
    const other = roster.find((row) => row.participantUid === OUTSIDE_JACOB);
    expect(other?.disambiguator).toBe("jacob@getenabled.ai");
    // The email is already the row's subtitle — it is not duplicated as a pill.
    expect(mentionRowSubtitle(other!)).toBe("jacob@getenabled.ai");
    expect(mentionRowPill(other!)).toBeNull();
  });

  it("adds no label at all when the name does not collide", () => {
    const [only] = disambiguateMentionTargets(outsideJacobRows, outside);
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

describe("resolving an outside person's email, then relabelling", () => {
  const outside = { outsideLabel: outsideCompanyLabel("Indigo") };

  /** The shell's flow: merge → ask about the uids that need an email →
   *  fold the answer in → disambiguate again. */
  function label(emailByUid: Record<string, string>): {
    asked: string[];
    other: MentionTarget | undefined;
  } {
    const merged = mergeMentionRosters([indigoJacob], outsideJacobRows);
    const asked = mentionUidsNeedingEmail(merged);
    const roster = disambiguateMentionTargets(
      applyResolvedMentionEmails(merged, emailByUid),
      outside,
    );
    return {
      asked,
      other: roster.find((row) => row.participantUid === OUTSIDE_JACOB),
    };
  }

  it("asks only about colliding humans with no company and no email", () => {
    const { asked } = label({});
    expect(asked).toEqual([OUTSIDE_JACOB]);
  });

  it("asks about nothing when the name does not collide", () => {
    expect(mentionUidsNeedingEmail(outsideJacobRows)).toEqual([]);
  });

  it("never asks about an agent — an agent has no email to resolve", () => {
    const agents = disambiguateMentionTargets([
      {
        participantUid: "agt_01AAAAAAAAAAAAAAAAAAAAAAAA",
        participantType: "agent",
        displayName: "Izzy",
      },
      {
        participantUid: "agt_01BBBBBBBBBBBBBBBBBBBBBBBB",
        participantType: "agent",
        displayName: "Izzy",
      },
    ]);
    expect(mentionUidsNeedingEmail(agents)).toEqual([]);
  });

  it("reads 'outside Indigo' until the lookup answers", () => {
    const { other } = label({});
    expect(other?.disambiguator).toBe("outside Indigo");
  });

  it("relabels with the email once the lookup answers", () => {
    const { other } = label({ [OUTSIDE_JACOB]: "jacob@getenabled.ai" });
    expect(other?.email).toBe("jacob@getenabled.ai");
    expect(other?.disambiguator).toBe("jacob@getenabled.ai");
    expect(mentionTargetLabel(other!)).toBe(
      "Jacob Posel (jacob@getenabled.ai)",
    );
  });

  it("keeps 'outside Indigo' when the lookup fails or finds nothing", () => {
    const { other } = label({});
    expect(other?.disambiguator).toBe("outside Indigo");
    expect(mentionTargetLabel(other!)).not.toContain("prs_");
    expect(mentionTargetLabel(other!)).not.toContain(
      mentionUidTag(OUTSIDE_JACOB),
    );
  });

  it("never overwrites an email the row already carried", () => {
    const withEmail: MentionTarget = {
      participantUid: OUTSIDE_JACOB,
      participantType: "human",
      displayName: "Jacob Posel",
      email: "real@getenabled.ai",
    };
    const [row] = applyResolvedMentionEmails([withEmail], {
      [OUTSIDE_JACOB]: "stale@example.com",
    });
    expect(row?.email).toBe("real@getenabled.ai");
  });
});
