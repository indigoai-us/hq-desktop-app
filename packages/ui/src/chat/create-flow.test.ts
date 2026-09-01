import { describe, expect, it } from "vitest";

import {
  buildFindResults,
  buildPickerCandidates,
  channelScopeKey,
  channelSlug,
  checkSlug,
  classifyFindQuery,
  companyRelation,
  creatableCompanies,
  inviteRequestBody,
  isValidEmail,
  knownSlugsInScope,
  memberFailureReason,
  parseCreateChannelError,
  rosterFromMembers,
  slugInputValue,
  stripRawUids,
  suggestFreeSlug,
  type KnownChannel,
  type SlugTarget,
} from "./create-flow.js";
import {
  collapseDuplicateGroupRows,
  type ConversationRow,
  type DmContactInput,
} from "./sidebar-model.js";

function row(partial: Partial<ConversationRow> = {}): ConversationRow {
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

function dm(partial: Partial<ConversationRow> = {}): ConversationRow {
  return row({
    id: "dm:prs_ada",
    kind: "dm",
    title: "Ada",
    personUid: "prs_ada",
    channelId: undefined,
    companyUid: null,
    ...partial,
  });
}

function contact(partial: Partial<DmContactInput> = {}): DmContactInput {
  return { personUid: "prs_ada", displayName: "Ada", ...partial };
}

function known(partial: Partial<KnownChannel> = {}): KnownChannel {
  return {
    channelId: "chn_one",
    title: "one",
    companyUid: "cmp_indigo",
    projectId: null,
    ...partial,
  };
}

const COMPANY: SlugTarget = { scope: "company", companyUid: "cmp_indigo" };
const PERSONAL: SlugTarget = { scope: "personal", companyUid: null };

// The §4.1 table, reused for the idempotence property.
const SLUG_TABLE: Array<[string, string]> = [
  ["Q4 board", "q4-board"],
  ["", ""],
  ["   ", ""],
  ["###", ""],
  ["🎉", ""],
  ["漢字", ""],
  ["Café Q4!!", "caf-q4"],
  ["naïve", "na-ve"],
  ["Q4  ---  BOARD", "q4-board"],
  ["--lead--", "lead"],
  ["a_b.c", "a-b-c"],
  ["2026", "2026"],
];

describe("channelSlug", () => {
  it.each(SLUG_TABLE)("slugifies %j to %j", (input, expected) => {
    expect(channelSlug(input)).toBe(expected);
  });

  it("does not cap length (the 200-char cap is on `name`, not the slug)", () => {
    const long = "a".repeat(300);
    expect(channelSlug(long)).toHaveLength(300);
  });

  it("is idempotent", () => {
    for (const [input] of SLUG_TABLE) {
      expect(channelSlug(channelSlug(input))).toBe(channelSlug(input));
    }
  });
});

describe("slugInputValue", () => {
  it("keeps a single trailing dash so typing is not fought", () => {
    expect(slugInputValue("Q4 Board!")).toBe("q4-board-");
    expect(slugInputValue("q4--")).toBe("q4-");
    expect(slugInputValue("--q4")).toBe("q4");
    expect(slugInputValue("")).toBe("");
  });

  it("canonicalizes to the same slug as the raw value", () => {
    for (const [input] of SLUG_TABLE) {
      expect(channelSlug(slugInputValue(input))).toBe(channelSlug(input));
    }
  });
});

describe("suggestFreeSlug", () => {
  it("returns the base when it is free", () => {
    expect(suggestFreeSlug("q4-board", new Set())).toBe("q4-board");
  });

  it("suffixes -2, then -3", () => {
    expect(suggestFreeSlug("q4-board", new Set(["q4-board"]))).toBe(
      "q4-board-2",
    );
    expect(
      suggestFreeSlug("q4-board", new Set(["q4-board", "q4-board-2"])),
    ).toBe("q4-board-3");
  });

  it("returns empty for an empty base", () => {
    expect(suggestFreeSlug("", new Set(["a"]))).toBe("");
  });

  it("lands on -99 when everything below it is taken", () => {
    const taken = new Set(["x"]);
    for (let n = 2; n <= 98; n += 1) taken.add(`x-${n}`);
    expect(suggestFreeSlug("x", taken)).toBe("x-99");
  });
});

describe("channelScopeKey", () => {
  it("shapes company and personal keys", () => {
    expect(channelScopeKey(COMPANY, "prs_me")).toBe("company#cmp_indigo");
    expect(channelScopeKey(PERSONAL, "prs_me")).toBe("person#prs_me");
  });

  it("falls back without throwing when self is unknown", () => {
    expect(channelScopeKey(PERSONAL, null)).toBe("person#self");
    expect(channelScopeKey({ scope: "company", companyUid: null }, null)).toBe(
      "company#",
    );
  });
});

describe("checkSlug", () => {
  it("finds a collision inside the same company", () => {
    const verdict = checkSlug(
      "q4-board",
      COMPANY,
      [known({ title: "Q4 Board", channelId: "chn_q4" })],
      new Set(),
    );
    expect(verdict).toEqual({
      status: "taken",
      source: "local",
      channelId: "chn_q4",
      title: "Q4 Board",
      joined: true,
    });
  });

  it("does not collide across companies", () => {
    expect(
      checkSlug(
        "q4-board",
        COMPANY,
        [known({ title: "Q4 Board", companyUid: "cmp_other" })],
        new Set(),
      ),
    ).toEqual({ status: "unknown" });
  });

  it("does not collide a personal channel with a company channel", () => {
    expect(
      checkSlug("q4-board", PERSONAL, [known({ title: "Q4 Board" })], new Set()),
    ).toEqual({ status: "unknown" });
    expect(
      checkSlug(
        "q4-board",
        COMPANY,
        [known({ title: "Q4 Board", companyUid: null })],
        new Set(),
      ),
    ).toEqual({ status: "unknown" });
  });

  it("catches a humanized title via projectId", () => {
    // `humanizeChannelName` strips "Project " + the trailing hash, so the
    // display title no longer slugifies back to the server's slug.
    const provisioned = known({
      title: "Launch Week",
      projectId: "launch-week-7f3a",
      channelId: "chn_lw",
    });
    expect(channelSlug(provisioned.title)).not.toBe("launch-week-7f3a");
    expect(checkSlug("launch-week-7f3a", COMPANY, [provisioned], new Set())).toEqual(
      {
        status: "taken",
        source: "local",
        channelId: "chn_lw",
        title: "Launch Week",
        joined: true,
      },
    );
  });

  it("reports a server-learned collision", () => {
    expect(
      checkSlug(
        "q4-board",
        COMPANY,
        [],
        new Set(["company#cmp_indigo#q4-board"]),
      ),
    ).toEqual({
      status: "taken",
      source: "server",
      channelId: null,
      title: null,
      joined: false,
    });
  });

  it("returns empty for an empty slug", () => {
    expect(checkSlug("", COMPANY, [], new Set())).toEqual({ status: "empty" });
  });

  // Regression: an owner/admin sees browse-only rows for company project
  // channels they are NOT in, and the collision copy claimed "you're already
  // in #x" (with an "Open it" button) for exactly those.
  it("reports a browse-only collision as taken but NOT joined", () => {
    const verdict = checkSlug(
      "q4-board",
      COMPANY,
      [known({ title: "Q4 Board", channelId: "chn_q4", browseOnly: true })],
      new Set(),
    );
    expect(verdict).toEqual({
      status: "taken",
      source: "local",
      channelId: "chn_q4",
      title: "Q4 Board",
      joined: false,
    });
  });

  it("treats a non-joined membership the same way", () => {
    const verdict = checkSlug(
      "q4-board",
      COMPANY,
      [known({ title: "Q4 Board", membership: "invited" })],
      new Set(),
    );
    expect(verdict).toMatchObject({ status: "taken", joined: false });
    expect(
      checkSlug(
        "q4-board",
        COMPANY,
        [known({ title: "Q4 Board", membership: "joined" })],
        new Set(),
      ),
    ).toMatchObject({ status: "taken", joined: true });
  });

  it("never returns a free/available verdict", () => {
    const statuses = [
      checkSlug("", COMPANY, [], new Set()),
      checkSlug("nope", COMPANY, [], new Set()),
      checkSlug("one", COMPANY, [known()], new Set()),
    ].map((verdict) => verdict.status);
    expect(statuses).toEqual(["empty", "unknown", "taken"]);
    expect(statuses).not.toContain("free");
    expect(statuses).not.toContain("available");
  });
});

describe("knownSlugsInScope", () => {
  it("collects title slugs and project ids inside the scope only", () => {
    const slugs = knownSlugsInScope(COMPANY, [
      known({ title: "Q4 Board" }),
      known({ title: "Other", companyUid: "cmp_other" }),
      known({ title: "Launch Week", projectId: "launch-week-7f3a" }),
    ]);
    expect([...slugs].sort()).toEqual([
      "launch-week",
      "launch-week-7f3a",
      "q4-board",
    ]);
  });
});

describe("isValidEmail", () => {
  it("accepts real addresses and rejects names", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail(" corey@getindigo.ai ")).toBe(true);
    expect(isValidEmail("Q4 board")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("classifyFindQuery", () => {
  it("classifies the four shapes", () => {
    expect(classifyFindQuery("")).toEqual({
      kind: "empty",
      slug: "",
      email: null,
    });
    expect(classifyFindQuery("a@b.co")).toEqual({
      kind: "email",
      slug: "",
      email: "a@b.co",
    });
    expect(classifyFindQuery("#Q4 board")).toEqual({
      kind: "text",
      slug: "q4-board",
      email: null,
    });
    expect(classifyFindQuery("###")).toEqual({
      kind: "text",
      slug: "",
      email: null,
    });
  });
});

describe("buildFindResults", () => {
  const rows = [
    row({ id: "ch:lw", title: "launch-week", channelId: "chn_lw" }),
    row({ id: "ch:q4", title: "Q4 Board", channelId: "chn_q4" }),
    dm(),
    dm({
      id: "dm:agt_deacon",
      title: "Deacon",
      personUid: "agt_deacon",
    }),
  ];

  const base = {
    rows,
    canCreate: true,
    target: COMPANY,
    selfPersonUid: null,
  };

  it("hoists an exact match to index 0 and suppresses the create row", () => {
    const out = buildFindResults({ ...base, query: "q4 board" });
    expect(out.rows[0]?.label).toBe("Q4 Board");
    expect(out.rows[0]?.exact).toBe(true);
    expect(out.createSlug).toBeNull();
  });

  it("offers a lowercase create slug for an unknown name", () => {
    expect(buildFindResults({ ...base, query: "Growth Team" }).createSlug).toBe(
      "growth-team",
    );
  });

  it("suppresses the create row for an email query and returns no rows", () => {
    const out = buildFindResults({ ...base, query: "someone@example.com" });
    expect(out.rows).toEqual([]);
    expect(out.createSlug).toBeNull();
  });

  it("suppresses the create row when the host cannot create", () => {
    expect(
      buildFindResults({ ...base, query: "growth", canCreate: false })
        .createSlug,
    ).toBeNull();
  });

  it("splits agents from people by uid prefix", () => {
    const out = buildFindResults({ ...base, query: "a" });
    const ada = out.rows.find((r) => r.label === "Ada");
    const deacon = out.rows.find((r) => r.label === "Deacon");
    expect(ada?.kind).toBe("person");
    expect(deacon?.kind).toBe("agent");
    expect(deacon?.sublabel).toBe("Agent");
  });

  it("does not let a DM title suppress the create row", () => {
    const out = buildFindResults({ ...base, query: "Ada" });
    expect(out.rows[0]?.label).toBe("Ada");
    expect(out.createSlug).toBe("ada");
  });

  it("does not suppress the create row for a same-slug channel in ANOTHER company", () => {
    const out = buildFindResults({
      ...base,
      rows: [row({ id: "ch:q4", title: "Q4 Board", companyUid: "cmp_other" })],
      query: "Q4 board",
    });
    expect(out.createSlug).toBe("q4-board");
  });

  // Regression: opening the modal loads EVERY company's project channels, so
  // two identically named channels rendered as two identical rows with no
  // workspace text at all — picking the wrong one opened the wrong company.
  it("labels channel rows with their workspace", () => {
    const label = (uid: string | null): string =>
      uid === "cmp_indigo" ? "Indigo" : uid === "cmp_other" ? "Holler" : "Personal";
    const out = buildFindResults({
      ...base,
      rows: [
        row({ id: "ch:g1", title: "growth", channelId: "chn_g1" }),
        row({
          id: "ch:g2",
          title: "growth",
          channelId: "chn_g2",
          companyUid: "cmp_other",
        }),
        row({
          id: "ch:g3",
          title: "growth",
          channelId: "chn_g3",
          companyUid: null,
        }),
      ],
      query: "growth",
      companyLabel: label,
    });
    expect(out.rows.map((r) => r.sublabel)).toEqual([
      "Indigo",
      "Holler",
      "Personal",
    ]);
  });

  it("leaves channel sublabels empty when no resolver is supplied", () => {
    const out = buildFindResults({ ...base, query: "launch" });
    expect(out.rows[0]?.sublabel).toBe("");
  });

  it("caps each group at 5", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      row({ id: `ch:${i}`, title: `growth-${i}`, channelId: `chn_${i}` }),
    );
    const out = buildFindResults({ ...base, rows: many, query: "growth" });
    expect(out.rows).toHaveLength(5);
  });

  it("excludes self", () => {
    const out = buildFindResults({
      ...base,
      query: "Ada",
      selfPersonUid: "prs_ada",
    });
    expect(out.rows.map((r) => r.label)).not.toContain("Ada");
  });

  it("returns up to 8 recents and no create row for an empty query", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ id: `ch:${i}`, title: `c-${i}`, channelId: `chn_${i}` }),
    );
    const out = buildFindResults({ ...base, rows: many, query: "  " });
    expect(out.rows).toHaveLength(8);
    expect(out.createSlug).toBeNull();
  });
});

