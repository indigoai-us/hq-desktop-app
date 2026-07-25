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
});

describe('teamTelemetryErrorMessage', () => {
  it('maps 403/401 to clear copy', () => {
    expect(teamTelemetryErrorMessage('HTTP 403 forbidden')).toMatch(/owner|admin/i);
    expect(teamTelemetryErrorMessage('auth: unauthorized 401')).toMatch(/Sign in/i);
  });
});
