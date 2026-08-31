import {
  emitDesktopTelemetryStrict,
  type DesktopTelemetryProperties,
} from './desktop-telemetry';
import type { StageId } from './onboarding-setup';
import type { WizardStepId } from './onboarding-wizard';

const SCHEMA_VERSION = 2;
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
  /** Local-only account partition; it is never included in telemetry. */
  ownerAccountId: string | null;
  /** The user opted in and the consent record reached the server. */
  consentConfirmed: boolean;
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
  /**
   * Tie a persisted trace to the authenticated account. A different account
   * starts a fresh trace so pre-consent interactions never cross accounts.
   */
  bindAccount(accountId: string | null | undefined): void;
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
  let flushPromise: Promise<void> | null = null;

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
    state.pending.push(event);
    persist();
    if (state.consentConfirmed) void flushPending().catch(() => {});
  }

  function resetForAccount(accountId: string): void {
    state = {
      version: SCHEMA_VERSION,
      sessionId: (options.newSessionId ?? createUuid)(),
      // First launch is a device fact, not an account fact; never record it
      // again merely because the account changed.
      firstLaunchRecorded: state.firstLaunchRecorded,
      collectionDisabled: false,
      ownerAccountId: accountId,
      consentConfirmed: false,
      pending: [],
    };
    persist();
  }

  function bindAccount(accountId: string | null | undefined): void {
    const normalized = accountId?.trim();
    // Without a stable authenticated identity, retaining a device-wide buffer
    // could later associate it with a different person. Drop it fail-closed.
    if (!normalized) {
      if (state.pending.length > 0) {
        state = { ...state, pending: [], consentConfirmed: false };
        persist();
      }
      return;
    }
    if (state.ownerAccountId && state.ownerAccountId !== normalized) {
      resetForAccount(normalized);
      return;
    }
    if (state.ownerAccountId !== normalized) {
      state = { ...state, ownerAccountId: normalized };
      persist();
    }
    if (state.consentConfirmed) void flushPending().catch(() => {});
  }

  async function flushPending(): Promise<void> {
    if (!state.consentConfirmed || !state.ownerAccountId) return;
    if (flushPromise) return flushPromise;

    const flush = (async () => {
      // Remove each event only after its own successful command invocation.
      // A transient error therefore leaves the failed event and every later
      // event durably queued for a retry, without duplicating prior successes.
      while (state.pending.length > 0) {
        const event = state.pending[0];
        await emit(event);
        state = { ...state, pending: state.pending.slice(1) };
        persist();
      }
    })();
    flushPromise = flush.finally(() => {
      flushPromise = null;
    });
    return flushPromise;
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
    bindAccount,
    async acceptConsent() {
      if (state.collectionDisabled) return;
      state = { ...state, consentConfirmed: true };
      persist();
      await flushPending();
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
  await emitDesktopTelemetryStrict({
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
        (typeof parsed.ownerAccountId === 'string' || parsed.ownerAccountId === null) &&
        typeof parsed.consentConfirmed === 'boolean' &&
        Array.isArray(parsed.pending)
      ) {
        return {
          version: SCHEMA_VERSION,
          sessionId: parsed.sessionId,
          firstLaunchRecorded: parsed.firstLaunchRecorded,
          collectionDisabled: parsed.collectionDisabled,
          ownerAccountId: parsed.ownerAccountId,
          consentConfirmed: parsed.consentConfirmed,
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
    ownerAccountId: null,
    consentConfirmed: false,
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
