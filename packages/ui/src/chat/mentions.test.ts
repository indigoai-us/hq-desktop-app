import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionMarkup,
  collapseDuplicateMentionTargets,
  filterMentionCandidates,
  mentionSpansForBody,
  mentionTargetLabel,
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

  // Regression: keying the dedupe map on display name silently dropped one of
  // two same-named identities, and the survivor was decided by Map insertion
  // order. That made a cross-tenant mention (a foreign company's agent) look
  // identical to the intended one. participantUid is the only identity.
  it("keeps two DIFFERENT agents that share a display name and have no email", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "agt_liverecover_izzy",
        participantType: "agent",
        displayName: "Izzy",
        companyUid: "cmp_liverecover",
        companyName: "LiveRecover",
      },
      {
        participantUid: "agt_indigo_izzy",
        participantType: "agent",
        displayName: "Izzy",
        companyUid: "cmp_indigo",
        companyName: "Indigo",
      },
    ]);
    expect(rows.map((row) => row.participantUid).sort()).toEqual([
      "agt_indigo_izzy",
      "agt_liverecover_izzy",
    ]);
  });

  it("renders a company disambiguator when two survivors share a name", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "agt_liverecover_izzy",
        participantType: "agent",
        displayName: "Izzy",
        companyUid: "cmp_liverecover",
        companyName: "LiveRecover",
      },
      {
        participantUid: "agt_indigo_izzy",
        participantType: "agent",
        displayName: "Izzy",
        companyUid: "cmp_indigo",
        companyName: "Indigo",
      },
    ]);
    expect(rows.map(mentionTargetLabel)).toEqual([
      "Izzy (Indigo)",
      "Izzy (LiveRecover)",
    ]);
  });

  it("falls back to a uid suffix rather than dropping a nameless-company dupe", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "agt_aaaaaaaaaaaa111111",
        participantType: "agent",
        displayName: "Izzy",
      },
      {
        participantUid: "agt_bbbbbbbbbbbb222222",
        participantType: "agent",
        displayName: "Izzy",
      },
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.disambiguator).toBeTruthy();
    }
    // Distinct suffixes — the two rows are actually tellable apart.
    expect(rows[0]?.disambiguator).not.toBe(rows[1]?.disambiguator);
  });

  it("leaves a unique display name undecorated", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "agt_izzy",
        participantType: "agent",
        displayName: "Izzy",
        companyName: "LiveRecover",
      },
      {
        participantUid: "prs_corey",
        participantType: "human",
        displayName: "Corey Epstein",
      },
    ]);
    expect(rows.every((row) => row.disambiguator === undefined)).toBe(true);
    expect(rows.map(mentionTargetLabel)).toEqual(["Corey Epstein", "Izzy"]);
  });

  it("merges rows that share one participantUid into a single row", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "prs_scouty",
        participantType: "human",
        displayName: "Scouty",
      },
      {
        participantUid: "prs_scouty",
        participantType: "human",
        displayName: "Scouty",
        email: "scouty@getindigo.ai",
      },
    ]);
    expect(rows).toHaveLength(1);
    // The richer row's email survives the merge.
    expect(rows[0]?.email).toBe("scouty@getindigo.ai");
    expect(rows[0]?.disambiguator).toBeUndefined();
  });

  it("prefers the human entry over an agent alias on a true uid duplicate", () => {
    const rows = collapseDuplicateMentionTargets([
      {
        participantUid: "prs_shared_seat",
        participantType: "agent",
        displayName: "Scouty",
      },
      {
        participantUid: "prs_shared_seat",
        participantType: "human",
        displayName: "Scouty",
        email: "scouty@getindigo.ai",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.participantType).toBe("human");
    expect(rows[0]?.email).toBe("scouty@getindigo.ai");
  });

  it("is deterministic regardless of input order", () => {
    const a = {
      participantUid: "agt_indigo_izzy",
      participantType: "agent" as const,
      displayName: "Izzy",
      companyName: "Indigo",
    };
    const b = {
      participantUid: "agt_liverecover_izzy",
      participantType: "agent" as const,
      displayName: "Izzy",
      companyName: "LiveRecover",
    };
    expect(collapseDuplicateMentionTargets([a, b])).toEqual(
      collapseDuplicateMentionTargets([b, a]),
    );
  });

  it("carries companyUid/companyName from the contacts payload", () => {
    const rows = mentionTargetsFromContacts([
      {
        personUid: "agt_lr_izzy",
        displayName: "Izzy",
        companyUid: "cmp_liverecover",
        companyName: "LiveRecover",
      },
      {
        personUid: "agt_in_izzy",
        displayName: "Izzy",
        companyUid: "cmp_indigo",
        companyName: "Indigo",
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.companyUid).sort()).toEqual([
      "cmp_indigo",
      "cmp_liverecover",
    ]);
    expect(rows.map(mentionTargetLabel)).toEqual([
      "Izzy (Indigo)",
      "Izzy (LiveRecover)",
    ]);
  });

  it("filters same-named candidates by their company", () => {
    const roster = mentionTargetsFromContacts([
      {
        personUid: "agt_lr_izzy",
        displayName: "Izzy",
        companyUid: "cmp_liverecover",
        companyName: "LiveRecover",
      },
      {
        personUid: "agt_in_izzy",
        displayName: "Izzy",
        companyUid: "cmp_indigo",
        companyName: "Indigo",
      },
    ]);
    expect(
      filterMentionCandidates(roster, "liverecover", []).map(
        (row) => row.participantUid,
      ),
    ).toEqual(["agt_lr_izzy"]);
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
