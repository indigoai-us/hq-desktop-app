import { describe, expect, it } from 'vitest';
import {
  displayNameFromMember,
  memberKindFromUid,
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

describe('displayNameFromMember', () => {
  it('prefers displayName, then email, then uid', () => {
    expect(displayNameFromMember({ displayName: 'Ada', email: 'a@x.com', personUid: 'prs_1' })).toBe(
      'Ada',
    );
    expect(displayNameFromMember({ email: 'a@x.com', personUid: 'prs_1' })).toBe('a@x.com');
    expect(displayNameFromMember({ personUid: 'prs_1' })).toBe('prs_1');
  });
});

describe('normalizeCompanyTeamTelemetry', () => {
  it('splits humans and agents and extracts top skills', () => {
    const view = normalizeCompanyTeamTelemetry(
      {
        perMember: [
          {
            personUid: 'prs_ada',
            email: 'ada@example.com',
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

    expect(view.humans).toHaveLength(1);
    expect(view.agents).toHaveLength(1);
    expect(view.humans[0].displayName).toBe('ada@example.com');
    expect(view.humans[0].topSkills.map((s) => s.skill)).toEqual(['plan', 'deploy']);
    expect(view.humans[0].activeProjects).toEqual(['company-detail-desktop-ia']);
    expect(view.agents[0].kind).toBe('agent');
    expect(view.agents[0].topSkills[0].skill).toBe('execute-task');
    expect(view.empty).toBe(false);
  });

  it('accepts members key and empty payloads', () => {
    expect(normalizeCompanyTeamTelemetry({ members: [] }).empty).toBe(true);
    expect(normalizeCompanyTeamTelemetry(null).empty).toBe(true);
  });
});

describe('teamTelemetryErrorMessage', () => {
  it('maps 403/401 to clear copy', () => {
    expect(teamTelemetryErrorMessage('HTTP 403 forbidden')).toMatch(/owner|admin/i);
    expect(teamTelemetryErrorMessage('auth: unauthorized 401')).toMatch(/Sign in/i);
  });
});
