import { describe, expect, it } from 'vitest';

import {
  CONSENT_STEP_INDEX,
  DIRECTORY_STEP_INDEX,
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
  installCardStepLines,
  nextScene,
  previousScene,
  readyGate,
  sceneForStep,
  stepForScene,
  welcomeChrome,
  welcomeKeyIntent,
} from './welcome-flow';

describe('welcome flow scene order', () => {
  it('walks welcome, folder, cloud, shortcut, consent, ready in that order', () => {
    expect(STORY_SCENES).toEqual(['welcome', 'folder', 'cloud', 'shortcut', 'consent', 'ready']);
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
    expect(previousScene('consent', false)).toBe('shortcut');
    expect(previousScene('connectors', false)).toBeNull();
  });
});

describe('welcome flow chrome and gating', () => {
  it('shows Skip intro only on the two explainers, jumping to consent', () => {
    const skips = STORY_SCENES.map(
      (scene) => welcomeChrome({ scene, replay: false, setupCompleted: false }).skip,
    );
    expect(skips).toEqual([null, null, 'consent', 'consent', null, null]);
  });

  it('shows Back on screens 1-4 and closes the way back to the folder once installed', () => {
    const backs = STORY_SCENES.map(
      (scene) => welcomeChrome({ scene, replay: false, setupCompleted: false }).back,
    );
    expect(backs).toEqual([false, true, true, true, true, false]);
    expect(welcomeChrome({ scene: 'cloud', replay: false, setupCompleted: true }).back).toBe(false);
    expect(welcomeChrome({ scene: 'shortcut', replay: false, setupCompleted: true }).back).toBe(true);
  });

  it('shows the install card on screens 2-4 only, and five ticks from screen 1', () => {
    const cards = STORY_SCENES.map(
      (scene) => welcomeChrome({ scene, replay: false, setupCompleted: false }).installCard,
    );
    expect(cards).toEqual([false, false, true, true, true, false]);
    const folder = welcomeChrome({ scene: 'folder', replay: false, setupCompleted: false });
    expect(folder).toMatchObject({ ticks: true, tickCount: 5, currentTick: 0 });
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
      'Continue',
      'Open HQ Desktop',
    ]);
  });

  it('keeps Open HQ Desktop disabled until the install is done', () => {
    expect(readyGate({ installPending: true, consent: 'clear', finishing: false, launching: false }))
      .toEqual({ enabled: false, label: 'Getting ready…' });
    expect(readyGate({ installPending: false, consent: 'clear', finishing: false, launching: false }))
      .toEqual({ enabled: true, label: 'Open HQ Desktop' });
  });

  it('holds Open HQ Desktop while a held consent answer is sent, and after a server failure', () => {
    expect(
      readyGate({ installPending: false, consent: 'pending', finishing: false, launching: false }),
    ).toEqual({ enabled: false, label: 'Getting ready…' });
    expect(
      readyGate({ installPending: false, consent: 'blocked', finishing: false, launching: false }),
    ).toEqual({ enabled: false, label: 'Open HQ Desktop' });
    expect(
      readyGate({ installPending: false, consent: 'clear', finishing: true, launching: false }),
    ).toEqual({ enabled: false, label: 'Opening…' });
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
  it('reads the real setup progress as Step N of 5', () => {
    expect(installCardModel({ percent: 0, completed: false, retryText: null })).toMatchObject({
      state: 'running',
      title: 'Installing HQ in the background',
      line: 'Step 1 of 5 · Laying the groundwork',
      percent: 0,
    });
    expect(installCardModel({ percent: 47, completed: false, retryText: null })).toMatchObject({
      line: 'Step 3 of 5 · Bringing in your AI workers',
      percent: 47,
    });
  });

  it('never claims done before every stage has settled', () => {
    expect(installCardModel({ percent: 100, completed: false, retryText: null })).toMatchObject({
      state: 'running',
      percent: 99,
      step: 5,
    });
    expect(installCardModel({ percent: 100, completed: true, retryText: null })).toEqual({
      state: 'done',
      title: 'HQ is installed',
      line: 'Keep going, you’re all set.',
      percent: 100,
      step: 5,
      total: 5,
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
    expect(model.step).toBe(2);
  });

  it('lists every step line so the card can hold one width', () => {
    expect(installCardStepLines()).toEqual([
      'Step 1 of 5 · Laying the groundwork',
      'Step 2 of 5 · Building your workspace',
      'Step 3 of 5 · Bringing in your AI workers',
      'Step 4 of 5 · Making it yours',
      'Step 5 of 5 · Syncing across your devices',
    ]);
  });
});
