import { describe, expect, it } from "vitest";
import {
  defaultTelemetryRange,
  displayNameFromMember,
  isoDay,
  memberKindFromUid,
  memberKindLabel,
  memberTypeRoleLabel,
  normalizeCompanyTeamTelemetry,
  teamTelemetryErrorMessage,
} from "./team-telemetry";

describe("memberKindFromUid", () => {
  it("classifies agt_* as agent and prs_* as human", () => {
    expect(memberKindFromUid("agt_01ABC")).toBe("agent");
    expect(memberKindFromUid("prs_01XYZ")).toBe("human");
    expect(memberKindFromUid("")).toBe("human");
  });
});

describe("memberKindLabel / memberTypeRoleLabel", () => {
  it("labels kinds honestly without inventing presence", () => {
    expect(memberKindLabel("agent")).toBe("Agent");
    expect(memberKindLabel("human")).toBe("Human");
  });

  it("prefers payload role when present, else kind label", () => {
    expect(memberTypeRoleLabel({ kind: "human", role: "owner" })).toBe("owner");
    expect(memberTypeRoleLabel({ kind: "agent" })).toBe("Agent");
    expect(memberTypeRoleLabel({ kind: "human", role: "  " })).toBe("Human");
  });
});

describe("normalizeCompanyTeamTelemetry presence honesty", () => {
  it("never sets online/presence/isOnline from timestamps or events", () => {
    const view = normalizeCompanyTeamTelemetry({
      members: [
        {
          personUid: "prs_ada",
          displayName: "Ada",
          lastActivityAt: "2026-09-04T12:00:00.000Z",
          events: 42,
          distinctSessions: 3,
          isOnline: true,
          online: true,
          presence: "online",
          lastSeen: "2026-09-04T11:59:00.000Z",
        },
      ],
    });
    const member = view.members[0];
    expect(member).toBeDefined();
    expect(member).not.toHaveProperty("online");
    expect(member).not.toHaveProperty("presence");
    expect(member).not.toHaveProperty("isOnline");
    expect(member).not.toHaveProperty("lastSeen");
    expect(member).not.toHaveProperty("lastActivityAt");
    expect(JSON.stringify(member).toLowerCase()).not.toContain('"online"');
    expect(member?.displayName).toBe("Ada");
    expect(member?.displayName.toLowerCase()).not.toBe("online");
    expect(member?.events).toBe(42);
    expect(member?.sessions).toBe(3);
  });
});

describe("displayNameFromMember", () => {
  it("prefers genuine identity fields, then the source UID, then an explicit unavailable state", () => {
    expect(
      displayNameFromMember({
        displayName: "Ada",
        email: "a@x.com",
        personUid: "prs_1",
      }),
    ).toBe("Ada");
    expect(
      displayNameFromMember({ email: "a@x.com", personUid: "prs_1" }),
    ).toBe("a@x.com");
    expect(displayNameFromMember({ personUid: "prs_1" })).toBe("prs_1");
    expect(displayNameFromMember({})).toBe("Identity unavailable");
    expect(
      displayNameFromMember(
        { personUid: "prs_1" },
        { email: "resolved@example.com", displayName: null },
      ),
    ).toBe("resolved@example.com");
    expect(
      displayNameFromMember(
        { personUid: "prs_1" },
        { name: "Server Identity", email: null },
      ),
    ).toBe("Server Identity");
  });
});

