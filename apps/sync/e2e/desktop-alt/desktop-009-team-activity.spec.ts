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
    // Team panel must not invent presence chrome; chat presence-store wiring
    // (presenceStatus / presence-store / PresenceStore) is permitted in chat
    // packages, not on this panel.
    expect(panel).not.toMatch(/\bisOnline\b|\blastSeen\b|\bpresence\b|\bonline\b/i);
    // Adapter TeamMember shape still forbids invented presence field names.
    expect(adapter).not.toMatch(/\bisOnline\s*[?:]/);
    expect(adapter).not.toMatch(/\blastSeen\s*[?:]/);
    expect(adapter).not.toMatch(/\bonline\s*[?:]/);
    expect(adapter).not.toMatch(/\bpresence\s*[?:]/);
  });

  it('forbids inventing presence from timestamps or session/event counts', () => {
    // lastActivityAt / events / sessions must not be mapped into online flags.
    expect(adapter).not.toMatch(/lastActivityAt[\s\S]{0,80}\bonline\b/i);
    expect(adapter).not.toMatch(/\bonline\b[\s\S]{0,80}lastActivityAt/i);
    expect(adapter).not.toMatch(
      /\bonline\b\s*[:=][^=]*\b(events|sessions|distinctSessions|lastActivityAt|lastSeen)\b/i,
    );
    expect(adapter).not.toMatch(
      /\b(events|sessions|distinctSessions|lastActivityAt|lastSeen)\b[^=]{0,40}[:=][^=]*\bonline\b/i,
    );
    expect(adapter).toMatch(/Never invent live status|never derived from timestamps/i);
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

  it('normalizes the production telemetry contract and shows resolved identity', () => {
    expect(adapter).toContain('email?: string');
    expect(adapter).toContain('r.skills ?? totals?.skills');
    expect(adapter).toContain('r.events ?? totals?.events');
    expect(adapter).toContain('r.distinctSessions ?? totals?.distinctSessions');
    expect(adapter).toContain('Object.entries(source as Record<string, unknown>)');
    expect(panel).toContain('data-testid="team-detail-email"');
    expect(panel).toContain('selectedMember.email');
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

  it('uses naked hairline list/detail with square open selection rows', () => {
    expect(panel).toContain('border: 1px solid var(--v4-hairline)');
    expect(panel).toContain('border-right: 1px solid var(--v4-hairline)');
    expect(panel).toContain('border-radius: 0');
    expect(panel).toContain('background: transparent');
    expect(panel).toMatch(
      /\.team-member-row\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
    expect(panel).toMatch(
      /\.team-member-row\.is-selected\s*\{[\s\S]*?border-radius:\s*0;/,
    );
    // True controls and type labels may retain a compact radius; telemetry
    // collections are flat rows rather than nested rounded containers.
    expect(panel).toContain('border-radius: var(--v4-radius-button)');
    expect(panel).toContain('border-radius: var(--v4-radius-pill');
    expect(panel).toMatch(
      /\.skill-chip,[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
    // No card chrome / shadow on the workspace shell.
    expect(panel).not.toContain('var(--v4-radius-card');
    expect(panel).not.toContain('var(--v4-shadow-card)');
    expect(desktopCss).toContain('.list-detail');
    expect(desktopCss).toContain(".list-detail[data-detail-open='true'] > .list-pane");
  });

  it('uses five semantic type roles and 3px title/meta stacks', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 13,
      secondary: 14,
      body: 15,
      section: 17,
      detail: 24,
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

  it('fills the desktop canvas with a proportional team rail and explicit facts', () => {
    expect(panel).toContain('data-testid="team-member-facts"');
    expect(panel).toContain('Type & role');
    expect(panel).toContain("selectedMember.sessions ?? 'Unavailable'");
    expect(panel).toContain("selectedMember.events ?? 'Unavailable'");
    expect(panel).toMatch(
      /\.team-panel\s*\{[\s\S]*?min-height:\s*clamp\(360px,\s*calc\(100dvh - 170px\),\s*620px\);/,
    );
    expect(panel).toMatch(
      /\.team-workspace\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(280px,\s*34%\)\s*minmax\(0,\s*1fr\);[\s\S]*?border-radius:\s*0;/,
    );
    expect(panel).toMatch(
      /\.team-section-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    );
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
    expect(panel).toContain(
      ".team-workspace[data-detail-open='false'] .team-detail-pane",
    );
    // Narrow company canvases can be only ~180px after the global sidebar.
    // Actions must reflow by their actual available width rather than giving
    // two flex children width:100%, which pushes the second control off-canvas.
    expect(panel).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.team-actions\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(120px,\s*1fr\)\);[\s\S]*?width:\s*100%;/,
    );
    expect(panel).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.team-panel\s*\{[\s\S]*?inline-size:\s*calc\(100dvw - 256px\);[\s\S]*?max-inline-size:\s*100%;/,
    );
    expect(panel).toMatch(
      /\.team-actions \.team-action-button\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?white-space:\s*normal;/,
    );
    expect(panel).toMatch(
      /\.team-meta\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*normal;/,
    );
    expect(panel).toMatch(
      /\.team-detail-title-row h3,[\s\S]*?\.team-detail-meta\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*normal;/,
    );
    // Invite + open-console stay in primary-actions (unshrunk under list-detail).
    expect(panel).toContain('detail-primary-actions primary-actions');
    expect(desktopCss).toMatch(
      /\.list-detail\s+\.detail-primary-actions,[\s\S]*?flex:\s*0\s+0\s+auto/,
    );
  });

  it('honors light/dark and reduced motion/transparency', () => {
    expect(tokens).toContain('--v4-text-1: #111111');
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--v4-text-1:\s*#f2f2f2/,
    );
    expect(panel).toContain('@media (prefers-reduced-motion: reduce)');
    expect(panel).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(panel).toContain('transition: none');
  });
});
