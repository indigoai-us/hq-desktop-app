/**
 * The welcome flow: first-run onboarding and the welcome story as one
 * five-screen sequence (designer prototype `hq-welcome-flow`).
 *
 *   0 welcome   particle HQ mark + sign in           (wizard step welcome-signin)
 *   1 folder    "It's a folder" + where HQ lives      (wizard step directory)
 *   2 cloud     company cloud orbit                   (wizard step setup; install runs)
 *   3 shortcut  the Option-Shift-O keyboard           (wizard step setup; install runs)
 *   4 ready     "HQ is ready." + Open HQ Desktop,     (wizard step ready)
 *               the Claude Code / Codex options and
 *               the usage-data checkbox
 *
 * The usage-data question is not a screen of its own in the first-run flow:
 * it is one checkbox line on the ready screen, recorded when the person
 * finishes. The `consent` scene is still the whole of the consent-only runs
 * (the US-005 re-prompt, an installed machine missing its answer).
 *
 * The wizard's own step model (router, step telemetry ids, resume entry
 * points) is unchanged underneath: this module only maps it onto screens and
 * owns the chrome rules, so they can be tested without mounting anything.
 *
 * `company` (name a company or join an invite, then pick a plan, for anyone
 * with no company yet), `first-folder` (the optional, flag-gated first-folder
 * sync), `invite` (the
 * optional, flag-gated teammate invite), `connectors` (the optional Claude
 * Desktop connector import) and the post-ready tutorial steps are not story
 * screens. They keep their own panels and sit outside the five-tick progress.
 * The three optional steps are offered from the ready screen once the install
 * is done, in that order.
 */
import {
  BUILD_STEP_INDEX,
  COMPANY_STEP_INDEX,
  CONNECTOR_IMPORT_STEP_INDEX,
  CONSENT_STEP_INDEX,
  DIRECTORY_STEP_INDEX,
  FIRST_FOLDER_SYNC_STEP_INDEX,
  HANDOFF_STEP_INDEX,
  INVITE_TEAMMATE_STEP_INDEX,
  READY_STEP_INDEX,
  RUN_SETUP_STEP_INDEX,
  SETTINGS_STEP_INDEX,
  SETUP_STEP_INDEX,
  TRUST_STEP_INDEX,
  WELCOME_SIGNIN_STEP_INDEX,
} from './onboarding-wizard';
import { setupStepSummary } from './onboarding-setup';

export const STORY_SCENES = ['welcome', 'folder', 'cloud', 'shortcut', 'ready'] as const;
export type StorySceneId = (typeof STORY_SCENES)[number];

/** The menu-bar "Replay welcome intro": the story screens only. */
export const REPLAY_SCENES = ['welcome', 'folder', 'cloud', 'shortcut'] as const;

export type TutorialSceneId = 'trust' | 'settings' | 'run-setup' | 'handoff' | 'build';
/** The optional steps offered from the ready screen once the install is done. */
export type FollowOnSceneId = 'company' | 'first-folder' | 'invite' | 'connectors';
export type SceneId = StorySceneId | 'consent' | FollowOnSceneId | TutorialSceneId;

/**
 * How long each screen's progress tick takes to fill. Nothing auto-advances:
 * every screen waits for Next. The hold only keeps a screen reading as
 * "playing" (prototype BEATS).
 */
export const SCENE_HOLD_MS: Record<StorySceneId, number> = {
  welcome: 4800,
  folder: 8000,
  cloud: 11000,
  shortcut: 9000,
  ready: 11000,
};

export function sceneForStep(step: number): SceneId {
  switch (step) {
    case WELCOME_SIGNIN_STEP_INDEX:
      return 'welcome';
    case DIRECTORY_STEP_INDEX:
      return 'folder';
    case SETUP_STEP_INDEX:
      return 'cloud';
    case COMPANY_STEP_INDEX:
      return 'company';
    case FIRST_FOLDER_SYNC_STEP_INDEX:
      return 'first-folder';
    case INVITE_TEAMMATE_STEP_INDEX:
      return 'invite';
    case CONSENT_STEP_INDEX:
      return 'consent';
    case CONNECTOR_IMPORT_STEP_INDEX:
      return 'connectors';
    case READY_STEP_INDEX:
      return 'ready';
    case TRUST_STEP_INDEX:
      return 'trust';
    case SETTINGS_STEP_INDEX:
      return 'settings';
    case RUN_SETUP_STEP_INDEX:
      return 'run-setup';
    case HANDOFF_STEP_INDEX:
      return 'handoff';
    case BUILD_STEP_INDEX:
      return 'build';
    default:
      return 'welcome';
  }
}

