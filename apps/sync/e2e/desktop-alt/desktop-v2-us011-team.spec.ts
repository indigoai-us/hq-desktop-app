import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-011 — Team page V2 with telemetry.
 *
 * Source contracts for the V2 Team page: 30-day header scope ("Last 30 days ·
 * N humans · M agents"), Invite preserved, Open console deep-linking to the
 * console team roster (canonical base in lib/hq-console.ts), member rows with
 * name/role/sessions/events + Human/Agent chip, and the selected-member
 * activity summary (Type & role / Sessions / Events, top skills empty-safe,
 * active projects). Loading / empty / error states preserved.
 */

describe('US-011: Team page V2 with telemetry', () => {
  const panel = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
  const adapter = readRepoFile('src/desktop-alt/lib/team-telemetry.ts');
  const consoleLib = readRepoFile('src/desktop-alt/lib/hq-console.ts');

  it('scopes the header to the last 30 days with human/agent counts', () => {
    expect(panel).toContain('data-testid="team-scope-meta"');
    expect(panel).toContain('Last 30 days');
    expect(panel).toContain('defaultTelemetryRange(30)');
    expect(panel).toContain('{humanCount}');
    expect(panel).toContain('{agentCount}');
  });

  it('keeps Invite and deep-links Open console to the roster page', () => {
    expect(panel).toContain('data-testid="team-invite"');
    expect(panel).toContain('companyInviteUrl(slug)');
    expect(panel).toContain('data-testid="team-open-console"');
    expect(panel).toContain('companyTeamUrl(slug)');
    // Canonical console base lives in lib/hq-console.ts only.
    expect(consoleLib).toContain("export const HQ_CONSOLE_BASE = 'https://hq.computer'");
    expect(consoleLib).toContain('return `${companyConsoleUrl(slug)}/team`');
    expect(panel).not.toContain('hq.computer');
  });

  it('renders the activity summary when a member with sessions is selected', () => {
    // Given a member with sessions, when selected, then the activity summary
    // and projects render (US-011 e2e).
    expect(panel).toContain('Activity summary · last 30 days');
    expect(panel).toContain('data-testid="team-member-facts"');
    expect(panel).toContain('Type & role');
    expect(panel).toContain('<dt>Sessions</dt>');
    expect(panel).toContain('<dt>Events</dt>');
    expect(panel).toContain('data-testid="team-member-projects"');
    expect(panel).toContain('{#if selectedMember.activeProjects.length > 0}');
  });

  it('derives top skills with counts and omits the section cleanly when absent', () => {
    expect(panel).toContain('{#if selectedMember.topSkills.length > 0}');
    expect(panel).toContain('data-testid="team-skill-chip"');
    expect(panel).toContain('{skill.count}');
    expect(adapter).toContain('topSkills: TeamSkillUsage[]');
    // Empty-safe fallback message when no skills or projects exist.
    expect(panel).toContain('data-testid="team-detail-no-activity"');
  });

  it('preserves loading, empty, and error states', () => {
    expect(panel).toContain('data-testid="team-loading"');
    expect(panel).toContain('data-testid="team-empty"');
    expect(panel).toContain('data-testid="team-error"');
    expect(panel).toContain('teamTelemetryErrorMessage(err)');
  });
});
