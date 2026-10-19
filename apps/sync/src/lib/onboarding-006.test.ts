import { describe, expect, it } from 'vitest';

import {
  GIT_PERMISSION_NOTICE,
  createStageClock,
  GIT_WAITING_NOTICE,
  createDepsToolTracker,
  depsFailureRecovery,
  depsStageErrorText,
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

describe('createDepsToolTracker (run 006 and gate 2 F5: the line named the last install started)', () => {
  it('names the tool being installed in plain words', () => {
    const names: Array<[string, string]> = [
      ['git', 'Git'],
      ['node', 'Node.js'],
      ['qmd', 'HQ search'],
      ['hq-cli', 'the HQ command line tool'],
      ['yq', 'yq'],
      ['jq', 'jq'],
      ['gh', 'GitHub CLI'],
      ['claude-code', 'Claude Code'],
      ['homebrew', 'Homebrew'],
    ];
    for (const [id, name] of names) {
      const tracker = createDepsToolTracker();
      tracker.apply({ id, state: 'installing' });
      expect(tracker.detail()).toBe(`Installing ${name}…`);
    }
  });

  it('never names a tool that already finished (macOS wave: jq done while Node runs)', () => {
    const tracker = createDepsToolTracker();
    tracker.apply({ id: 'node', state: 'installing' });
    tracker.apply({ id: 'jq', state: 'installing' });
    expect(tracker.detail()).toBe('Installing Node.js and jq…');
    tracker.apply({ id: 'jq', state: 'done' });
    expect(tracker.detail()).toBe('Installing Node.js…');
    tracker.apply({ id: 'node', state: 'failed' });
    expect(tracker.detail()).toBeNull();
  });

  it('counts the other tools when more than two install at once', () => {
    const tracker = createDepsToolTracker();
    for (const id of ['node', 'yq', 'git', 'jq']) tracker.apply({ id, state: 'installing' });
    expect(tracker.detail()).toBe('Installing Node.js and 3 other tools…');
  });

  it('drops a tool that is queued behind another install (Windows runs installers one at a time)', () => {
    const tracker = createDepsToolTracker();
    tracker.apply({ id: 'git', state: 'installing' });
    tracker.apply({ id: 'gh', state: 'installing' });
    tracker.apply({ id: 'gh', state: 'queued' });
    expect(tracker.detail()).toBe('Installing Git…');
    tracker.apply({ id: 'git', state: 'done' });
    tracker.apply({ id: 'gh', state: 'installing' });
    expect(tracker.detail()).toBe('Installing GitHub CLI…');
  });

  it('points at the permission prompt when an install runs long, until it finishes (gate 2 N6)', () => {
    const tracker = createDepsToolTracker();
    tracker.apply({ id: 'gh', state: 'installing' });
    expect(tracker.waitingNotice()).toBeNull();
    tracker.apply({ id: 'gh', state: 'waiting' });
    expect(tracker.waitingNotice()).toBe(
      'Windows may be waiting for your permission to install GitHub CLI. Look for a permission prompt on the taskbar.',
    );
    expect(tracker.detail()).toBe('Installing GitHub CLI…');
    tracker.apply({ id: 'gh', state: 'done' });
    expect(tracker.waitingNotice()).toBeNull();
  });

  it('uses the same words as the Git notice for Git', () => {
    const tracker = createDepsToolTracker();
    tracker.apply({ id: 'git', state: 'waiting' });
    expect(tracker.waitingNotice()).toBe(GIT_WAITING_NOTICE);
  });

  it('never names an installer it does not know (gate 2 NEW-3: "Installing Installer…")', () => {
    const tracker = createDepsToolTracker();
    tracker.apply({ id: 'installer', state: 'installing' });
    tracker.apply({ id: 'installer', state: 'waiting' });
    tracker.apply({ id: null, state: 'waiting' });
    expect(tracker.detail()).toBeNull();
    expect(tracker.waitingNotice()).toBeNull();
    tracker.apply({ id: 'node', state: 'installing' });
    tracker.apply({ id: 'mystery-tool', state: 'installing' });
    expect(tracker.detail()).toBe('Installing Node.js…');
  });

  it('never says jq or yq wait for permission (gate 2 NEW-4: they are downloads)', () => {
    for (const [id, name] of [
      ['jq', 'jq'],
      ['yq', 'yq'],
    ]) {
      const tracker = createDepsToolTracker();
      tracker.apply({ id, state: 'waiting' });
      expect(tracker.waitingNotice()).toBeNull();
      expect(tracker.detail()).toBe(`Installing ${name}…`);
    }
  });

  it('ignores an unusable payload and can be reset', () => {
    const tracker = createDepsToolTracker();
    tracker.apply(null);
    tracker.apply({ id: '', state: 'installing' });
    tracker.apply({ id: 'git', state: 'unknown' });
    expect(tracker.detail()).toBeNull();
    tracker.apply({ id: 'git', state: 'installing' });
    tracker.reset();
    expect(tracker.detail()).toBeNull();
  });
});

describe('depsExpectationCopy', () => {
  it('gives an honest time on Windows only', () => {
    expect(depsExpectationCopy('windows')).toBe(
      'Some installs can take several minutes on Windows.',
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

  it('says Windows may be waiting for permission when the Git install runs long', () => {
    expect(GIT_WAITING_NOTICE).toBe(
      'Windows may be waiting for your permission to install Git. Look for a permission prompt on the taskbar.',
    );
  });

  it('no longer treats a long install as a failure (gate 2 F1: no deadline kill)', () => {
    expect(
      depsFailureRecovery('git: [winget-timeout] Installing Git took longer than 10 minutes and was stopped.'),
    ).toBeNull();
  });

  it('keeps the bracketed marker out of the stage error text', () => {
    expect(
      depsStageErrorText('[git-permission-declined] Windows permission to install Git was declined.'),
    ).toBe('Git was not installed because permission was declined. Select Try again and choose Yes when Windows asks.');
    expect(depsStageErrorText('network unreachable')).toBe('network unreachable');
  });

  it('offers Try again for an install that stopped or a Git that does not start (gate 2 N5)', () => {
    const cases: Array<[string, string]> = [
      [
        'Dependency install failed: Git: [install-retry] Git could not be started after installing. Select Try again.; Node.js: network unreachable',
        'Git could not be started after installing. Select Try again.',
      ],
      [
        'Dependency install failed: GitHub CLI: [install-retry] An install stopped before it finished. Select Try again.',
        'An install stopped before it finished. Select Try again.',
      ],
      [
        '[install-retry] HQ could not update the Windows PATH setting. Select Try again.',
        'HQ could not update the Windows PATH setting. Select Try again.',
      ],
    ];
    for (const [error, message] of cases) {
      expect(depsFailureRecovery(error)).toEqual({ kind: 'install-retry', message });
      expect(depsStageErrorText(error)).toBe(message);
    }
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
    expect(toolsWaitHint(['Claude Code', 'Codex', 'Grok'])).toBe(
      'You can open Claude Code, Codex or Grok when setup finishes.',
    );
    expect(toolsWaitHint([])).toBeNull();
  });
});
