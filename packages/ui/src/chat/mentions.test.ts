import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionMarkup,
  collapseDuplicateMentionTargets,
  filterMentionCandidates,
  mentionSpansForBody,
  mentionTargetsFromContacts,
  mentionTargetsFromContactsPayload,
  mentionTypeForUid,
  replaceActiveMention,
} from "./mentions.js";

describe("channel mentions", () => {
  it("tags agt_* as agents and prs_* as humans", () => {
    expect(mentionTypeForUid("agt_01KTX6WQ6SYH3TZGF3DSDRPGGD")).toBe("agent");
    expect(mentionTypeForUid("prs_01KQ2RY9VB1S105X2GZ2EPHKWY")).toBe("human");
  });

  it("keeps two people who share a name but have different emails", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "prs_vyg",
        participantType: "human",
        displayName: "Yousuf Kalim",
        email: "yousuf@vyg.ai",
      },
      {
        participantUid: "prs_indigo",
        participantType: "human",
        displayName: "Yousuf Kalim",
        email: "yousuf@getindigo.ai",
      },
    ]);
    expect(rows.map((row) => row.email).sort()).toEqual([
      "yousuf@getindigo.ai",
      "yousuf@vyg.ai",
    ]);
  });

  it("collapses nameless-email duplicates like Scouty", () => {
    const rows = mentionTargetsFromContacts([
      { personUid: "agt_scouty", displayName: "Scouty" },
      { personUid: "prs_scouty", displayName: "Scouty" },
      { personUid: "prs_scouty_2", displayName: "Scouty" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.participantUid).toBe("prs_scouty");
  });

  it("keeps nameless agents with a fallback label instead of dropping them", () => {
    const rows = mentionTargetsFromContacts([
      { personUid: "agt_01KTX6WQ6SYH3TZGF3DSDRPGGD", displayName: "" },
      { participantUid: "agent:scouty", name: null },
      { personUid: "prs_nameless" },
    ]);
    expect(rows.map((row) => row.participantUid).sort()).toEqual([
      "agent:scouty",
      "agt_01KTX6WQ6SYH3TZGF3DSDRPGGD",
    ]);
    for (const row of rows) {
      expect(row.participantType).toBe("agent");
      expect(row.displayName.startsWith("Agent ")).toBe(true);
    }
  });

  it("builds picker candidates from the contacts roster", () => {
    const rows = mentionTargetsFromContacts([
      { personUid: "agt_deacon", displayName: "Deacon" },
      {
        personUid: "prs_stefan",
        displayName: "Stefan Johnson",
        email: "stefan@getindigo.ai",
      },
    ]);
    expect(rows.map((row) => [row.displayName, row.participantType])).toEqual([
      ["Deacon", "agent"],
      ["Stefan Johnson", "human"],
    ]);
  });

  it("unwraps the notify contacts envelope", () => {
    const rows = mentionTargetsFromContactsPayload({
      contacts: [
        { personUid: "agt_deacon", displayName: "Deacon" },
        { participantUid: "prs_corey", name: "Corey Epstein" },
      ],
    });
    expect(rows.map((row) => row.displayName)).toEqual([
      "Corey Epstein",
      "Deacon",
    ]);
  });

  it("completes @query to the selected display name", () => {
    expect(activeMentionQuery("hey @dea")).toBe("dea");
    expect(replaceActiveMention("hey @dea", "@Deacon")).toBe("hey @Deacon ");
    expect(
      filterMentionCandidates(
        mentionTargetsFromContacts([
          { personUid: "agt_deacon", displayName: "Deacon" },
          { personUid: "agt_grok", displayName: "Grok" },
        ]),
        "dea",
        [],
      ).map((row) => row.displayName),
    ).toEqual(["Deacon"]);
  });

  it("marks @DisplayName spans for composer and bubble formatting", () => {
    const mentions = mentionTargetsFromContacts([
      { personUid: "agt_deacon", displayName: "Deacon" },
    ]);
    expect(mentionSpansForBody("hey @Deacon can you look", mentions)).toEqual([
      { start: 4, end: 11 },
    ]);
    expect(
      applyMentionMarkup("<p>hey @Deacon can you look</p>", mentions),
    ).toBe(
      '<p>hey <span class="inline-mention">@Deacon</span> can you look</p>',
    );
  });

  it("formats @DisplayName from the contacts roster when the message has no mentions[]", () => {
    const roster = mentionTargetsFromContacts([
      { personUid: "agt_deacon", displayName: "Deacon" },
      { personUid: "prs_hassaan", displayName: "Hassaan" },
    ]);
    // Human mentions carry a person uid so the shell can open their profile.
    expect(applyMentionMarkup("<p>ping @Hassaan</p>", roster)).toBe(
      '<p>ping <span class="inline-mention" data-person-uid="prs_hassaan" data-person-type="human" role="button" tabindex="0">@Hassaan</span></p>',
    );
  });

  it("does not add a person uid to agent mentions (no profile panel)", () => {
    const roster = mentionTargetsFromContacts([
      { personUid: "agt_deacon", displayName: "Deacon" },
    ]);
    expect(applyMentionMarkup("<p>ping @Deacon</p>", roster)).toBe(
      '<p>ping <span class="inline-mention">@Deacon</span></p>',
    );
  });
});