describe("buildPickerCandidates", () => {
  const rows = [dm(), dm({ id: "dm:agt_deacon", title: "Deacon", personUid: "agt_deacon" })];

  it("includes a contact with no conversation at all (the D6 fix)", () => {
    const out = buildPickerCandidates({
      rows,
      contacts: [contact({ personUid: "prs_bryan", displayName: "Bryan" })],
      query: "bry",
      picked: [],
      allowEmail: false,
    });
    expect(out.map((c) => c.label)).toEqual(["Bryan"]);
  });

  it("excludes already-picked and self", () => {
    const out = buildPickerCandidates({
      rows,
      contacts: [],
      query: "",
      picked: ["prs_ada"],
      selfPersonUid: "agt_deacon",
      allowEmail: false,
    });
    expect(out).toEqual([]);
  });

  it("matches on email as well as label", () => {
    const out = buildPickerCandidates({
      rows: [],
      contacts: [
        contact({
          personUid: "prs_bryan",
          displayName: "Bryan",
          email: "bryan@getindigo.ai",
        }),
      ],
      query: "getindigo",
      picked: [],
      allowEmail: false,
    });
    expect(out.map((c) => c.label)).toEqual(["Bryan"]);
  });

  it("tags agents and gives them the Agent sublabel, listed after people", () => {
    const out = buildPickerCandidates({
      rows,
      contacts: [],
      query: "",
      picked: [],
      allowEmail: false,
    });
    expect(out.map((c) => c.type)).toEqual(["person", "agent"]);
    expect(out[1]?.sublabel).toBe("Agent");
  });

  it("labels a nameless agent with the shared fallback", () => {
    const out = buildPickerCandidates({
      rows: [],
      contacts: [contact({ personUid: "agt_scouty01", displayName: null })],
      query: "",
      picked: [],
      allowEmail: false,
    });
    expect(out[0]?.label).toBe("Agent scouty01");
  });

  it("appends an email row only when allowed, valid, and unmatched", () => {
    const args = {
      rows: [],
      contacts: [],
      picked: [] as string[],
      allowEmail: true,
    };
    expect(
      buildPickerCandidates({ ...args, query: "new@example.com" }).map(
        (c) => c.type,
      ),
    ).toEqual(["email"]);
    expect(
      buildPickerCandidates({ ...args, query: "not-an-email" }),
    ).toEqual([]);
    expect(
      buildPickerCandidates({
        ...args,
        allowEmail: false,
        query: "new@example.com",
      }),
    ).toEqual([]);
    // A matching contact wins over the invite row.
    expect(
      buildPickerCandidates({
        ...args,
        contacts: [contact({ email: "new@example.com" })],
        query: "new@example.com",
      }).map((c) => c.type),
    ).toEqual(["person"]);
  });

  it("honors limitPerGroup", () => {
    const contacts = Array.from({ length: 9 }, (_, i) =>
      contact({ personUid: `prs_${i}`, displayName: `Person ${i}` }),
    );
    expect(
      buildPickerCandidates({
        rows: [],
        contacts,
        query: "",
        picked: [],
        allowEmail: false,
        limitPerGroup: 2,
      }),
    ).toHaveLength(2);
  });
});

