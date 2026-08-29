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
  storedMentionType,
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

describe("stored mention type", () => {
  it("infers an agent from the uid when the wire omits participantType", () => {
    expect(
      storedMentionType({ participantUid: "agt_01KTX6WQ6SYH3TZGF3DSDRPGGD" }),
    ).toBe("agent");
    expect(
      storedMentionType({ participantUid: "prs_01KQ2RY9VB1S105X2GZ2EPHKWY" }),
    ).toBe("human");
  });

  it("trusts an explicit wire participantType over the uid prefix", () => {
    expect(
      storedMentionType({
        participantUid: "prs_shared_agent_seat",
        participantType: "agent",
      }),
    ).toBe("agent");
    expect(
      storedMentionType({ participantUid: "agt_x", participantType: "human" }),
    ).toBe("human");
  });

  it("ignores a blank or unknown participantType and falls back to the uid", () => {
    expect(
      storedMentionType({ participantUid: "agt_x", participantType: "  " }),
    ).toBe("agent");
    expect(
      storedMentionType({ participantUid: "agt_x", participantType: null }),
    ).toBe("agent");
    expect(
      storedMentionType({ participantUid: "agt_x", participantType: "bot" }),
    ).toBe("agent");
  });
});

describe("applyMentionMarkup markup safety", () => {
  const deacon = mentionTargetsFromContacts([
    { personUid: "prs_deacon", displayName: "Deacon" },
  ]);

  it("leaves an @name that appears inside a link href or title untouched", () => {
    const html =
      '<p><a href="https://example.test/@Deacon" title="@Deacon">docs</a></p>';
    // Only the tag holds the name, so nothing is decorated and the href
    // survives byte-for-byte — splicing a <span> in would break the link.
    expect(applyMentionMarkup(html, deacon)).toBe(html);
  });

  it("decorates the text run but not the attribute in the same message", () => {
    const out = applyMentionMarkup(
      '<p><a href="/u/@Deacon">profile</a> ping @Deacon</p>',
      deacon,
    );
    expect(out).toContain('href="/u/@Deacon"');
    expect(out.match(/inline-mention/g)).toHaveLength(1);
    expect(out).toContain(
      '<span class="inline-mention" data-person-uid="prs_deacon" data-person-type="human" role="button" tabindex="0">@Deacon</span></p>',
    );
  });

  it("wraps the longest matching name once when one name prefixes another", () => {
    const roster = mentionTargetsFromContacts([
      { personUid: "prs_ada", displayName: "Ada" },
      { personUid: "prs_ada_l", displayName: "Ada Lovelace" },
    ]);
    const out = applyMentionMarkup("<p>hi @Ada Lovelace</p>", roster);
    expect(out.match(/inline-mention/g)).toHaveLength(1);
    expect(out).toContain(
      '<span class="inline-mention" data-person-uid="prs_ada_l" data-person-type="human" role="button" tabindex="0">@Ada Lovelace</span>',
    );
  });

  it("does not re-scan the markup it just inserted", () => {
    const roster = mentionTargetsFromContacts([
      { personUid: "prs_deacon", displayName: "Deacon" },
      { personUid: "prs_d", displayName: "D" },
    ]);
    const out = applyMentionMarkup("<p>@Deacon</p>", roster);
    expect(out.match(/inline-mention/g)).toHaveLength(1);
  });

  it("returns the html unchanged when there are no mentions", () => {
    expect(applyMentionMarkup("<p>hey @Deacon</p>", [])).toBe(
      "<p>hey @Deacon</p>",
    );
  });
});
