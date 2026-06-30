export interface WizardStep {
  index: number;
  id: string;
  label: string;
}

export interface WizardState {
  installPath: string | null;
}

export const WIZARD_STEPS: WizardStep[] = [
  { index: 1, id: 'welcome', label: 'Welcome' },
  { index: 2, id: 'install', label: 'Install' },
  { index: 3, id: 'signin', label: 'Sign In' },
  { index: 4, id: 'setup', label: 'Setup' },
  { index: 5, id: 'done', label: 'Done' },
];

const SETUP_STEP_INDEX = 4;
const TOTAL_STEPS = WIZARD_STEPS.length;
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
    case 2:
      return state.installPath !== null && state.installPath.length > 0;
    case 4:
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
    opts.start !== undefined && opts.start >= 1 && opts.start <= TOTAL_STEPS
      ? opts.start
      : 1;

  function isAuthGated(step: number): boolean {
    return AUTH_GATED_STEPS.includes(step);
  }

  function isCompletedGate(step: number): boolean {
    return step === SETUP_STEP_INDEX && completedSteps.has(SETUP_STEP_INDEX);
  }

  const router: WizardRouter = {
    get currentStep() {
      return current;
    },

    next() {
      if (current < TOTAL_STEPS) {
        current += 1;
      }
    },

    back() {
      if (current <= 1) return;
      if (isAuthGated(current)) return;
      current -= 1;
    },

    get canGoBack() {
      return current > 1 && !isAuthGated(current);
    },

    canGoNext(state: Readonly<WizardState>) {
      return current < TOTAL_STEPS && getStepValidity(current, state);
    },

    goTo(step: number) {
      if (step >= 1 && step <= TOTAL_STEPS && !isCompletedGate(step)) {
        current = step;
      }
    },

    canNavigateTo(target: number) {
      if (target < 1 || target > TOTAL_STEPS) return false;
      if (target === current) return false;
      if (isCompletedGate(target)) return false;
      if (target < current) {
        for (const gate of AUTH_GATED_STEPS) {
          if (target < gate && gate <= current) return false;
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
      return 3;
    case 'InstallResume':
      return 4;
    default:
      return 1;
  }
}