describe("companyRelation", () => {
  it("returns unknown when we hold no membership for the person", () => {
    expect(companyRelation("prs_ada", "cmp_indigo", [])).toBe("unknown");
    expect(
      companyRelation("prs_ada", "cmp_indigo", [contact({ companyUid: null })]),
    ).toBe("unknown");
  });

  it("returns inside / outside from the known memberships", () => {
    expect(
      companyRelation("prs_ada", "cmp_indigo", [
        contact({ companyUid: "cmp_indigo" }),
      ]),
    ).toBe("inside");
    expect(
      companyRelation("prs_ada", "cmp_indigo", [
        contact({ companyUid: "cmp_other" }),
      ]),
    ).toBe("outside");
  });

  it("is inside when ANY of several rows names the target company", () => {
    expect(
      companyRelation("prs_ada", "cmp_indigo", [
        contact({ companyUid: "cmp_other" }),
        contact({ companyUid: "cmp_indigo" }),
        contact({ personUid: "prs_bryan", companyUid: "cmp_indigo" }),
      ]),
    ).toBe("inside");
  });

  // Regression: D7 was unreachable in production because the only real
  // contacts source (`GET /v1/notify/contacts`) returns no `companyUid` at
  // all, so the heuristic above always answered "unknown" and the
  // confirmation never rendered. The roster is what makes it fire.
  describe("with a company roster (production-shaped contacts)", () => {
    // EXACTLY what the server sends: personUid / email / displayName, no
    // companyUid on any row.
    const WIRE_CONTACTS: DmContactInput[] = [
      { personUid: "prs_ada", displayName: "Ada", email: "ada@indigo.test" },
      { personUid: "prs_kai", displayName: "Kai", email: "kai@acme.test" },
    ];

    it("still answers unknown without a roster — the shape the bug was in", () => {
      expect(companyRelation("prs_kai", "cmp_indigo", WIRE_CONTACTS)).toBe(
        "unknown",
      );
    });

    it("answers inside / outside from the roster", () => {
      const roster = rosterFromMembers("cmp_indigo", [
        { personUid: "prs_ada" },
      ]);
      expect(
        companyRelation("prs_ada", "cmp_indigo", WIRE_CONTACTS, roster),
      ).toBe("inside");
      expect(
        companyRelation("prs_kai", "cmp_indigo", WIRE_CONTACTS, roster),
      ).toBe("outside");
    });

    it("ignores a roster for a different company", () => {
      const roster = rosterFromMembers("cmp_other", [
        { personUid: "prs_ada" },
      ]);
      expect(
        companyRelation("prs_kai", "cmp_indigo", WIRE_CONTACTS, roster),
      ).toBe("unknown");
    });

    it("falls back rather than calling everyone external on an empty roster", () => {
      const roster = rosterFromMembers("cmp_indigo", []);
      expect(
        companyRelation("prs_kai", "cmp_indigo", WIRE_CONTACTS, roster),
      ).toBe("unknown");
    });
  });
});

