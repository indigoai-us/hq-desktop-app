import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('assigned raw-ID display surfaces', () => {
  it('resolves request and contact labels before rendering messaging surfaces', () => {
    const app = source('../App.svelte');
    const requestCard = source('./messaging/DmRequestCard.svelte');
    const shell = source('./messaging/MessagesShell.svelte');
    const conversation = source('./messaging/Conversation.svelte');
    const thread = source('./messaging/ThreadPanel.svelte');
    const catchUp = source('./messaging/v4/CatchUp.svelte');

    expect(app).toContain('enrichIncomingRequest(e.payload)');
    expect(requestCard).toContain('sanitizeVisibleIdentifiers(requestDisplayName(request))');
    expect(shell).toContain('return humanPersonLabel(c);');
    expect(shell).toContain('enrichRequestFromContacts(request, response.contacts ?? [])');
    expect(shell).not.toContain('c.email?.trim() || c.personUid');
    expect(conversation).toContain("sanitizeVisibleIdentifiers(msg.pendingLabel || 'Pending')");
    expect(thread).toContain('sanitizeVisibleIdentifiers(title)');
    expect(catchUp).toContain('sanitizeVisibleIdentifiers(item.title)');
  });

  it('uses company names or generic labels in meeting and desktop surfaces', () => {
    const meetings = source('./MeetingsWindow.svelte');
    const popover = source('./Popover.svelte');
    const desktop = source('../desktop-alt/DesktopApp.svelte');
    const liveNow = source('../desktop-alt/components/LiveNowCard.svelte');
    const companyPage = source('../desktop-alt/pages/CompanyPage.svelte');
    const teamPanel = source('../desktop-alt/panels/TeamPanel.svelte');

    expect(meetings).toContain('recordingCompanyLabel(c)');
    expect(meetings).not.toContain('c.companyName ?? c.companyUid');
    expect(meetings).not.toContain('e.sourceCompanyUid.slice(0, 12)');
    expect(popover).toContain('title={visibleCloudError}');
    expect(desktop).toContain('companyLabel(upcoming, meetingCompanyNamesByUid)');
    expect(desktop).not.toContain('?? upcoming.sourceCompanyUid');
    expect(liveNow).toContain('humanCompanyLabel(m)');
    expect(liveNow).not.toContain('m.companyName ?? m.companyUid');
    expect(companyPage).toContain('`Retry connecting ${company.displayName} to the cloud`');
    expect(teamPanel).toContain("invoke<ContactsResponse>('list_company_members'");
    expect(teamPanel).toContain('normalizeCompanyTeamTelemetry(raw, { memberLabelsById })');
  });
});