export function stepForScene(scene: SceneId): number {
  switch (scene) {
    case 'welcome':
      return WELCOME_SIGNIN_STEP_INDEX;
    case 'folder':
      return DIRECTORY_STEP_INDEX;
    case 'cloud':
    case 'shortcut':
      // Both explainers play while the install runs: to the wizard they are
      // the setup step.
      return SETUP_STEP_INDEX;
    case 'company':
      return COMPANY_STEP_INDEX;
    case 'first-folder':
      return FIRST_FOLDER_SYNC_STEP_INDEX;
    case 'invite':
      return INVITE_TEAMMATE_STEP_INDEX;
    case 'consent':
      return CONSENT_STEP_INDEX;
    case 'connectors':
      return CONNECTOR_IMPORT_STEP_INDEX;
    case 'ready':
      return READY_STEP_INDEX;
    case 'trust':
      return TRUST_STEP_INDEX;
    case 'settings':
      return SETTINGS_STEP_INDEX;
    case 'run-setup':
      return RUN_SETUP_STEP_INDEX;
    case 'handoff':
      return HANDOFF_STEP_INDEX;
    case 'build':
      return BUILD_STEP_INDEX;
  }
}

export function isStoryScene(scene: SceneId): scene is StorySceneId {
  return (STORY_SCENES as readonly string[]).includes(scene);
}

/**
 * Position on the story strip (0-4), or null off it. The optional follow-on
 * steps (first-folder sync, teammate invite, connector import) are offered
 * from the ready screen, so they read as the ready position.
 */
export function storyIndex(scene: SceneId): number | null {
  if (
    scene === 'company' ||
    scene === 'first-folder' ||
    scene === 'invite' ||
    scene === 'connectors'
  ) {
    return STORY_SCENES.indexOf('ready');
  }
  return isStoryScene(scene) ? STORY_SCENES.indexOf(scene) : null;
}

/** The story order the flow walks through. */
export function storyScenes(replay: boolean): readonly StorySceneId[] {
  return replay ? REPLAY_SCENES : STORY_SCENES;
}

/** The next story screen, `'end'` past the last one, or null off the story. */
export function nextScene(scene: SceneId, replay: boolean): StorySceneId | 'end' | null {
  if (!isStoryScene(scene)) return null;
  const order = storyScenes(replay);
  const index = order.indexOf(scene);
  if (index === -1) return null;
  return index + 1 < order.length ? order[index + 1]! : 'end';
}

export function previousScene(scene: SceneId, replay: boolean): StorySceneId | null {
  if (!isStoryScene(scene)) return null;
  const order = storyScenes(replay);
  const index = order.indexOf(scene);
  return index > 0 ? order[index - 1]! : null;
}

export interface WelcomeChromeInput {
  scene: SceneId;
  replay: boolean;
  /** The install finished: the folder can no longer be changed from here. */
  setupCompleted: boolean;
}

export interface WelcomeChrome {
  /** Top-right progress ticks. */
  ticks: boolean;
  /** Number of ticks (every screen after the first). */
  tickCount: number;
  /** 0-based tick that is current, or -1. */
  currentTick: number;
  /** Quiet Back, bottom-left. */
  back: boolean;
  /** "Skip intro": what it skips to, if shown. */
  skip: 'ready' | 'end' | null;
  /** The corner "Installing HQ in the background" card. */
  installCard: boolean;
}

/**
 * Per-screen chrome, after the prototype's NAV / REPLAY_NAV tables.
 *
 * Skip intro appears only where there is something optional to skip: the two
 * explainers, where it jumps to the ready screen. Screens that need an answer
 * have no Skip. The install card lives on the explainers only; the ready
 * screen shows the same progress in its own capsule.
 */
export function welcomeChrome({ scene, replay, setupCompleted }: WelcomeChromeInput): WelcomeChrome {
  const order = storyScenes(replay);
  const index = storyIndex(scene);
  const tickCount = order.length - 1;
  if (index === null) {
    return { ticks: false, tickCount, currentTick: -1, back: false, skip: null, installCard: false };
  }
  const ticks = index > 0;
  const currentTick = index - 1;
  if (replay) {
    return {
      ticks,
      tickCount,
      currentTick,
      back: index >= 1 && index <= 3,
      skip: index <= 2 ? 'end' : null,
      installCard: false,
    };
  }
  let back = scene === 'folder' || scene === 'shortcut';
  // Back from the first explainer is Back to the folder choice, which cancels
  // a running install so the folder can change. Once the install is done the
  // folder is final, so that way back closes.
  if (scene === 'cloud') back = !setupCompleted;
  return {
    ticks,
    tickCount,
    currentTick,
    back,
    skip: scene === 'cloud' || scene === 'shortcut' ? 'ready' : null,
    installCard: scene === 'cloud' || scene === 'shortcut',
  };
}