describe("rosterFromMembers", () => {
  it("keeps trimmed uids and drops blanks", () => {
    const roster = rosterFromMembers("cmp_indigo", [
      { personUid: " prs_ada " },
      { personUid: "" },
      { personUid: null },
      {},
      { personUid: "prs_ada" },
    ]);
    expect(roster.companyUid).toBe("cmp_indigo");
    expect([...roster.personUids]).toEqual(["prs_ada"]);
  });
});

describe("stripRawUids", () => {
  it("removes prs_/cmp_/chn_/agt_ tokens", () => {
    expect(stripRawUids("scope company#cmp_01ABC here")).toBe(
      "scope company# here",
    );
    expect(stripRawUids("plain text")).toBe("plain text");
  });
});

describe("parseCreateChannelError", () => {
  it("maps the 409 sentence without echoing the raw company uid", () => {
    const failure = parseCreateChannelError(
      new Error(
        'channel name "Q4 Board" is already taken in scope company#cmp_01ABC',
      ),
      "Q4 Board",
    );
    expect(failure.code).toBe("slug-taken");
    expect(failure.message).not.toContain("cmp_");
    expect(failure.message).toContain("Q4 Board");
  });

  it("maps the 403 company-membership sentence", () => {
    expect(
      parseCreateChannelError(
        new Error("caller is not an active member of this company"),
      ),
    ).toEqual({
      code: "not-company-member",
      message: "You're not an active member of that workspace.",
    });
  });

  it("maps the 200-character sentence", () => {
    expect(
      parseCreateChannelError(new Error("name exceeds 200 characters")).code,
    ).toBe("name-too-long");
  });

  it("passes through a clean unknown message", () => {
    expect(parseCreateChannelError("network unreachable")).toEqual({
      code: "unknown",
      message: "network unreachable",
    });
  });

  it("falls back when the unknown message carries a raw uid", () => {
    expect(
      parseCreateChannelError(new Error("boom for prs_01ABC")).message,
    ).toBe("Could not create the channel.");
  });

  it("falls back on a non-Error throw and on an empty message", () => {
    expect(parseCreateChannelError({ nope: true }).code).toBe("unknown");
    expect(parseCreateChannelError(new Error("")).message).toBe(
      "Could not create the channel.",
    );
    expect(parseCreateChannelError(null).message).toBe(
      "Could not create the channel.",
    );
  });
});

