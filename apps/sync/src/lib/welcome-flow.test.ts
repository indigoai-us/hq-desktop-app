import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_IMPORT_STEP_INDEX,
  CONSENT_STEP_INDEX,
  DIRECTORY_STEP_INDEX,
  FIRST_FOLDER_SYNC_STEP_INDEX,
  INVITE_TEAMMATE_STEP_INDEX,
  READY_STEP_INDEX,
  SETUP_STEP_INDEX,
  WELCOME_SIGNIN_STEP_INDEX,
  WIZARD_STEPS,
} from './onboarding-wizard';
import {
  REPLAY_SCENES,
  STORY_SCENES,
  forwardLabel,
  installCardModel,
  installCardActivityLines,
  readyProgressLine,
  readyRequiredFailureHeading,
  nextScene,
  previousScene,
  sceneForStep,
  stepForScene,
  welcomeChrome,
  welcomeKeyIntent,
} from './welcome-flow';

describe('welcome flow scene order', () => {
  // Product decision (2026-09-27): usage-data consent is a checkbox on the
  // ready screen, not a screen of its own, so the first-run flow is five
  // screens.
  it('walks welcome, folder, cloud, shortcut, ready in that order', () => {
    expect(STORY_SCENES).toEqual(['welcome', 'folder', 'cloud', 'shortcut', 'ready']);
    const walked: string[] = ['welcome'];
    let scene = nextScene('welcome', false);
    while (scene && scene !== 'end') {
      walked.push(scene);
      scene = nextScene(scene, false);
    }
    expect(walked).toEqual([...STORY_SCENES]);
    expect(scene).toBe('end');
  });

  it('keeps the wizard step model underneath: both explainers are the setup step', () => {
    expect(stepForScene('welcome')).toBe(WELCOME_SIGNIN_STEP_INDEX);
    expect(stepForScene('folder')).toBe(DIRECTORY_STEP_INDEX);
    expect(stepForScene('cloud')).toBe(SETUP_STEP_INDEX);
    expect(stepForScene('shortcut')).toBe(SETUP_STEP_INDEX);
    expect(stepForScene('consent')).toBe(CONSENT_STEP_INDEX);
    expect(stepForScene('ready')).toBe(READY_STEP_INDEX);
    // Every wizard step lands on a screen, and resuming mid-install lands on
    // the first explainer (the install carries on in the background).
    for (const step of WIZARD_STEPS) {
      expect(stepForScene(sceneForStep(step.index))).toBe(step.index);
    }
    expect(sceneForStep(SETUP_STEP_INDEX)).toBe('cloud');
  });

  it('steps back one screen at a time and never before the welcome', () => {
    expect(previousScene('welcome', false)).toBeNull();
    expect(previousScene('folder', false)).toBe('welcome');
    expect(previousScene('ready', false)).toBe('shortcut');
    // The consent scene is only the consent-only runs, off the story strip.
    expect(previousScene('consent', false)).toBeNull();
    expect(nextScene('shortcut', false)).toBe('ready');
    expect(previousScene('connectors', false)).toBeNull();
    expect(previousScene('first-folder', false)).toBeNull();
    expect(previousScene('invite', false)).toBeNull();
  });

  it('gives each optional follow-on step its own screen at the ready position', () => {
    expect(sceneForStep(FIRST_FOLDER_SYNC_STEP_INDEX)).toBe('first-folder');
    expect(sceneForStep(INVITE_TEAMMATE_STEP_INDEX)).toBe('invite');
    expect(sceneForStep(CONNECTOR_IMPORT_STEP_INDEX)).toBe('connectors');
    const ready = welcomeChrome({ scene: 'ready', replay: false, setupCompleted: true });
    for (const scene of ['first-folder', 'invite', 'connectors'] as const) {
      // Offered from the ready screen: the ticks read as the ready position,
      // with no Back, Skip intro or install card of their own.
      expect(welcomeChrome({ scene, replay: false, setupCompleted: true })).toEqual({
        ...ready,
        back: false,
        skip: null,
        installCard: false,
      });
    }
  });
});

