import {
  emitDesktopTelemetry,
  type DesktopTelemetryProperties,
} from './desktop-telemetry';
import type { StageId } from './onboarding-setup';
import type { WizardStepId } from './onboarding-wizard';

const SCHEMA_VERSION = 1;
const STORAGE_KEY = `hq-sync:onboarding-step-telemetry:v${SCHEMA_VERSION}`;

export type OnboardingAction =
  | 'entered'
  | 'started'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'resumed'
  | 'back';

export type OnboardingFlow = 'first_install' | 'first_launch' | 'resume';
export type OnboardingPlatform = 'macos' | 'windows' | 'linux';

export interface OnboardingStepProperties {
  step: WizardStepId;
  action: OnboardingAction;
  component?: StageId;
  flow?: OnboardingFlow;
  outcome?: string;
  provider?: 'google' | 'microsoft';
  surface: 'desktop_installer';
  platform: OnboardingPlatform;
  durationMs?: number;
  attemptCount?: number;
  detectedToolCount?: number;
  failedStageCount?: number;
}

export interface OnboardingStepEvent {
  sessionId: string;
  occurredAt: string;
  properties: OnboardingStepProperties;
}

export interface RecordOnboardingStep {
  properties: Omit<OnboardingStepProperties, 'surface' | 'platform'>;
  occurredAt?: string;
}

interface PersistedTelemetryState {
  version: number;
  sessionId: string;
  firstLaunchRecorded: boolean;
  collectionDisabled: boolean;
  pending: OnboardingStepEvent[];
}

export interface OnboardingStepTelemetryOptions {
  storage?: Storage | null;
  now?: () => Date;
  newSessionId?: () => string;
  emit?: (event: OnboardingStepEvent) => Promise<void>;
}

export interface OnboardingStepTelemetry {
  readonly sessionId: string;
  record(event: RecordOnboardingStep): void;
  recordFirstLaunch(): void;
  acceptConsent(): Promise<void>;
  discard(): void;
}

/**
 * The wizard's local, bounded pre-consent trace. No telemetry command is
 * invoked until `acceptConsent`; declining empties the queue instead.
 */
export function createOnboardingStepTelemetry(
  options: OnboardingStepTelemetryOptions = {},
): OnboardingStepTelemetry {
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const now = options.now ?? (() => new Date());
  const emit = options.emit ?? emitOnboardingStep;
  let state = loadState(storage, options.newSessionId ?? createUuid);
  let accepted = false;

  function persist(): void {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage failure must never change onboarding behavior.
    }
  }

  function record({ properties, occurredAt }: RecordOnboardingStep): void {
    if (state.collectionDisabled) return;
    const event: OnboardingStepEvent = {
      sessionId: state.sessionId,
      occurredAt: occurredAt ?? now().toISOString(),
      properties: {
        ...properties,
        surface: 'desktop_installer',
        platform: currentPlatform(),
      },
    };
    if (accepted) {
      void emit(event);
      return;
    }
    state.pending.push(event);
    persist();
  }

  return {
    get sessionId() {
      return state.sessionId;
    },
    record,
    recordFirstLaunch() {
      if (state.firstLaunchRecorded) return;
      state.firstLaunchRecorded = true;
      record({
        properties: {
          step: 'welcome-signin',
          action: 'entered',
          flow: 'first_launch',
        },
      });
      persist();
    },
    async acceptConsent() {
      accepted = true;
      const pending = state.pending;
      state = { ...state, pending: [] };
      persist();
      for (const event of pending) {
        await emit(event);
      }
    },
    discard() {
      state = { ...state, pending: [], collectionDisabled: true };
      persist();
    },
  };
}

async function emitOnboardingStep(event: OnboardingStepEvent): Promise<void> {
  const properties: DesktopTelemetryProperties = {
    step: event.properties.step,
    action: event.properties.action,
    surface: event.properties.surface,
    platform: event.properties.platform,
  };
  for (const key of [
    'component',
    'flow',
    'outcome',
    'provider',
    'durationMs',
    'attemptCount',
    'detectedToolCount',
    'failedStageCount',
  ] as const) {
    const value = event.properties[key];
    if (value !== undefined) properties[key] = value;
  }
  await emitDesktopTelemetry({
    eventName: 'desktop_onboarding_step',
    properties,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
  });
}

function loadState(
  storage: Storage | null,
  newSessionId: () => string,
): PersistedTelemetryState {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedTelemetryState>;
      if (
        parsed.version === SCHEMA_VERSION &&
        typeof parsed.sessionId === 'string' &&
        parsed.sessionId.length > 0 &&
        typeof parsed.firstLaunchRecorded === 'boolean' &&
        typeof parsed.collectionDisabled === 'boolean' &&
        Array.isArray(parsed.pending)
      ) {
        return {
          version: SCHEMA_VERSION,
          sessionId: parsed.sessionId,
          firstLaunchRecorded: parsed.firstLaunchRecorded,
          collectionDisabled: parsed.collectionDisabled,
          pending: parsed.pending.filter(isEvent),
        };
      }
    }
  } catch {
    // Corrupt storage starts a fresh local trace.
  }
  return {
    version: SCHEMA_VERSION,
    sessionId: newSessionId(),
    firstLaunchRecorded: false,
    collectionDisabled: false,
    pending: [],
  };
}

function isEvent(value: unknown): value is OnboardingStepEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<OnboardingStepEvent>;
  return (
    typeof event.sessionId === 'string' &&
    typeof event.occurredAt === 'string' &&
    Boolean(event.properties) &&
    typeof event.properties?.step === 'string' &&
    typeof event.properties?.action === 'string'
  );
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function currentPlatform(): OnboardingPlatform {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  return 'linux';
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16);
    return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

export const __INTERNALS__ = { STORAGE_KEY, SCHEMA_VERSION };
