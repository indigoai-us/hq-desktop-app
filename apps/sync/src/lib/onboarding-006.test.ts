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

// ─── Windows run 007 ────────────────────────────────────────────────

import {
  createSetupBandPacer,
  readyBodyCopy,
  toolsWaitHint,
} from './onboarding-setup';
import { readyGate } from './welcome-flow';

describe('createSetupBandPacer (run 007 note-0022)', () => {
  it('shows step 4 before step 5 when the install jumps two steps at once', () => {
    const pacer = createSetupBandPacer(1500);
    expect(setupStepSummary(pacer.pace(45, 0)).step).toBe(3);
    // The install finishes step 3 and step 4 in the same tick.
    expect(setupStepSummary(pacer.pace(85, 100)).step).toBe(3);
    expect(setupStepSummary(pacer.pace(85, 1600)).step).toBe(4);
    expect(setupStepSummary(pacer.pace(85, 2000)).step).toBe(4);
    expect(setupStepSummary(pacer.pace(85, 3200)).step).toBe(5);
  });

  it('passes progress inside the current step through unchanged', () => {
    const pacer = createSetupBandPacer(1500);
    expect(pacer.pace(41, 0)).toBe(41);
    expect(pacer.pace(58, 10)).toBe(58);
  });

  it('does not stall when the clock moves back', () => {
    const pacer = createSetupBandPacer(1500);
    pacer.pace(45, 10_000);
    pacer.pace(65, 4_000);
    expect(setupStepSummary(pacer.pace(65, 5_600)).step).toBe(4);
  });
});

describe('readyBodyCopy (run 007)', () => {
  it('does not say HQ is in the tray or offer Open while setup runs', () => {
    const text = readyBodyCopy({ installPending: true, os: 'windows' });
    expect(text).toBe('HQ is still setting up on this PC. You can open HQ Desktop when setup finishes.');
    expect(text).not.toMatch(/system tray now/);
  });

  it('keeps the finished copy once setup is done', () => {
    expect(readyBodyCopy({ installPending: false, os: 'windows' })).toEqual([
      'HQ lives in your system tray now and keeps everything in sync.',
      'Open HQ Desktop and your setup bot will walk you through the rest.',
    ].join('\n'));
    expect(readyBodyCopy({ installPending: true, os: 'macos' })).toContain('this Mac');
  });

  it('labels the HQ Desktop button as waiting, not Open, while setup runs', () => {
    const gate = readyGate({ installPending: true, consent: 'clear', finishing: false, launching: false });
    expect(gate.enabled).toBe(false);
    expect(gate.label).not.toMatch(/^Open/);
  });
});

describe('toolsWaitHint (run 007 note-0018)', () => {
  it('says why the tool button is not available yet', () => {
    expect(toolsWaitHint(['Claude Code'])).toBe('You can open Claude Code when setup finishes.');
    expect(toolsWaitHint(['Claude Code', 'Codex'])).toBe('You can open Claude Code or Codex when setup finishes.');
    expect(toolsWaitHint([])).toBeNull();
  });
});