describe('welcome flow chrome and gating', () => {
  it('shows Skip intro only on the two explainers, jumping to the ready screen', () => {
    const skips = STORY_SCENES.map(
      (scene) => welcomeChrome({ scene, replay: false, setupCompleted: false }).skip,
    );
    expect(skips).toEqual([null, null, 'ready', 'ready', null]);
  });

  it('shows Back on screens 1-3 and closes the way back to the folder once installed', () => {
    const backs = STORY_SCENES.map(
      (scene) => welcomeChrome({ scene, replay: false, setupCompleted: false }).back,
    );
    expect(backs).toEqual([false, true, true, true, false]);
    expect(welcomeChrome({ scene: 'cloud', replay: false, setupCompleted: true }).back).toBe(false);
    expect(welcomeChrome({ scene: 'shortcut', replay: false, setupCompleted: true }).back).toBe(true);
  });

  it('shows the install card on the two explainers only, and four ticks from screen 1', () => {
    const cards = STORY_SCENES.map(
      (scene) => welcomeChrome({ scene, replay: false, setupCompleted: false }).installCard,
    );
    expect(cards).toEqual([false, false, true, true, false]);
    const folder = welcomeChrome({ scene: 'folder', replay: false, setupCompleted: false });
    expect(folder).toMatchObject({ ticks: true, tickCount: 4, currentTick: 0 });
    const ready = welcomeChrome({ scene: 'ready', replay: false, setupCompleted: false });
    expect(ready).toMatchObject({ ticks: true, tickCount: 4, currentTick: 3 });
    // The consent-only runs' screen has no story chrome.
    expect(welcomeChrome({ scene: 'consent', replay: false, setupCompleted: false })).toMatchObject({
      ticks: false,
      back: false,
      skip: null,
      installCard: false,
    });
    expect(welcomeChrome({ scene: 'welcome', replay: false, setupCompleted: false }).ticks).toBe(
      false,
    );
  });

  it('labels the forward buttons after the prototype', () => {
    expect(STORY_SCENES.map((scene) => forwardLabel(scene, false))).toEqual([
      null,
      'Install here',
      'Next',
      'Next',
      // The ready screen has no forward button: it finishes by itself.
      null,
    ]);
  });
});

describe('welcome flow chrome with no company step (US-007)', () => {
  const without = { replay: false, setupCompleted: false } as const;

  it('keeps the four-tick strip, with ready on the last tick', () => {
    expect(welcomeChrome({ scene: 'folder', ...without })).toMatchObject({ ticks: true, tickCount: 4, currentTick: 0 });
    expect(welcomeChrome({ scene: 'shortcut', ...without })).toMatchObject({ tickCount: 4, currentTick: 2 });
    expect(welcomeChrome({ scene: 'ready', ...without })).toMatchObject({ tickCount: 4, currentTick: 3 });
    expect(welcomeChrome({ scene: 'invite', ...without, setupCompleted: true })).toMatchObject({
      tickCount: 4,
      currentTick: 3,
    });
  });

  it('goes from the shortcut screen straight to ready', () => {
    expect(nextScene('shortcut', false)).toBe('ready');
    expect(previousScene('ready', false)).toBe('shortcut');
  });
});

describe('replay mode', () => {
  it('shows only the four story screens, with Next and a closing Done', () => {
    expect(REPLAY_SCENES).toEqual(['welcome', 'folder', 'cloud', 'shortcut']);
    expect(nextScene('shortcut', true)).toBe('end');
    expect(nextScene('consent', true)).toBeNull();
    expect(REPLAY_SCENES.map((scene) => forwardLabel(scene, true))).toEqual([
      'Next',
      'Next',
      'Next',
      'Done',
    ]);
  });

  it('never shows the install card, skips to the end, and has three ticks', () => {
    for (const scene of REPLAY_SCENES) {
      const chrome = welcomeChrome({ scene, replay: true, setupCompleted: false });
      expect(chrome.installCard).toBe(false);
      expect(chrome.tickCount).toBe(3);
    }
    expect(
      REPLAY_SCENES.map((scene) => welcomeChrome({ scene, replay: true, setupCompleted: false }).skip),
    ).toEqual(['end', 'end', 'end', null]);
    expect(
      REPLAY_SCENES.map((scene) => welcomeChrome({ scene, replay: true, setupCompleted: false }).back),
    ).toEqual([false, true, true, true]);
  });
});

describe('welcome flow keyboard', () => {
  it('finishes the animation first, then advances', () => {
    expect(welcomeKeyIntent('ArrowRight', { target: 'none', navRevealed: false })).toBe(
      'fast-forward',
    );
    expect(welcomeKeyIntent('ArrowRight', { target: 'none', navRevealed: true })).toBe('advance');
    expect(welcomeKeyIntent(' ', { target: 'none', navRevealed: true })).toBe('advance');
    expect(welcomeKeyIntent('Enter', { target: 'none', navRevealed: false })).toBe('fast-forward');
    expect(welcomeKeyIntent('ArrowLeft', { target: 'none', navRevealed: false })).toBe('back');
    expect(welcomeKeyIntent('Escape', { target: 'field', navRevealed: false })).toBe('escape');
  });

  it('leaves keys aimed at a control to that control', () => {
    // Space / Enter activate the focused button.
    expect(welcomeKeyIntent('Enter', { target: 'button', navRevealed: true })).toBeNull();
    expect(welcomeKeyIntent(' ', { target: 'button', navRevealed: true })).toBeNull();
    // Arrow keys move between the consent radios.
    expect(welcomeKeyIntent('ArrowRight', { target: 'field', navRevealed: true })).toBeNull();
    expect(welcomeKeyIntent('ArrowLeft', { target: 'field', navRevealed: true })).toBeNull();
  });
});

