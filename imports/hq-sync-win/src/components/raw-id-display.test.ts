import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('Windows raw-ID display surfaces', () => {
  it('never uses company UID fragments as meeting labels', () => {
    const meetings = source('./MeetingsWindow.svelte');
    expect(meetings).toContain('humanCompanyLabel(rm, activeMeetingCompanyLabel(rm.companyUid))');
    expect(meetings).not.toContain('rm.companyName ?? activeMeetingCompanyLabel');
    expect(meetings).not.toContain('`${companyUid.slice(0, 12)}…`');
    expect(meetings).not.toContain('e.sourceCompanyUid.slice(0, 12)');
  });

  it('sanitizes workspace errors and uses names in broken-state tooltips', () => {
    const workspaces = source('./WorkspaceList.svelte');
    expect(workspaces).toContain('title={visibleCloudError}');
    expect(workspaces).toContain('`${w.displayName} needs to be reconnected to the cloud`');
    expect(workspaces).toContain('`${w.displayName} is out of sync with the cloud');
    expect(workspaces).not.toContain('title={w.brokenReason');
  });
});
