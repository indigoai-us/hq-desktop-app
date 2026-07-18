import { describe, expect, it } from 'vitest';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-009 — Team activity and access.
 *
 * Source contracts for: mixed humans+agents in one list/detail workspace,
 * honest type/role labels (no People / Humans / Agents tabs), top skills +
 * active projects when present, invite + open-console only (no member/role/
 * access mutations), preserved telemetry empty/loading/error + tenant slug,
 * naked hairline list-detail, five type roles + 3px stacks, keyboard
 * selection / focus-visible / responsive collapse, light/dark + reduced
 * motion/transparency. No invented presence/activity.
 */

describe('DESKTOP-009: team activity and access', () => {
  const panel = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
  const adapter = readRepoFile('src/desktop-alt/lib/team-telemetry.ts');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const consoleLib = readRepoFile('src/desktop-alt/lib/hq-console.ts');
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');
  const route = readRepoFile('src/desktop-alt/route.ts');

  it('presents humans and agents together in one list/detail workspace', () => {
    expect(panel).toContain('data-testid="company-team-panel"');
    expect(panel).toContain('data-testid="team-workspace"');
    expect(panel).toContain('data-testid="team-list"');
    expect(panel).toContain('data-testid="team-member-row"');
    expect(panel).toContain('data-testid="team-detail"');
    expect(panel).toContain('data-testid="team-detail-pane"');
    expect(panel).toContain('class="list-detail team-workspace"');
    expect(panel).toContain('view.members');
    expect(panel).toContain('selectedMemberId');
    // Auto-select first ranked member for stable detail.
    expect(panel).toContain('selectedMemberId = next.members[0].id');
    // One list — not separate Humans/Agents top-level sections or People tab.
    expect(panel).not.toContain('data-testid="team-humans"');
    expect(panel).not.toContain('data-testid="team-agents"');
    expect(panel).not.toMatch(/>\s*People\s*</);
    expect(panel).not.toMatch(/role="tablist"/);
    expect(panel).not.toContain('Humans <span');
    expect(panel).not.toContain('Agents <span');
  });

  it('distinguishes members with honest type/role labels', () => {
    expect(adapter).toContain("export type TeamMemberKind = 'human' | 'agent'");
    expect(adapter).toContain('export function memberKindLabel');
    expect(adapter).toContain("return kind === 'agent' ? 'Agent' : 'Human'");
    expect(adapter).toContain('export function memberTypeRoleLabel');
    expect(panel).toContain('memberKindLabel(member.kind)');
    expect(panel).toContain('data-testid="team-kind-badge"');
    expect(panel).toContain('data-kind={member.kind}');
    expect(panel).toContain('data-testid="team-detail-kind"');
    // Pass through real role when present; never invent admin/owner/live status.
    expect(adapter).toContain('role?: string');
    expect(adapter).toContain("typeof r.role === 'string'");
    expect(panel).not.toMatch(/\bisOnline\b|\blastSeen\b|\bpresence\b|\bonline\b/i);
    expect(adapter).not.toMatch(/\bisOnline\b|\blastSeen\b|\bpresence\b|\bonline\b/i);
  });

  it('shows top skills and active projects when present', () => {
    expect(panel).toContain('data-testid="team-member-skills"');
    expect(panel).toContain('data-testid="team-member-projects"');
    expect(panel).toContain('data-testid="team-skill-chip"');
    expect(panel).toContain('data-testid="team-project-chip"');
    expect(panel).toContain('{#if selectedMember.topSkills.length > 0}');
    expect(panel).toContain('{#if selectedMember.activeProjects.length > 0}');
    expect(panel).toContain('Top skills');
    expect(panel).toContain('Active projects');
    expect(adapter).toContain('topSkills: TeamSkillUsage[]');
    expect(adapter).toContain('activeProjects: string[]');
  });

  it('keeps invite accessible and does not imply unsupported mutations', () => {
    expect(panel).toContain('data-testid="team-invite"');
    expect(panel).toContain('data-testid="team-open-console"');
    expect(panel).toContain('data-testid="team-primary-actions"');
    expect(panel).toContain('companyInviteUrl(slug)');
    expect(panel).toContain('companyConsoleUrl(slug)');
    expect(panel).toContain("from '../lib/hq-console'");
    expect(consoleLib).toContain("return `${companyConsoleUrl(slug)}/team/invites`");
    // Company-level Invite remains on CompanyPage as well.
    expect(companyPage).toContain('onclick={openInvite}');
    expect(companyPage).toContain('companyInviteUrl(company.slug)');
    // No in-app member editing / role editing / access mutations.
    expect(panel).not.toMatch(/\beditRole\b|\bchangeRole\b|\bupdateRole\b|\bsetRole\b/i);
    expect(panel).not.toMatch(/\bremoveMember\b|\bdeleteMember\b|\brevokeAccess\b/i);
    expect(panel).not.toMatch(/\broleSelect\b|\bmemberEdit\b|\baccessEdit\b/i);
    expect(panel).not.toContain('contenteditable');
    expect(panel).not.toContain('<select');
    expect(panel).not.toContain('type="checkbox"');
  });

  it('preserves telemetry command, tenant slug, empty/loading/error, and sessions/events', () => {
    expect(panel).toContain("invoke<unknown>('get_company_team_telemetry'");
    expect(panel).toContain('slug: activeSlug');
    expect(panel).toContain('from: range.from');
    expect(panel).toContain('to: range.to');
    expect(panel).toContain('normalizeCompanyTeamTelemetry(raw, { memberLabelsById })');
    expect(panel).toContain("'list_company_members'");
    expect(panel).toContain('data-testid="team-loading"');
    expect(panel).toContain('data-testid="team-error"');
    expect(panel).toContain('data-testid="team-empty"');
    expect(panel).toContain('Loading team…');
    expect(panel).toContain('teamTelemetryErrorMessage(err)');
    expect(panel).toContain('member.sessions');
    expect(panel).toContain('member.events');
    // Company tab wiring + no People section in company IA.
    expect(companyPage).toContain(
      '<TeamPanel slug={company.slug} companyUid={company.cloudUid} />',
    );
    expect(companyPage).toContain("{:else if tab === 'team'}");
    expect(route).toContain("id: 'team'");
    expect(route).not.toMatch(/id:\s*['"]people['"]/);
  });

  it('uses naked hairline list/detail; rounded only for controls, selection, chips', () => {
    expect(panel).toContain('border: 1px solid var(--v4-hairline)');
    expect(panel).toContain('border-right: 1px solid var(--v4-hairline)');
    expect(panel).toContain('border-radius: 0');
    expect(panel).toContain('background: transparent');
    // Selection / controls / chips may round.
    expect(panel).toMatch(/\.team-member-row\.is-selected\s*\{[\s\S]*?border-radius:\s*6px;/);
    expect(panel).toContain('border-radius: var(--v4-radius-button)');
    expect(panel).toContain('border-radius: var(--v4-radius-pill');
    expect(panel).toMatch(/\.skill-chip,[\s\S]*?border-radius:\s*6px;/);
    // No card chrome / shadow on the workspace shell.
    expect(panel).not.toContain('var(--v4-radius-card');
    expect(panel).not.toContain('var(--v4-shadow-card)');
    expect(desktopCss).toContain('.list-detail');
    expect(desktopCss).toContain(".list-detail[data-detail-open='true'] > .list-pane");
  });

  it('uses five semantic type roles and 3px title/meta stacks', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(tokens).toContain('--v4-row-stack-gap: 3px');
    expect(panel).toContain('--type-detail');
    expect(panel).toContain('--type-section');
    expect(panel).toContain('--type-body');
    expect(panel).toContain('--type-secondary');
    expect(panel).toContain('--type-metadata');
    expect(panel).toContain('var(--v4-row-stack-gap, 3px)');
    expect(panel).toContain('title-stack');
  });

  it('supports keyboard selection, focus-visible, and responsive collapse with actions retained', () => {
    expect(panel).toContain('handleListKeydown');
    expect(panel).toContain("event.key === 'ArrowDown'");
    expect(panel).toContain("event.key === 'ArrowUp'");
    expect(panel).toContain("event.key === 'Home'");
    expect(panel).toContain("event.key === 'End'");
    expect(panel).toContain('tabindex={isSelected ? 0 : -1}');
    expect(panel).toContain('aria-selected={isSelected}');
    expect(panel).toContain('role="listbox"');
    expect(panel).toContain('role="option"');
    expect(panel).toContain('.team-member-row:focus-visible');
    expect(panel).toContain('.team-action-button:focus-visible');
    expect(panel).toContain('.team-detail-back:focus-visible');
    expect(panel).toContain("data-detail-open={selectedMember != null ? 'true' : 'false'}");
    expect(panel).toContain('data-testid="team-detail-back"');
    expect(panel).toContain('@media (max-width: 820px)');
    expect(panel).toContain('@media (max-width: 720px)');
    // Invite + open-console stay in primary-actions (unshrunk under list-detail).
    expect(panel).toContain('detail-primary-actions primary-actions');
    expect(desktopCss).toMatch(
      /\.list-detail\s+\.detail-primary-actions,[\s\S]*?flex:\s*0\s+0\s+auto/,
    );
  });

  it('honors light/dark and reduced motion/transparency', () => {
    expect(tokens).toContain('--v4-text-1: #0a0c10');
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--v4-text-1:\s*#f4f6f8/,
    );
    expect(panel).toContain('@media (prefers-reduced-motion: reduce)');
    expect(panel).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(panel).toContain('transition: none');
  });
});