describe("memberFailureReason", () => {
  it("classifies reachability, ownership, and agent scope", () => {
    expect(
      memberFailureReason(new Error("RECIPIENT_NOT_FOUND"), "prs_ada"),
    ).toBe("unreachable");
    expect(
      memberFailureReason(new Error("INVITEE_NOT_FOUND"), "prs_ada"),
    ).toBe("unreachable");
    expect(
      memberFailureReason(new Error("[403] CHANNEL_NOT_OWNER"), "prs_ada"),
    ).toBe("not-owner");
    expect(
      memberFailureReason(new Error("RECIPIENT_NOT_FOUND"), "agt_deacon"),
    ).toBe("agent-scope");
    expect(memberFailureReason(new Error("kaboom"), "prs_ada")).toBe("other");
  });
});

describe("inviteRequestBody", () => {
  it("always names the channel with a leading #", () => {
    const body = inviteRequestBody({
      slug: "q4-board",
      companyLabel: "Indigo",
      inviterLabel: "Stefan",
    });
    expect(body).toContain("#q4-board");
    expect(body).toContain("(Indigo)");
    expect(body).toContain("Stefan");
  });

  it("omits the workspace clause and the name clause when absent", () => {
    const body = inviteRequestBody({
      slug: "q4-board",
      companyLabel: null,
      inviterLabel: null,
    });
    expect(body).toContain("#q4-board");
    expect(body).not.toContain("(");
    expect(body).not.toContain("—  ");
    expect(body.endsWith("channel.")).toBe(true);
  });
});

