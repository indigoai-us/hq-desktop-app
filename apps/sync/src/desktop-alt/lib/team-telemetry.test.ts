import { describe, expect, it } from 'vitest';
import {
  displayNameFromMember,
  memberKindFromUid,
  memberKindLabel,
  memberTypeRoleLabel,
  normalizeCompanyTeamTelemetry,
  teamTelemetryErrorMessage,
} from './team-telemetry';

describe('memberKindFromUid', () => {
  it('classifies agt_* as agent and prs_* as human', () => {
    expect(memberKindFromUid('agt_01ABC')).toBe('agent');
    expect(memberKindFromUid('prs_01XYZ')).toBe('human');
    expect(memberKindFromUid('')).toBe('human');
  });
});

describe('memberKindLabel / memberTypeRoleLabel', () => {
  it('labels kinds honestly without inventing presence', () => {
    expect(memberKindLabel('agent')).toBe('Agent');
    expect(memberKindLabel('human')).toBe('Human');
  });

  it('prefers payload role when present, else kind label', () => {
    expect(memberTypeRoleLabel({ kind: 'human', role: 'owner' })).toBe('owner');
    expect(memberTypeRoleLabel({ kind: 'agent' })).toBe('Agent');
    expect(memberTypeRoleLabel({ kind: 'human', role: '  ' })).toBe('Human');
  });
});

describe('displayNameFromMember', () => {
  it('prefers displayName, then email, then a non-UID fallback', () => {
    expect(displayNameFromMember({ displayName: 'Ada', email: 'a@x.com', personUid: 'prs_1' })).toBe(
      'Ada',
    );
    expect(displayNameFromMember({ email: 'a@x.com', personUid: 'prs_1' })).toBe('a@x.com');
    expect(displayNameFromMember({ personUid: 'prs_1' })).toBe('Unknown member');
    expect(displayNameFromMember({ personUid: 'prs_1' })).not.toContain('prs_');
    expect(
      displayNameFromMember(
        { personUid: 'prs_1' },
        { email: 'resolved@example.com', displayName: null },
      ),
    ).toBe('resolved@example.com');
  });
});

describe('normalizeCompanyTeamTelemetry', () => {
  it('builds a mixed members list and kind partitions with top skills', () => {
    const view = normalizeCompanyTeamTelemetry(
      {
        perMember: [
          {
            personUid: 'prs_ada',
            email: 'ada@example.com',
            role: 'admin',
            totals: {
              skills: {
                total: 10,
                bySkill: [
                  { skill: 'plan', count: 5 },
                  { skill: 'deploy', count: 3 },
                ],
              },
              distinctSessions: 4,
              events: 20,
            },
          },
          {
            personUid: 'agt_bot',
            email: '',
            totals: {
              skills: { total: 2, bySkill: [{ skill: 'execute-task', count: 2 }] },
              distinctSessions: 8,
              events: 40,
            },
          },
        ],
      },
      { activeProjectsByMemberId: { prs_ada: ['company-detail-desktop-ia'] } },
    );

    // Unified list ranks agents/humans together by sessions/events.
    expect(view.members).toHaveLength(2);
    expect(view.members[0].id).toBe('agt_bot');
    expect(view.members[1].id).toBe('prs_ada');
    expect(view.humans).toHaveLength(1);
    expect(view.agents).toHaveLength(1);
    expect(view.humans[0].displayName).toBe('ada@example.com');
    expect(view.humans[0].role).toBe('admin');
    expect(view.humans[0].topSkills.map((s) => s.skill)).toEqual(['plan', 'deploy']);
    expect(view.humans[0].activeProjects).toEqual(['company-detail-desktop-ia']);
    expect(view.agents[0].kind).toBe('agent');
    expect(view.agents[0].topSkills[0].skill).toBe('execute-task');
    expect(view.empty).toBe(false);
  });

  it('accepts members key and empty payloads', () => {
    expect(normalizeCompanyTeamTelemetry({ members: [] }).empty).toBe(true);
    expect(normalizeCompanyTeamTelemetry({ members: [] }).members).toEqual([]);
    expect(normalizeCompanyTeamTelemetry(null).empty).toBe(true);
    expect(normalizeCompanyTeamTelemetry(null).members).toEqual([]);
  });

  it('keeps active projects supplied by company telemetry', () => {
    const view = normalizeCompanyTeamTelemetry({
      perMember: [
        {
          personUid: 'agt_izzy',
          displayName: 'Izzy',
          activeProjects: ['Instant DM delivery', { title: 'HQ Desktop app' }],
        },
      ],
    });

    expect(view.members[0]?.activeProjects).toEqual([
      'Instant DM delivery',
      'HQ Desktop app',
    ]);
  });

  it('joins UID-only telemetry rows to contact labels', () => {
    const view = normalizeCompanyTeamTelemetry(
      { perMember: [{ personUid: 'prs_ada', totals: {} }] },
      { memberLabelsById: { prs_ada: { email: 'ada@example.com' } } },
    );
    expect(view.humans[0].displayName).toBe('ada@example.com');
    expect(view.humans[0].displayName).not.toContain('prs_');
  });

  it('normalizes the production company telemetry member shape', () => {
    const view = normalizeCompanyTeamTelemetry(
      {
        members: [
          {
            personUid: 'prs_ada',
            skills: { plan: 5, deploy: '3', ignored: 'not-a-number' },
            events: 20,
            distinctSessions: '4',
          },
        ],
      },
      {
        memberLabelsById: {
          prs_ada: { email: 'ada@example.com', displayName: 'Ada Lovelace' },
        },
      },
    );

    expect(view.humans[0].displayName).toBe('Ada Lovelace');
    expect(view.humans[0].email).toBe('ada@example.com');
    expect(view.humans[0].sessions).toBe(4);
    expect(view.humans[0].events).toBe(20);
    expect(view.humans[0].topSkills).toEqual([
      { skill: 'plan', count: 5 },
      { skill: 'deploy', count: 3 },
    ]);
  });

  it('collapses only exact duplicate member UIDs without hiding same-name people', () => {
    const view = normalizeCompanyTeamTelemetry({
      members: [
        {
          personUid: 'prs_ada',
          displayName: 'Ada',
          events: 3,
          skills: { plan: 2 },
        },
        {
          personUid: 'prs_ada',
          email: 'ada@example.com',
          events: 5,
          skills: { plan: 4, deploy: 1 },
        },
        {
          personUid: 'prs_other_ada',
          displayName: 'Ada',
          events: 1,
        },
      ],
    });

    expect(view.members).toHaveLength(2);
    const merged = view.members.find((member) => member.id === 'prs_ada');
    expect(merged?.displayName).toBe('Ada');
    expect(merged?.email).toBe('ada@example.com');
    expect(merged?.events).toBe(5);
    expect(merged?.topSkills).toEqual([
      { skill: 'plan', count: 4 },
      { skill: 'deploy', count: 1 },
    ]);
    expect(view.members.filter((member) => member.displayName === 'Ada')).toHaveLength(2);
  });
});

describe('teamTelemetryErrorMessage', () => {
  it('maps 403/401 to clear copy', () => {
    expect(teamTelemetryErrorMessage('HTTP 403 forbidden')).toMatch(/owner|admin/i);
    expect(teamTelemetryErrorMessage('auth: unauthorized 401')).toMatch(/Sign in/i);
  });
});
