import { describe, expect, it } from "vitest";
import { atlasPeopleFromTelemetry } from "./atlas-people.js";

// The body hq-pro `GET /v1/telemetry/company` sends today: `members[]` with the
// totals on the row, token counts as one object, and names in `identities`.
// The Atlas People list failed with "Activity could not be read" on this shape.
const PRODUCTION_BODY = {
  companyUid: "cmp_x",
  members: [
    {
      personUid: "prs_amy",
      skills: { "/deploy": 3, "indigo:standup-brief": 1 },
      tokens: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 1 },
      tokensByModel: { "claude-opus-5": { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 1 } },
      outcomes: { byType: { storyCompleted: 2 }, total: 2 },
      distinctSessions: 4,
      trend: [0, 2, 5],
    },
    {
      personUid: "agt_scout",
      skills: {},
      tokens: { inputTokens: 900, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      tokensByModel: {},
      outcomes: { byType: {}, total: 0 },
      distinctSessions: 1,
      trend: [{ date: "2026-10-01", events: 7 }],
    },
    { personUid: "prs_idle", skills: {}, tokens: {}, tokensByModel: {}, distinctSessions: 0, trend: [] },
  ],
  identities: {
    persons: { prs_amy: { uid: "prs_amy", type: "person", name: "Amy Chen", slug: "amy" } },
    agents: { agt_scout: { uid: "agt_scout", type: "agent", name: "scout", slug: "scout" } },
  },
};

describe("atlasPeopleFromTelemetry", () => {
  it("reads the members shape, with names from identities", () => {
    const people = atlasPeopleFromTelemetry(PRODUCTION_BODY);
    expect(people.map((p) => p.name)).toEqual(["scout", "Amy Chen"]);
    const amy = people.find((p) => p.id === "prs_amy")!;
    expect(amy).toMatchObject({ bot: false, tokens: 126, sessions: 4, stories: 2, topSkill: "/deploy", trend: [0, 2, 5] });
    expect(amy.skills).toEqual(["/deploy", "indigo:standup-brief"]);
    expect(people[0]).toMatchObject({ id: "agt_scout", bot: true, tokens: 900, trend: [7] });
  });

  it("still reads the perMember rollup shape", () => {
    const people = atlasPeopleFromTelemetry({
      perMember: [
        {
          personUid: "prs_amy",
          label: "Amy Chen",
          totals: {
            distinctSessions: 2,
            tokensByModel: [{ model: "m", input: 10, output: 5, cacheCreation: 0, cacheRead: 0 }],
            skills: { total: 1, bySkill: [{ skill: "/deploy", count: 1 }] },
          },
          trend: [1, 2],
        },
      ],
    });
    expect(people).toEqual([
      { id: "prs_amy", name: "Amy Chen", bot: false, tokens: 15, sessions: 2, stories: 0, topSkill: "/deploy", trend: [1, 2], skills: ["/deploy"] },
    ]);
  });

  it("throws on a body with neither list", () => {
    expect(() => atlasPeopleFromTelemetry({ team: {} })).toThrow(/missing/);
  });
});

describe("atlasNamesFromTelemetry", () => {
  it("names every member and agent in identities, and never returns an id as a name", async () => {
    const { atlasNamesFromTelemetry } = await import("./atlas-people.js");
    const names = atlasNamesFromTelemetry({
      identities: {
        persons: { prs_amy: { name: "Amy Chen" }, prs_raw: { name: "prs_raw" } },
        agents: { agt_scout: { name: "scout" } },
      },
    });
    expect([...names]).toEqual([["prs_amy", "Amy Chen"], ["agt_scout", "scout"]]);
  });
});