describe("creatableCompanies", () => {
  const ws = (over: Record<string, unknown> = {}) => ({
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_indigo",
    membershipStatus: "active",
    ...over,
  });

  it("keeps active company memberships, labelled by display name", () => {
    expect(creatableCompanies([ws()])).toEqual([
      { companyUid: "cmp_indigo", label: "Indigo" },
    ]);
  });

  it("drops a company whose membership is present but not active", () => {
    // The reported bug: "In: Stefan Johnson" was offered, then the server
    // answered "You're not an active member of that workspace."
    const rows = [
      ws(),
      ws({
        slug: "stefan-johnson",
        displayName: "Stefan Johnson",
        cloudUid: "cmp_sj",
        membershipStatus: "revoked",
      }),
    ];
    expect(creatableCompanies(rows).map((c) => c.companyUid)).toEqual([
      "cmp_indigo",
    ]);
  });

  it("drops pending invites — accepting comes first", () => {
    expect(creatableCompanies([ws({ membershipStatus: "pending" })])).toEqual(
      [],
    );
  });

  it("drops broken and cloud-less rows", () => {
    expect(creatableCompanies([ws({ state: "broken" })])).toEqual([]);
    expect(creatableCompanies([ws({ cloudUid: null })])).toEqual([]);
  });

  it("drops the personal workspace (offered separately as Personal)", () => {
    expect(creatableCompanies([ws({ kind: "personal", state: "personal" })]))
      .toEqual([]);
  });

  it("FAILS OPEN when membership is unknown", () => {
    // membershipStatus is cloud-enriched; a transient outage nulls it for
    // companies the user really is in. Hiding those would be worse than the
    // server error we already surface.
    expect(creatableCompanies([ws({ membershipStatus: null })])).toEqual([
      { companyUid: "cmp_indigo", label: "Indigo" },
    ]);
    expect(
      creatableCompanies([ws({ membershipStatus: undefined })]),
    ).toHaveLength(1);
  });

  it("is case/space tolerant on membership status", () => {
    expect(creatableCompanies([ws({ membershipStatus: " Active " })])).toHaveLength(1);
  });

  it("falls back to slug when there is no display name, and dedupes by uid", () => {
    const rows = [ws({ displayName: "  " }), ws()];
    expect(creatableCompanies(rows)).toEqual([
      { companyUid: "cmp_indigo", label: "indigo" },
    ]);
  });
});

