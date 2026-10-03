import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadContinuationContext } from './desktop-continuation-tauri';
import { shouldSendFirstLaunchReceipt } from './desktop-session-continuation';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('CI first-launch telemetry suppression', () => {
  it('suppresses only the first-launch receipt when native CI context says so', () => {
    expect(shouldSendFirstLaunchReceipt(true, false)).toBe(true);
    expect(shouldSendFirstLaunchReceipt(false, false)).toBe(false);
    expect(shouldSendFirstLaunchReceipt(true, true)).toBe(false);
  });

  it('preserves the native suppression marker in continuation context', async () => {
    await expect(
      loadContinuationContext({
        invoke: async () => ({
          installAttemptId: '11111111-1111-4111-8111-111111111111',
          appVersion: '0.10.384',
          apiBase: 'https://hqapi.hq.computer/',
          suppressFirstLaunchTelemetry: true,
        }),
      }),
    ).resolves.toEqual({
      installAttemptId: '11111111-1111-4111-8111-111111111111',
      appVersion: '0.10.384',
      apiBase: 'https://hqapi.hq.computer',
      suppressFirstLaunchTelemetry: true,
    });
  });

  it('defaults suppression off when the native command has no CI marker', async () => {
    await expect(
      loadContinuationContext({
        invoke: async () => ({
          installAttemptId: '11111111-1111-4111-8111-111111111111',
          appVersion: '0.10.384',
          apiBase: 'https://hqapi.hq.computer/',
        }),
      }),
    ).resolves.toMatchObject({ suppressFirstLaunchTelemetry: false });
  });

  it('sets the marker only in CI jobs that launch the app', () => {
    const workflows = readFileSync(`${repoRoot}/.github/workflows/windows-check.yml`, 'utf8');
    const release = readFileSync(`${repoRoot}/.github/workflows/release.yml`, 'utf8');
    const desktopAuth = readFileSync(
      `${repoRoot}/apps/sync/src-tauri/src/commands/desktop_auth.rs`,
      'utf8',
    );
    const wizard = readFileSync(
      `${repoRoot}/apps/sync/src/components/onboarding/OnboardingWizard.svelte`,
      'utf8',
    );

    const jobSection = (source: string, name: string): string => {
      const start = source.indexOf(`  ${name}:`);
      expect(start).toBeGreaterThanOrEqual(0);
      const remainder = source.slice(start + name.length + 3);
      const nextJob = /^  [a-z][a-z0-9-]*:/m.exec(remainder);
      return nextJob ? source.slice(start, start + name.length + 3 + nextJob.index) : source.slice(start);
    };
    const marker = 'HQ_CI_FIRST_LAUNCH_TELEMETRY_SUPPRESSED: "1"';
    expect(jobSection(workflows, 'windows-check-live')).toContain(marker);
    expect(jobSection(workflows, 'windows-installer-e2e')).toContain(marker);
    expect(jobSection(workflows, 'windows-check-crates')).not.toContain(marker);
    expect(jobSection(workflows, 'windows-check-app')).not.toContain(marker);
    expect(release.match(/HQ_CI_FIRST_LAUNCH_TELEMETRY_SUPPRESSED: "1"/g)).toHaveLength(2);
    expect(release.match(/- name: Non-Indigo artifact smoke[\s\S]*?HQ_CI_FIRST_LAUNCH_TELEMETRY_SUPPRESSED: "1"/g)).toHaveLength(2);
    expect(desktopAuth).toContain('std::env::var("HQ_CI_FIRST_LAUNCH_TELEMETRY_SUPPRESSED")');
    expect(wizard).toContain('shouldSendFirstLaunchReceipt(firstLaunch, context.suppressFirstLaunchTelemetry)');
  });
});
