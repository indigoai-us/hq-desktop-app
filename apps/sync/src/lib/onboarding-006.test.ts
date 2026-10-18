import { describe, expect, it } from 'vitest';

import {
  GIT_PERMISSION_NOTICE,
  createStageClock,
  depsFailureRecovery,
  depsToolDetail,
  setupHeading,
  setupStepSummary,
} from './onboarding-setup';
import {
  depsExpectationCopy,
  openHqShortcutChord,
  shortcutTryItHint,
  SHORTCUT_NEXT_BUSY_HINT,
} from './onboarding-platform';

// Windows onboarding persona run 006 (sal-win-install-006).

describe('createStageClock (run 006 grid-0052/0053: timer went 7m31s then 7m25s)', () => {
  it('never reports less elapsed time than it already did', () => {
    let now = 1_000;
    const clock = createStageClock(() => now);
    now += 451_000;
    expect(clock.elapsed()).toBe(451_000);
    // The source clock steps back 6s, as a wall clock does when Windows syncs time.
    now -= 6_000;
    expect(clock.elapsed()).toBe(451_000);
    now += 10_000;
    expect(clock.elapsed()).toBe(455_000);
  });

  it('defaults to a monotonic clock, not the wall clock', () => {
    const clock = createStageClock();
    expect(clock.elapsed()).toBeGreaterThanOrEqual(0);
  });
});

describe('setupHeading (run 006: step 2 said "Almost ready")', () => {
  it('says "Setting up HQ" before the last step', () => {
    expect(setupHeading({ installPending: true, step: setupStepSummary(25) })).toBe(
      'Setting up HQ',
    );
    expect(setupHeading({ installPending: true, step: setupStepSummary(0) })).toBe(
      'Setting up HQ',
    );
  });

  it('says "Almost ready." on the last step and "HQ is ready." when done', () => {
    expect(setupHeading({ installPending: true, step: setupStepSummary(85) })).toBe(
      'Almost ready.',
    );
    expect(setupHeading({ installPending: false, step: setupStepSummary(100) })).toBe(
      'HQ is ready.',
    );
  });
});

describe('depsToolDetail (run 006: "Wiring them into your shell" for 11 minutes)', () => {
  it('names the tool being installed', () => {
    expect(depsToolDetail({ id: 'git', state: 'installing' })).toBe('Installing Git…');
    expect(depsToolDetail({ id: 'node', state: 'installing' })).toBe('Installing Node.js…');
    expect(depsToolDetail({ id: 'qmd', state: 'installing' })).toBe('Installing HQ search…');
    expect(depsToolDetail({ id: 'hq-cli', state: 'installing' })).toBe(
      'Installing the HQ command line tool…',
    );
    expect(depsToolDetail({ id: 'yq', state: 'installing' })).toBe('Installing yq…');
  });

  it('says nothing for a finished tool or an unusable payload', () => {
    expect(depsToolDetail({ id: 'git', state: 'done' })).toBeNull();
    expect(depsToolDetail({ id: '', state: 'installing' })).toBeNull();
    expect(depsToolDetail(null)).toBeNull();
  });
});

describe('depsExpectationCopy', () => {
  it('gives an honest time on Windows only', () => {
    expect(depsExpectationCopy('windows')).toBe(
      'This step can take up to 10 minutes on Windows.',
    );
    expect(depsExpectationCopy('macos')).toBeNull();
  });
});

describe('Git permission (run 006 grid-0025: Windows prompt arrived with no warning)', () => {
  it('warns before Windows asks', () => {
    expect(GIT_PERMISSION_NOTICE).toBe(
      'Windows will ask for permission to install Git. Choose Yes to continue.',
    );
  });

  it('offers Try again when the permission was declined', () => {
    expect(
      depsFailureRecovery(
        '[git-permission-declined] Windows permission to install Git was declined.',
      ),
    ).toEqual({
      kind: 'git-permission-declined',
      message:
        'Git was not installed because permission was declined. Select Try again and choose Yes when Windows asks.',
    });
  });

  it('offers Try again when winget ran past its deadline', () => {
    expect(
      depsFailureRecovery(
        'git: [winget-timeout] Installing Git took longer than 10 minutes and was stopped.',
      ),
    ).toEqual({
      kind: 'winget-timeout',
      message:
        'Installing Git took longer than 10 minutes and was stopped. Select Try again to start it again.',
    });
  });

  it('leaves other failures alone', () => {
    expect(depsFailureRecovery('network unreachable')).toBeNull();
    expect(depsFailureRecovery(null)).toBeNull();
  });
});

describe('shortcut screen hint (run 006 grid-0023: Next looked disabled)', () => {
  it('tells the user Next works without the shortcut', () => {
    expect(shortcutTryItHint(openHqShortcutChord('pc'))).toBe(
      'Try it now: press Alt Shift O. Or select Next.',
    );
  });

  it('explains the busy state', () => {
    expect(SHORTCUT_NEXT_BUSY_HINT).toBe('Checking your account. This takes a few seconds.');
  });
});
