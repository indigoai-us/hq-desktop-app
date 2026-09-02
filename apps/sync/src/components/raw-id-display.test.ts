import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('assigned raw-ID display surfaces', () => {
  it('resolves request and contact labels before rendering messaging surfaces', () => {
    const app = source('../App.svelte');
    const conversation = source('./messaging/Conversation.svelte');

    expect(app).toContain('enrichIncomingRequest(e.payload)');
    expect(conversation).toContain("sanitizeVisibleIdentifiers(msg.pendingLabel || 'Pending')");
  });

  it('uses company names or generic labels in meeting and desktop surfaces', () => {
    const meetings = source('./MeetingsWindow.svelte');
    const popover = source('./Popover.svelte');
    const desktop = source('../desktop-alt/DesktopApp.svelte');
    const meetingsPage = source('../desktop-alt/pages/MeetingsPage.svelte');
    const liveNow = source('../desktop-alt/components/LiveNowCard.svelte');
    const companyPage = source('../desktop-alt/pages/CompanyPage.svelte');
    const teamPanel = source('../desktop-alt/panels/TeamPanel.svelte');

    expect(meetings).toContain('recordingCompanyLabel(c)');
    expect(meetings).not.toContain('c.companyName ?? c.companyUid');
    expect(meetings).not.toContain('e.sourceCompanyUid.slice(0, 12)');
    expect(popover).toContain('title={visibleCloudError}');
    expect(desktop).not.toContain('?? upcoming.sourceCompanyUid');
    expect(meetingsPage).toContain('companyLabel(upNext, companyNamesByUid)');
    expect(meetingsPage).not.toContain('?? upNext.sourceCompanyUid');
    expect(liveNow).toContain('humanCompanyLabel(m)');
    expect(liveNow).not.toContain('m.companyName ?? m.companyUid');
    expect(companyPage).toContain('`Retry connecting ${company.displayName} to the cloud`');
    expect(teamPanel).toContain("invoke<ContactsResponse>('list_company_members'");
    expect(teamPanel).toContain('normalizeCompanyTeamTelemetry(raw, { memberLabelsById })');
  });
});