/** The label on each screen's forward button. */
export function forwardLabel(scene: StorySceneId, replay: boolean): string | null {
  if (replay) return scene === 'shortcut' ? 'Done' : 'Next';
  switch (scene) {
    case 'welcome':
      // Sign-in is the way forward here.
      return null;
    case 'folder':
      return 'Install here';
    case 'cloud':
    case 'shortcut':
      return 'Next';
    case 'ready':
      return 'Open HQ Desktop';
  }
}

export type WelcomeKeyIntent = 'advance' | 'fast-forward' | 'back' | 'escape' | null;

/**
 * What a key press means on the backdrop.
 *
 * The first press finishes the screen's animation, the next moves on (only
 * once the forward button has arrived). Keys aimed at a control belong to that
 * control: Space and Enter activate a focused button, and the arrow keys move
 * between the consent radios.
 */
export function welcomeKeyIntent(
  key: string,
  context: { target: 'none' | 'button' | 'field'; navRevealed: boolean },
): WelcomeKeyIntent {
  if (key === 'Escape') return 'escape';
  if (context.target === 'field') return null;
  if (key === 'ArrowLeft') return 'back';
  if (key === 'ArrowRight') return context.navRevealed ? 'advance' : 'fast-forward';
  if (key === ' ' || key === 'Enter') {
    if (context.target === 'button') return null;
    return context.navRevealed ? 'advance' : 'fast-forward';
  }
  return null;
}

export interface InstallCardInput {
  /** The tracked (never-backward) setup percent. */
  percent: number;
  /** Every stage settled (the wizard's `setupCompleted`). */
  completed: boolean;
  /** The auto-retry notice for the running stage, when it is waiting on one. */
  retryText: string | null;
}

export interface InstallCardModel {
  state: 'running' | 'retrying' | 'done';
  title: string;
  line: string;
  /** Bar fill, 0-100. */
  percent: number;
  step: number;
  total: number;
}

export const INSTALL_CARD_TITLE = 'Installing HQ in the background';
export const INSTALL_CARD_DONE_TITLE = 'HQ is installed';
export const INSTALL_CARD_DONE_LINE = 'Keep going, you’re all set.';
export const READY_PROGRESS_DONE_TEXT = 'Installed and synced across your devices.';

/**
 * The corner card and the ready screen's capsule, driven by the install's real
 * progress. A stage waiting on its automatic retry says so in place of the
 * step line; failures that remain once every stage has settled are recorded
 * for the setup skill and never shown here (seamless completion).
 */
export function installCardModel({ percent, completed, retryText }: InstallCardInput): InstallCardModel {
  const summary = setupStepSummary(completed ? 100 : Math.min(99, percent));
  if (completed) {
    return {
      state: 'done',
      title: INSTALL_CARD_DONE_TITLE,
      line: INSTALL_CARD_DONE_LINE,
      percent: 100,
      step: summary.total,
      total: summary.total,
    };
  }
  const stepLine = `Step ${summary.step} of ${summary.total} · ${summary.compactLabel}`;
  return {
    state: retryText ? 'retrying' : 'running',
    title: INSTALL_CARD_TITLE,
    line: retryText ?? stepLine,
    percent: Math.max(0, Math.min(99, percent)),
    step: summary.step,
    total: summary.total,
  };
}

/** Every step line the card can show, so it can be sized once to the longest. */
export function installCardStepLines(): string[] {
  const lines: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    const summary = setupStepSummary(step * 20);
    lines.push(`Step ${summary.step} of ${summary.total} · ${summary.compactLabel}`);
  }
  return lines;
}

export interface ReadyGateInput {
  /** An install this flow started is still running. */
  installPending: boolean;
  /**
   * The held usage-data answer: `pending` while it waits to be sent or is
   * being sent, `blocked` after a server failure that needs a retry.
   */
  consent: 'clear' | 'pending' | 'blocked';
  finishing: boolean;
  /** A tool launch is in flight (not the Claude readiness watch). */
  launching: boolean;
}

/** Whether Open HQ Desktop can be pressed, and what it says. */
export function readyGate({ installPending, consent, finishing, launching }: ReadyGateInput): {
  enabled: boolean;
  label: string;
} {
  if (finishing) return { enabled: false, label: 'Opening…' };
  if (installPending || consent === 'pending') return { enabled: false, label: 'Getting ready…' };
  return { enabled: consent === 'clear' && !launching, label: 'Open HQ Desktop' };
}