describe("normalizeCompanyTeamTelemetry", () => {
  it("builds a mixed members list and kind partitions with top skills", () => {
    const view = normalizeCompanyTeamTelemetry(
      {
        perMember: [
          {
            personUid: "prs_ada",
            email: "ada@example.com",
            role: "admin",
            totals: {
              skills: {
                total: 10,
                bySkill: [
                  { skill: "plan", count: 5 },
                  { skill: "deploy", count: 3 },
                ],
              },
              distinctSessions: 4,
              events: 20,
            },
          },
          {
            personUid: "agt_bot",
            email: "",
            totals: {
              skills: {
                total: 2,
                bySkill: [{ skill: "execute-task", count: 2 }],
              },
              distinctSessions: 8,
              events: 40,
            },
          },
        ],
      },
      { activeProjectsByMemberId: { prs_ada: ["company-detail-desktop-ia"] } },
    );

    // Unified list ranks agents/humans together by sessions/events.
    expect(view.members).toHaveLength(2);
    expect(view.members[0].id).toBe("agt_bot");
    expect(view.members[1].id).toBe("prs_ada");
    expect(view.humans).toHaveLength(1);
    expect(view.agents).toHaveLength(1);
    expect(view.humans[0].displayName).toBe("ada@example.com");
    expect(view.humans[0].role).toBe("admin");
    expect(view.humans[0].topSkills.map((s) => s.skill)).toEqual([
      "plan",
      "deploy",
    ]);
    expect(view.humans[0].activeProjects).toEqual([
      "company-detail-desktop-ia",
    ]);
    expect(view.agents[0].kind).toBe("agent");
    expect(view.agents[0].topSkills[0].skill).toBe("execute-task");
    expect(view.empty).toBe(false);
  });

  it("accepts members key and empty payloads", () => {
    expect(normalizeCompanyTeamTelemetry({ members: [] }).empty).toBe(true);
    expect(normalizeCompanyTeamTelemetry({ members: [] }).members).toEqual([]);
    expect(normalizeCompanyTeamTelemetry(null).empty).toBe(true);
    expect(normalizeCompanyTeamTelemetry(null).members).toEqual([]);
  });

  it("keeps active projects supplied by company telemetry", () => {
    const view = normalizeCompanyTeamTelemetry({
      perMember: [
        {
          personUid: "agt_izzy",
          displayName: "Izzy",
          activeProjects: [
            "Instant DM delivery",
            { title: "HQ Desktop app" },
            { name: "Named project" },
            42,
          ],
        },
      ],
    });

    expect(view.members[0]?.activeProjects).toEqual([
      "Instant DM delivery",
      "HQ Desktop app",
      "Named project",
    ]);
  });

  it("joins UID-only telemetry rows to contact labels", () => {
    const view = normalizeCompanyTeamTelemetry(
      { perMember: [{ personUid: "prs_ada", totals: {} }] },
      { memberLabelsById: { prs_ada: { email: "ada@example.com" } } },
    );
    expect(view.humans[0].displayName).toBe("ada@example.com");
    expect(view.humans[0].displayName).not.toContain("prs_");
  });

  it("normalizes the production company telemetry member shape", () => {
    const view = normalizeCompanyTeamTelemetry(
      {
        members: [
          {
            personUid: "prs_ada",
            skills: { plan: 5, deploy: "3", ignored: "not-a-number" },
            events: 20,
            distinctSessions: "4",
          },
        ],
      },
      {
        memberLabelsById: {
          prs_ada: { email: "ada@example.com", displayName: "Ada Lovelace" },
        },
      },
    );

    expect(view.humans[0].displayName).toBe("Ada Lovelace");
    expect(view.humans[0].email).toBe("ada@example.com");
    expect(view.humans[0].sessions).toBe(4);
    expect(view.humans[0].events).toBe(20);
    expect(view.humans[0].topSkills).toEqual([
      { skill: "plan", count: 5 },
      { skill: "deploy", count: 3 },
    ]);
  });

  it("uses identities returned with telemetry before falling back to a source UID", () => {
    const view = normalizeCompanyTeamTelemetry({
      members: [
        {
          personUid: "prs_historical",
          skills: { journal: 3 },
          events: 28703,
          distinctSessions: 116,
        },
        {
          personUid: "agt_release",
          skills: { deploy: 2 },
        },
      ],
      identities: {
        persons: {
          prs_historical: {
            uid: "prs_historical",
            type: "person",
            name: "Historical Member",
            email: "historical@example.com",
          },
        },
        agents: {
          agt_release: {
            uid: "agt_release",
            type: "agent",
            name: "Release Agent",
          },
        },
      },
    });

    expect(
      view.members.find((member) => member.id === "prs_historical"),
    ).toMatchObject({
      displayName: "Historical Member",
      email: "historical@example.com",
    });
    expect(
      view.members.find((member) => member.id === "agt_release")?.displayName,
    ).toBe("Release Agent");

    const sourceOnly = normalizeCompanyTeamTelemetry({
      members: [{ personUid: "prs_source_only" }],
      identities: { persons: {}, agents: {} },
    });
    expect(sourceOnly.members[0]?.displayName).toBe("prs_source_only");
  });

  it("collapses only exact duplicate member UIDs without hiding same-name people", () => {
    const view = normalizeCompanyTeamTelemetry({
      members: [
        {
          personUid: "prs_ada",
          displayName: "Ada",
          events: 3,
          skills: { plan: 2 },
        },
        {
          personUid: "prs_ada",
          email: "ada@example.com",
          events: 5,
          skills: { plan: 4, deploy: 1 },
        },
        {
          personUid: "prs_other_ada",
          displayName: "Ada",
          events: 1,
        },
      ],
    });

    expect(view.members).toHaveLength(2);
    const merged = view.members.find((member) => member.id === "prs_ada");
    expect(merged?.displayName).toBe("Ada");
    expect(merged?.email).toBe("ada@example.com");
    expect(merged?.events).toBe(5);
    expect(merged?.topSkills).toEqual([
      { skill: "plan", count: 4 },
      { skill: "deploy", count: 1 },
    ]);
    expect(
      view.members.filter((member) => member.displayName === "Ada"),
    ).toHaveLength(2);
  });
});

describe("teamTelemetryErrorMessage", () => {
  it("maps permission, authentication, network, and fieldless errors to clear copy", () => {
    expect(teamTelemetryErrorMessage("HTTP 403 forbidden")).toMatch(
      /owner|admin/i,
    );
    expect(teamTelemetryErrorMessage("auth: unauthorized 401")).toMatch(
      /Sign in/i,
    );
    expect(teamTelemetryErrorMessage(new Error("network unavailable"))).toMatch(
      /connection/i,
    );
    expect(teamTelemetryErrorMessage("fetch failed")).toMatch(/connection/i);
    expect(teamTelemetryErrorMessage("")).toBe(
      "Failed to load team telemetry.",
    );
  });
});

describe("telemetry date range helpers", () => {
  it("formats a supplied UTC day and produces a bounded default range", () => {
    expect(isoDay(new Date("2026-07-28T23:59:59.000Z"))).toBe("2026-07-28");
    const range = defaultTelemetryRange();
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.from <= range.to).toBe(true);
  });
});
