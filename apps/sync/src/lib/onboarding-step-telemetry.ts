import {
  emitDesktopOperationalTelemetryStrict,
  type DesktopTelemetryProperties,
} from './desktop-telemetry';
import {
  installerStepsForOnboarding,
  isInstallerPersonUid,
  pingInstallerStep,
} from './installer-step-telemetry';
import type { StageId } from './onboarding-setup';
import type { WizardStepId } from './onboarding-wizard';

const SCHEMA_VERSION = 3;
const STORAGE_KEY = `hq-sync:onboarding-step-telemetry:v${SCHEMA_VERSION}`;
const LEGACY_STORAGE_KEY = 'hq-sync:onboarding-step-telemetry:v2';

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
  /** Operational records waiting only for an authenticated transport. */
  pending: OnboardingStepEvent[];
}

export interface InstallerStepPingPayload {
  installSessionId: string;
  step: string;
  personUid?: string;
}

export interface OnboardingStepTelemetryOptions {
  storage?: Storage | null;
  now?: () => Date;
  newSessionId?: () => string;
  emit?: (event: OnboardingStepEvent) => Promise<void>;
  /**
   * Anonymous pre-auth funnel ping. Defaults to POST /v1/installer/step.
   * Injected in tests. Must never throw into the wizard.
   */
  pingInstallerStep?: (payload: InstallerStepPingPayload) => void;
}

export interface OnboardingStepTelemetry {
  readonly sessionId: string;
  record(event: RecordOnboardingStep): void;
  recordFirstLaunch(): void;
  /** Retry records that could not be delivered before authentication existed. */
  flush(): Promise<void>;
  /**
   * Attach the signed-in vault person so later anonymous pings stitch onto
   * `install-person-index` / `installer_<step>` journey milestones.
   */
  setPersonUid(personUid: string): void;
}

/**
 * The wizard's installation trace. Setup state is operational telemetry, so
 * each event is independent of the skill-telemetry preference. Before
 * authentication exists, records wait in a durable delivery queue; that queue
 * waits only for transport, never for a consent answer.
 */
export function createOnboardingStepTelemetry(
  options: OnboardingStepTelemetryOptions = {},
): OnboardingStepTelemetry {
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const now = options.now ?? (() => new Date());
  const emit = options.emit ?? emitOnboardingStep;
  const ping =
    options.pingInstallerStep ??
    ((payload: InstallerStepPingPayload) => {
      void pingInstallerStep(payload).catch(() => {});
    });
  let state = loadState(storage, options.newSessionId ?? createUuid);
  let flushPromise: Promise<void> | null = null;
  let personUid: string | undefined;

  function persist(): void {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage failure must never change onboarding behavior.
    }
  }

  function record({ properties, occurredAt }: RecordOnboardingStep): void {
    const event: OnboardingStepEvent = {
      sessionId: state.sessionId,
      occurredAt: occurredAt ?? now().toISOString(),
      properties: {
        ...properties,
        surface: 'desktop_installer',
        platform: currentPlatform(),
      },
    };
    state = { ...state, pending: [...state.pending, event] };
    persist();
    fireInstallerPings(event);
    void flush().catch(() => {});
  }

  function fireInstallerPings(event: OnboardingStepEvent): void {
    try {
      const steps = installerStepsForOnboarding({
        step: event.properties.step,
        action: event.properties.action,
        flow: event.properties.flow,
      });
      for (const step of steps) {
        ping({
          installSessionId: event.sessionId,
          step,
          personUid,
        });
      }
    } catch {
      // Anonymous pings must never affect the wizard or the authenticated queue.
    }
  }

  async function flush(): Promise<void> {
    if (flushPromise) return flushPromise;

    const pendingFlush = (async () => {
      // Keep each event until its command succeeds. A missing pre-auth token
      // stops the drain, and a later authenticated retry resumes in order.
      while (state.pending.length > 0) {
        await emit(state.pending[0]!);
        state = { ...state, pending: state.pending.slice(1) };
        persist();
      }
    })();
    flushPromise = pendingFlush.finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  return {
    get sessionId() {
      return state.sessionId;
    },
    record,
    flush,
    setPersonUid(nextPersonUid: string) {
      const trimmed = nextPersonUid.trim();
      if (!isInstallerPersonUid(trimmed)) return;
      personUid = trimmed;
    },
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
  await emitDesktopOperationalTelemetryStrict({
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
    const current = parseState(storage?.getItem(STORAGE_KEY), SCHEMA_VERSION);
    if (current) return current;

    const legacy = parseState(storage?.getItem(LEGACY_STORAGE_KEY), 2);
    if (legacy) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(legacy));
        storage?.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // Retaining the v2 entry is safe: its compatible data is still in use.
      }
      return legacy;
    }
  } catch {
    // Corrupt storage starts a fresh local trace.
  }
  return {
    version: SCHEMA_VERSION,
    sessionId: newSessionId(),
    firstLaunchRecorded: false,
    pending: [],
  };
}

function parseState(raw: string | null | undefined, version: number): PersistedTelemetryState | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<PersistedTelemetryState>;
  if (
    parsed.version !== version ||
    typeof parsed.sessionId !== 'string' ||
    parsed.sessionId.length === 0 ||
    typeof parsed.firstLaunchRecorded !== 'boolean'
  ) {
    return null;
  }
  return {
    version: SCHEMA_VERSION,
    sessionId: parsed.sessionId,
    firstLaunchRecorded: parsed.firstLaunchRecorded,
    pending: Array.isArray(parsed.pending) ? parsed.pending.filter(isEvent) : [],
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

export const __INTERNALS__ = { STORAGE_KEY, LEGACY_STORAGE_KEY, SCHEMA_VERSION };