describe('install card', () => {
  it('names the actual current item without a step counter', () => {
    expect(installCardModel({ percent: 0, completed: false, retryText: null, currentItemId: 'content' })).toMatchObject({
      state: 'running',
      title: 'Installing HQ in the background',
      line: 'Setting up your workspace',
      percent: 0,
    });
    expect(installCardModel({ percent: 47, completed: false, retryText: null, currentItemId: 'hq-cli' })).toMatchObject({
      line: 'Installing the hq command',
      percent: 47,
    });
  });

  it.each([null, 'future-item'])('hides the corner activity for an unknown item %s', (currentItemId) => {
    expect(installCardModel({ percent: 30, completed: false, retryText: null, currentItemId }).line).toBe('');
  });

  it('never claims done before every stage has settled', () => {
    expect(installCardModel({ percent: 100, completed: false, retryText: null })).toMatchObject({
      state: 'running',
      percent: 99,
    });
    expect(installCardModel({ percent: 100, completed: true, retryText: null })).toEqual({
      state: 'done',
      title: 'HQ is installed',
      line: 'Keep going, you’re all set.',
      percent: 100,
    });
  });

  it('says so while a stage waits on its automatic retry', () => {
    const model = installCardModel({
      percent: 30,
      completed: false,
      retryText: 'Retrying — attempt 2 of 2…',
    });
    expect(model.state).toBe('retrying');
    expect(model.line).toBe('Retrying — attempt 2 of 2…');
  });

  it('sizes the card for the activity phrases rather than percentage bands', () => {
    expect(installCardActivityLines()).toContain('Installing the hq command');
    expect(installCardActivityLines().join(' ')).not.toContain('Step');
  });
});

describe('ready progress line', () => {
  it('names the running blocking step', () => {
    expect(readyProgressLine({ itemId: 'content', retrying: false, elapsedMs: 0 })).toBe('Setting up your workspace');
    expect(readyProgressLine({ itemId: null, retrying: false, elapsedMs: 0 })).toBe('Setting up HQ');
  });

  it('says when the step is trying again', () => {
    expect(readyProgressLine({ itemId: 'content', retrying: true, elapsedMs: 0 })).toBe(
      'Still setting up your workspace, trying again',
    );
    expect(readyProgressLine({ itemId: 'claude-code', retrying: true, elapsedMs: 0 })).toBe(
      'Still installing Claude Code, trying again',
    );
    expect(readyProgressLine({ itemId: 'future-item', retrying: true, elapsedMs: 0 })).toBe(
      'Still setting up HQ, trying again',
    );
  });

  it('says when the step has run past the still-working threshold', () => {
    expect(readyProgressLine({ itemId: 'deps', retrying: false, elapsedMs: 19_999 })).toBe('Installing your tools');
    expect(readyProgressLine({ itemId: 'deps', retrying: false, elapsedMs: 20_000 })).toBe('Still installing your tools');
  });

  it('names a failed required step in one sentence and ignores an unknown id', () => {
    expect(readyRequiredFailureHeading(['content'])).toBe(
      'Setting up your workspace did not finish.',
    );
    expect(readyRequiredFailureHeading(['git-init'])).toBe(
      'Setting up file history did not finish.',
    );
    expect(readyRequiredFailureHeading(['personalize'])).toBe(
      'Personalizing your workspace did not finish.',
    );
    expect(readyRequiredFailureHeading(['content', 'git-init'])).toBe(
      'Setting up your workspace and setting up file history did not finish.',
    );
    expect(readyRequiredFailureHeading([])).toBeNull();
    expect(readyRequiredFailureHeading(['future-item'])).toBeNull();
    expect(readyRequiredFailureHeading(['content'])).not.toMatch(/[!—]/);
  });

  it('keeps every line in sentence case with no em dash or exclamation mark', () => {
    for (const itemId of ['content', 'git-init', 'personalize', 'deps', null]) {
      for (const retrying of [false, true]) {
        for (const elapsedMs of [0, 60_000]) {
          const line = readyProgressLine({ itemId, retrying, elapsedMs });
          expect(line).toMatch(/^[A-Z]/);
          expect(line).not.toMatch(/[!—…]|Step/);
        }
      }
    }
  });
});