// Carried over from the retired compose modal (ChatSidebar.compose.test.ts):
// the synthetic #setup row never becomes a target, and same-named rows carry a
// visible disambiguator.
describe("buildFindResults · setup exclusion and disambiguation", () => {
  const target: SlugTarget = { scope: "company", companyUid: "cmp_indigo" };
  const setup = row({
    id: "ch:setup",
    title: "setup",
    channelId: "setup",
    companyUid: null,
    pinned: true,
  });

  it("never lists the synthetic #setup channel, even for an empty query", () => {
    const rows = [setup, row()];
    const empty = buildFindResults({ rows, query: "", canCreate: true, target });
    expect(empty.rows.map((r) => r.row.channelId)).toEqual(["chn_one"]);

    const typed = buildFindResults({
      rows,
      query: "set",
      canCreate: true,
      target,
    });
    expect(typed.rows).toHaveLength(0);
  });

  it("does not let the synthetic #setup row reserve the slug", () => {
    // It is injected client-side and is not a channel the server knows about,
    // so a real #setup can still be created — collision comes from the server.
    const result = buildFindResults({
      rows: [setup],
      query: "setup",
      canCreate: true,
      target,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.createSlug).toBe("setup");
  });

  it("still blocks the slug when a REAL channel named setup exists in scope", () => {
    const real = row({ id: "ch:chn_setup", title: "setup", channelId: "chn_setup" });
    const result = buildFindResults({
      rows: [setup, real],
      query: "setup",
      canCreate: true,
      target,
    });
    expect(result.rows.map((r) => r.row.channelId)).toEqual(["chn_setup"]);
    expect(result.createSlug).toBeNull();
  });

  it("disambiguates same-named people by email and channels by workspace", () => {
    const rows = [
      dm({ id: "dm:prs_jacob1", title: "Jacob Posel", personUid: "prs_jacob1", email: "jacob@indigo.ai" }),
      dm({ id: "dm:prs_jacob2", title: "Jacob Posel", personUid: "prs_jacob2", email: "jacob@sender.agency" }),
      dm({ id: "dm:agt_jacob", title: "Jacob Posel", personUid: "agt_jacob", email: null }),
      row({ id: "ch:chn_a", title: "jacob", channelId: "chn_a", companyUid: "cmp_indigo" }),
      row({ id: "ch:chn_b", title: "jacob", channelId: "chn_b", companyUid: "cmp_sender" }),
    ];
    const result = buildFindResults({
      rows,
      query: "jacob",
      canCreate: true,
      target,
      companyLabel: (uid) => (uid === "cmp_indigo" ? "Indigo" : "Sender Agency"),
    });
    const byKey = new Map(result.rows.map((r) => [r.key, r]));
    expect(byKey.get("dm:prs_jacob1")?.sublabel).toBe("jacob@indigo.ai");
    expect(byKey.get("dm:prs_jacob2")?.sublabel).toBe("jacob@sender.agency");
    expect(byKey.get("dm:agt_jacob")?.kind).toBe("agent");
    expect(byKey.get("dm:agt_jacob")?.sublabel).toBe("Agent");
    expect(byKey.get("ch:chn_a")?.sublabel).toBe("Indigo");
    expect(byKey.get("ch:chn_b")?.sublabel).toBe("Sender Agency");
  });

  it("labels group rows with their roster, never echoing the title", () => {
    const members = [
      { personUid: "prs_a", displayName: "Ada" },
      { personUid: "prs_b", displayName: "Bob" },
      { personUid: "prs_c", displayName: "Cy" },
      { personUid: "prs_d", displayName: "Di" },
    ];
    const named = row({
      id: "ch:chn_g1",
      kind: "group",
      title: "Launch crew",
      channelId: "chn_g1",
      members,
      memberCount: 4,
    });
    // Unnamed groups are titled by the roster join; the sublabel falls back
    // to the workspace instead of stuttering the same text twice.
    const unnamed = row({
      id: "ch:chn_g2",
      kind: "group",
      title: "Ada, Bob",
      channelId: "chn_g2",
      members: members.slice(0, 2),
      memberCount: 2,
    });
    const countOnly = row({
      id: "ch:chn_g3",
      kind: "group",
      title: "Group chat",
      channelId: "chn_g3",
      members: [],
      memberCount: 6,
    });
    const result = buildFindResults({
      rows: [named, unnamed, countOnly],
      query: "",
      canCreate: true,
      target,
      companyLabel: () => "Indigo",
    });
    const byKey = new Map(result.rows.map((r) => [r.key, r]));
    expect(byKey.get("ch:chn_g1")?.sublabel).toBe("Ada, Bob, Cy +1");
    expect(byKey.get("ch:chn_g2")?.sublabel).toBe("Indigo");
    expect(byKey.get("ch:chn_g3")?.sublabel).toBe("Group · 6");
  });

  it("shows one row for duplicate group channels with the same roster", () => {
    // The duplicates originate server-side (distinct channelIds, same people).
    // The sidebar collapses them before they reach the find list, so the modal
    // never offers three identical "Jacob Posel" rows.
    const jacob = [{ personUid: "prs_jacob", displayName: "Jacob Posel" }];
    const dupes = [
      row({ id: "ch:chn_g1", kind: "group", title: "Jacob Posel", channelId: "chn_g1", members: jacob, lastActivityAt: 1 }),
      row({ id: "ch:chn_g2", kind: "group", title: "Jacob Posel", channelId: "chn_g2", members: jacob, lastActivityAt: 3 }),
      row({ id: "ch:chn_g3", kind: "group", title: "Jacob Posel", channelId: "chn_g3", members: jacob, lastActivityAt: 2 }),
    ];
    const result = buildFindResults({
      rows: collapseDuplicateGroupRows(dupes),
      query: "jacob",
      canCreate: true,
      target,
    });
    expect(result.rows.map((r) => r.row.channelId)).toEqual(["chn_g2"]);
  });
});
