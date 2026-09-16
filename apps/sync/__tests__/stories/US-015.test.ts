import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const permissionWizard = readFileSync(
  resolve(process.cwd(), 'src/components/MeetingPermissionsWindow.svelte'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-015: Meetings in V4 remains gated and action-complete', () => {

  it('keeps the permission wizard user-driven with TCC states and grant actions', () => {
    expect(permissionWizard).toContain("invoke('permissions_force_native_register')");
    expect(permissionWizard).toContain("invoke('permissions_open_settings'");
    expect(permissionWizard).toContain("invoke('start_recall_sdk')");
    expect(permissionWizard).toContain('snapshot.microphone');
    expect(permissionWizard).toContain('snapshot.screenCapture');
    expect(permissionWizard).toContain('snapshot.accessibility');
    expect(permissionWizard).toContain('snapshot.fullDiskAccess');
    expect(permissionWizard).toContain('Trigger prompts');
    expect(permissionWizard).toContain('Open Settings');
    expect(permissionWizard).toContain('Manage in Settings');
  });
});
