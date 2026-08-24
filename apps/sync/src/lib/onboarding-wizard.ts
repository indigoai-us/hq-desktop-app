export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export interface WizardState {
  installPath: string | null;
  /**
   * Whether the telemetry consent question has been answered. Starts `false`
   * (genuinely unanswered — no pre-selected option) so the consent step's
   * continue action stays disabled until the person picks share or decline.
   */
  consentAnswered: boolean;
}

export const WIZARD_STEPS = [
  { index: 0, id: 'welcome-signin', label: 'Welcome' },
  { index: 1, id: 'directory', label: 'Location' },
  { index: 2, id: 'setup', label: 'Setup' },
  // Consent is its own step, placed AFTER setup: the person entity is
  // provisioned during setup, so by the time we ask, the opt-in write has an
  // entity to land on (the old sign-in-panel checkbox posted before the entity
  // existed, so the answer 404'd and was silently dropped).
  { index: 3, id: 'consent', label: 'Consent' },
  // This runs after setup has made `hq` available, but before final handoff.
  // It auto-skips when Claude Desktop has no configured connectors.
  { index: 4, id: 'connector-import', label: 'Import connectors' },
  { index: 5, id: 'ready', label: 'Ready' },
  { index: 6, id: 'trust', label: 'Trust workspace' },
  { index: 7, id: 'settings', label: 'Settings' },
  { index: 8, id: 'run-setup', label: 'Run setup' },
  { index: 9, id: 'handoff', label: 'Handoff' },
  { index: 10, id: 'build', label: 'Build' },
] as const satisfies readonly WizardStep[];

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/**
 * The sole index mapping for wizard panels, graphics, and router transitions.
 * Keep panel identifiers in `WIZARD_STEPS`; do not hand-number a panel.
 */
export const WIZARD_STEP_INDEX = Object.fromEntries(
  WIZARD_STEPS.map((step) => [step.id, step.index]),
) as Record<WizardStepId, number>;

const FIRST_STEP_INDEX = WIZARD_STEPS[0].index;
const WELCOME_SIGNIN_STEP_INDEX = WIZARD_STEP_INDEX['welcome-signin'];
const DIRECTORY_STEP_INDEX = WIZARD_STEP_INDEX.directory;
const SETUP_STEP_INDEX = WIZARD_STEP_INDEX.setup;
const CONSENT_STEP_INDEX = WIZARD_STEP_INDEX.consent;
const CONNECTOR_IMPORT_STEP_INDEX = WIZARD_STEP_INDEX['connector-import'];
const READY_STEP_INDEX = WIZARD_STEP_INDEX.ready;
const TRUST_STEP_INDEX = WIZARD_STEP_INDEX.trust;
const SETTINGS_STEP_INDEX = WIZARD_STEP_INDEX.settings;
const RUN_SETUP_STEP_INDEX = WIZARD_STEP_INDEX['run-setup'];
const HANDOFF_STEP_INDEX = WIZARD_STEP_INDEX.handoff;
const BUILD_STEP_INDEX = WIZARD_STEP_INDEX.build;
const FINAL_STEP_INDEX = WIZARD_STEPS[WIZARD_STEPS.length - 1].index;
const completedSteps = new Set<number>();

export {
  BUILD_STEP_INDEX,
  CONNECTOR_IMPORT_STEP_INDEX,
  CONSENT_STEP_INDEX,
  DIRECTORY_STEP_INDEX,
  HANDOFF_STEP_INDEX,
  READY_STEP_INDEX,
  RUN_SETUP_STEP_INDEX,
  SETTINGS_STEP_INDEX,
  SETUP_STEP_INDEX,
  TRUST_STEP_INDEX,
  WELCOME_SIGNIN_STEP_INDEX,
};

export const AUTH_GATED_STEPS: number[] = [SETUP_STEP_INDEX];

export function markSetupStepCompleted(): void {
  completedSteps.add(SETUP_STEP_INDEX);
}

export function __resetWizardRouterCompletionForTests(): void {
  completedSteps.clear();
}

export function getStepValidity(
  step: number,
  state: Readonly<WizardState>,
): boolean {
  switch (step) {
    case DIRECTORY_STEP_INDEX:
      return state.installPath !== null && state.installPath.length > 0;
    case SETUP_STEP_INDEX:
      return false;
    case CONSENT_STEP_INDEX:
      // Continue is disabled until the person answers the telemetry question.
      // No option is pre-selected, so this is false on first render.
      return state.consentAnswered;
    default:
      return true;
  }
}

export interface WizardRouter {
  currentStep: number;
  next(): void;
  back(): void;
  canGoBack: boolean;
  canGoNext(state: Readonly<WizardState>): boolean;
  goTo(step: number): void;
  canNavigateTo(target: number): boolean;
}

export function createWizardRouter(opts: { start?: number } = {}): WizardRouter {
  let current =
    opts.start !== undefined &&
    opts.start >= FIRST_STEP_INDEX &&
    opts.start <= FINAL_STEP_INDEX
      ? opts.start
      : FIRST_STEP_INDEX;

  function isAuthGated(step: number): boolean {
    return AUTH_GATED_STEPS.includes(step);
  }

  function isCompletedGate(step: number): boolean {
    return step <= SETUP_STEP_INDEX && completedSteps.has(SETUP_STEP_INDEX);
  }

  const router: WizardRouter = {
    get currentStep() {
      return current;
    },

    next() {
      if (current < FINAL_STEP_INDEX) {
        current += 1;
      }
    },

    back() {
      if (current <= FIRST_STEP_INDEX) return;
      if (isAuthGated(current) && completedSteps.has(SETUP_STEP_INDEX)) return;
      current -= 1;
    },

    get canGoBack() {
      return (
        current > FIRST_STEP_INDEX &&
        !(isAuthGated(current) && completedSteps.has(SETUP_STEP_INDEX))
      );
    },

    canGoNext(state: Readonly<WizardState>) {
      return current < FINAL_STEP_INDEX && getStepValidity(current, state);
    },

    goTo(step: number) {
      if (
        step >= FIRST_STEP_INDEX &&
        step <= FINAL_STEP_INDEX &&
        !isCompletedGate(step)
      ) {
        current = step;
      }
    },

    canNavigateTo(target: number) {
      if (target < FIRST_STEP_INDEX || target > FINAL_STEP_INDEX) return false;
      if (target === current) return false;
      if (isCompletedGate(target)) return false;
      if (target < current) {
        for (const gate of AUTH_GATED_STEPS) {
          if (
            completedSteps.has(gate) &&
            target < gate &&
            gate <= current
          ) {
            return false;
          }
        }
      }
      return true;
    },
  };

  return router;
}

export function initialStepForLifecycle(state: string): number {
  switch (state) {
    case 'NeedsAuthForInstall':
      return WELCOME_SIGNIN_STEP_INDEX;
    case 'InstallResume':
      return SETUP_STEP_INDEX;
    default:
      return WELCOME_SIGNIN_STEP_INDEX;
  }
}
