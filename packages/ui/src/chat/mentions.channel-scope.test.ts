import { describe, expect, it } from "vitest";
import {
  mentionAllowedUids,
  mentionTargetsFromContacts,
  restrictMentionTargetsToChannel,
} from "./mentions.js";

/**
 * Regression: the desktop picker offered people the server always refuses.
 *
 * A company/project channel rejects the WHOLE message with 403
 * MENTION_PARTICIPANT_NOT_VISIBLE when a mentioned participant is not an
 * active member of that company. The picker merged an app-wide display-name
 * map, so it offered a SECOND "Jacob Posel" entity that is not in the company
 * — visually identical to the one that works — and picking it failed the send.
 */
describe("restrictMentionTargetsToChannel", () => {
  const indigoJacob = {
    participantUid: "prs_indigo_jacob",
    participantType: "human" as const,
    displayName: "Jacob Posel",
    companyUid: "cmp_indigo",
  };
  const foreignJacob = {
    participantUid: "prs_other_jacob",
    participantType: "human" as const,
    displayName: "Jacob Posel",
  };
  const personalBot = {
    participantUid: "agt_personal_bot",
    participantType: "agent" as const,
    displayName: "claude-bot",
  };

  it("drops an identity the channel's company will never accept", () => {
    const allowed = mentionAllowedUids([indigoJacob], [personalBot]);
    const kept = restrictMentionTargetsToChannel([indigoJacob, foreignJacob], {
      channelCompanyUid: "cmp_indigo",
      allowedUids: allowed,
    });
    expect(kept.map((row) => row.participantUid)).toEqual(["prs_indigo_jacob"]);
  });

  it("keeps a personal bot, which has no company membership by design", () => {
    const kept = restrictMentionTargetsToChannel([personalBot], {
      channelCompanyUid: "cmp_indigo",
      allowedUids: mentionAllowedUids([personalBot]),
    });
    expect(kept).toEqual([personalBot]);
  });

  it("keeps a channel member who is not on the contacts roster", () => {
    const sheister = {
      participantUid: "agt_sheister",
      participantType: "agent" as const,
      displayName: "sheister",
    };
    const kept = restrictMentionTargetsToChannel([sheister], {
      channelCompanyUid: "cmp_indigo",
      allowedUids: mentionAllowedUids([sheister]),
    });
    expect(kept).toEqual([sheister]);
  });

  it("drops nothing when the channel has no company (a DM)", () => {
    const kept = restrictMentionTargetsToChannel([foreignJacob], {
      channelCompanyUid: null,
      allowedUids: new Set<string>(),
    });
    expect(kept).toEqual([foreignJacob]);
  });

  it("builds the allowed set from every roster source", () => {
    const uids = mentionAllowedUids(
      mentionTargetsFromContacts([
        { personUid: "prs_indigo_jacob", displayName: "Jacob Posel" },
      ]),
      [personalBot],
      null,
      undefined,
    );
    expect([...uids].sort()).toEqual(["agt_personal_bot", "prs_indigo_jacob"]);
  });
});
