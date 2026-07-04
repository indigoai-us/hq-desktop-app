export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export interface WizardState {
  installPath: string | null;
}

export const WIZARD_STEPS: WizardStep[] = [
  { index: 0, id: 'welcome-signin', label: 'Welcome' },
  { index: 1, id: 'directory', label: 'Location' },
  { index: 2, id: 'setup', label: 'Setup' },
  { index: 3, id: 'ready', label: 'Ready' },
  { index: 4, id: 'trust', label: 'Trust' },
  { index: 5, id: 'settings', label: 'Settings' },
  { index: 6, id: 'run-setup', label: 'Run setup' },
  { index: 7, id: 'handoff', label: 'Handoff' },
  { index: 8, id: 'build', label: 'Build' },
];

const FIRST_STEP_INDEX = WIZARD_STEPS[0].index;
const SETUP_STEP_INDEX = 2;
const FINAL_STEP_INDEX = WIZARD_STEPS[WIZARD_STEPS.length - 1].index;
const completedSteps = new Set<number>();

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
    case 1:
      return state.installPath !== null && state.installPath.length > 0;
    case SETUP_STEP_INDEX:
      return false;
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
      return 0;
    case 'InstallResume':
      return 2;
    default:
      return 0;
  }
}
