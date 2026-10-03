import {
  normalizeHttpStatus,
  normalizeInviteErrorKind,
  type InviteErrorKind,
} from './onboarding-invite';
import {
  emitDesktopOperationalTelemetryStrict,
  type DesktopTelemetryProperties,
} from './desktop-telemetry';
import {
  installerStepsForOnboarding,
  isInstallerPersonUid,
  pingInstallerStep,
} from './installer-step-telemetry';
import {
  normalizeConnectorImportOutcome,
  normalizeConnectorImportSourceSet,
  normalizeErrorCategory,
  normalizeFailedDependency,
  normalizeDepsOperation,
  normalizeDepsRetryResult,
  normalizeFailedStageIds,
  normalizeSetupErrorKind,
  CONNECTOR_IMPORT_OUTCOMES,
  CONNECTOR_IMPORT_SOURCE_SETS,
  SYMLINK_ERROR_IO_KINDS,
  SYMLINK_ERROR_OPERATIONS,
  type ConnectorImportSourceSet,
  type ErrorCategory,
  type FailedDependency,
  type DepsOperation,
  type DepsRetryResult,
  type SymlinkErrorIoKind,
  type SymlinkErrorOperation,
  type SetupErrorKind,
  type StageId,
} from './onboarding-setup';
import type { WizardStepId } from './onboarding-wizard';
import type { CompanyNamePrefillStatus } from './company-name-prefill';
import {
  FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES,
  normalizeFirstLaunchSignInReachOutcome,
  type FirstLaunchSignInReachOutcome,
} from './first-launch-signin-reach-telemetry';

const SCHEMA_VERSION = 4;
const STORAGE_KEY = `hq-sync:onboarding-step-telemetry:v${SCHEMA_VERSION}`;
const LEGACY_STORAGE_KEY = 'hq-sync:onboarding-step-telemetry:v3';
const OLDER_STORAGE_KEY = 'hq-sync:onboarding-step-telemetry:v2';
const INSTALL_ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OnboardingAction =
  | 'entered'
  | 'started'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'resumed'
  | 'back'
  | 'abandoned';

export type OnboardingFlow = 'first_install' | 'first_launch' | 'resume';
export type OnboardingPlatform = 'macos' | 'windows' | 'linux';
export const INVITE_STEP_HIDDEN_REASONS = ['no_invite_context', 'lookup_failed'] as const;
export type InviteStepHiddenReason = (typeof INVITE_STEP_HIDDEN_REASONS)[number];

export interface OnboardingStepProperties {
  step: WizardStepId;
  action: OnboardingAction;
  component?: StageId;
  flow?: OnboardingFlow;
  outcome?: string;
  provider?: 'google' | 'microsoft' | 'web';
  appVersion?: string;
  surface: 'desktop_installer';
  platform: OnboardingPlatform;
  durationMs?: number;
  attemptCount?: number;
  detectedToolCount?: number;
  /** Source scope of a connector-import probe, never a file path. */
  detectedSourceSet?: ConnectorImportSourceSet;
  failedStageCount?: number;
  failedStages?: StageId[];
  failedDependency?: FailedDependency;
  depsOperation?: DepsOperation;
  retryAttempted?: boolean;
  retryResult?: DepsRetryResult;
  errorCategory?: ErrorCategory;
  failureStage?: StageId;
  /** Setup failures carry a SetupErrorKind; the invite step an InviteErrorKind. */
  errorKind?: SetupErrorKind | InviteErrorKind;
  /** HTTP status of a failed invite-step request, when there was one. */
  statusCode?: number;
  errorOperation?: SymlinkErrorOperation;
  errorIoKind?: SymlinkErrorIoKind;
  errorCode?: number;
  setupRunId?: string;
  /** Company scope for the invite and company steps; never attach invitee data here. */
  companyUid?: string;
  /** Explicitly marks an invite-step event whose company context was unavailable. */
  companyUidMissing?: boolean;
  /** Count of invitations successfully sent from the invite step, bounded to 0..20. */
  invitesSent?: number;
  /** Company step route decision (look before create). Counts only, never names. */
  existingCompanies?: number;
  /** Bounded status for the optional name suggestion; never the name itself. */
  namePrefill?: CompanyNamePrefillStatus;
  paidCompany?: boolean;
  pendingInvites?: number;
  decision?: string;
  /** hq-pro provisioning step that failed or is being waited on. */
  provisioningStep?: string;
  /** Missing-bucket self-heal during the first sync. */
  selfHeal?: 'triggered' | 'succeeded' | 'failed';
}

export const COMPANY_ROUTE_DECISIONS = [
  'resume_setup',
  'company_other_account',
  'paid_existing',
  'joined_existing',
  'offer_existing',
  'join_invite',
  'invite_other_email',
  'invite_expired',
  'create',
  'joined_invite',
  'used_existing',
  'created_another',
  'lookup_failed',
] as const;
const SELF_HEAL_VALUES = ['triggered', 'succeeded', 'failed'] as const;
const COMPANY_NAME_PREFILL_VALUES: readonly CompanyNamePrefillStatus[] = [
  'offered_kept',
  'offered_edited',
  'not_offered',
];

export interface OnboardingStepEvent {
  sessionId: string;
  occurredAt: string;
  properties: OnboardingStepProperties;
}

export interface RecordOnboardingStep {
  properties: Omit<OnboardingStepProperties, 'surface' | 'platform' | 'appVersion'> & {
    appVersion?: string;
  };
  occurredAt?: string;
}

interface PendingTelemetryRecord {
  event: OnboardingStepEvent;
  deferred?: {
    id: string;
    /** Safe terminal value used if the app exits before the retry finishes. */
    fallback: Pick<OnboardingStepProperties, 'retryAttempted' | 'retryResult'>;
    retryAttempted: boolean;
  };
}

interface PersistedTelemetryState {
  version: number;
  sessionId: string;
  firstLaunchRecorded: boolean;
  /** Operational records waiting only for an authenticated transport. */
  pending: PendingTelemetryRecord[];
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
  /** Persist a failure without sending it until its retry outcome is known. */
  recordDeferred(
    event: RecordOnboardingStep,
    fallback: Pick<OnboardingStepProperties, 'retryAttempted' | 'retryResult'>,
  ): string;
  /** Persist that the retry started so a process exit is reported as failed-again. */
  markDeferredRetryAttempted(id: string): void;
  /** Resolve and release a deferred failure for delivery. */
  resolveDeferred(
    id: string,
    properties: Pick<OnboardingStepProperties, 'retryAttempted' | 'retryResult'>,
  ): void;
  /** Returns whether this call recorded the installation's first launch. */
  recordFirstLaunch(
    outcome?: FirstLaunchSignInReachOutcome,
    installAttemptId?: string,
  ): boolean;
  /** Retry records that could not be delivered before authentication existed. */
  flush(): Promise<void>;
  /**
   * Attach the signed-in vault person so later anonymous pings stitch onto
   * `install-person-index` / `installer_<step>` journey milestones.
   */
  setPersonUid(personUid: string): void;
  /** Use the native install id as the session join key on subsequent events. */
  setInstallAttemptId(installAttemptId: string): void;
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

  function recordWithSessionId(
    { properties, occurredAt }: RecordOnboardingStep,
    sessionId: string,
  ): void {
    const event: OnboardingStepEvent = {
      sessionId,
      occurredAt: occurredAt ?? now().toISOString(),
      properties: {
        ...properties,
        appVersion: properties.appVersion?.trim() || 'unknown',
        surface: 'desktop_installer',
        platform: currentPlatform(),
      },
    };
    state = { ...state, pending: [...state.pending, { event }] };
    persist();
    fireInstallerPings(event);
    void flush().catch((error) => console.warn('[onboarding] telemetry flush failed', error));
  }

  function record(record: RecordOnboardingStep): void {
    recordWithSessionId(record, state.sessionId);
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

  function recordDeferred(
    record: RecordOnboardingStep,
    fallback: Pick<OnboardingStepProperties, 'retryAttempted' | 'retryResult'>,
  ): string {
    const event: OnboardingStepEvent = {
      sessionId: state.sessionId,
      occurredAt: record.occurredAt ?? now().toISOString(),
      properties: {
        ...record.properties,
        appVersion: record.properties.appVersion?.trim() || 'unknown',
        surface: 'desktop_installer',
        platform: currentPlatform(),
      },
    };
    const id = createUuid();
    state = {
      ...state,
      pending: [...state.pending, {
        event,
        deferred: { id, fallback, retryAttempted: false },
      }],
    };
    persist();
    fireInstallerPings(event);
    return id;
  }

  function markDeferredRetryAttempted(id: string): void {
    state = {
      ...state,
      pending: state.pending.map((record) => record.deferred?.id === id
        ? {
            ...record,
            deferred: {
              ...record.deferred,
              retryAttempted: true,
              fallback: { retryAttempted: true, retryResult: 'failed-again' },
            },
          }
        : record),
    };
    persist();
  }

  function resolveDeferred(
    id: string,
    properties: Pick<OnboardingStepProperties, 'retryAttempted' | 'retryResult'>,
  ): void {
    state = {
      ...state,
      pending: state.pending.map((record) => record.deferred?.id === id
        ? {
            event: { ...record.event, properties: { ...record.event.properties, ...properties } },
          }
        : record),
    };
    persist();
    void flush().catch((error) => console.warn('[onboarding] telemetry flush failed', error));
  }

  async function flush(): Promise<void> {
    if (flushPromise) return flushPromise;

    const pendingFlush = (async () => {
      // Keep each event until its command succeeds. A missing pre-auth token
      // stops the drain, and a later authenticated retry resumes in order.
      while (state.pending.length > 0) {
        const next = state.pending[0]!;
        if (next.deferred) break;
        await emit(next.event);
        state = { ...state, pending: state.pending.slice(1) };
        persist();
      }
    })();
    flushPromise = pendingFlush.finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  // A previous process may have exited during the bounded retry wait. Release
  // its durable row with the persisted conservative outcome instead of leaving
  // the queue blocked forever or dropping the failure.
  state = {
    ...state,
    pending: state.pending.map((record) => {
      if (!record.deferred) return record;
      return {
        event: {
          ...record.event,
          properties: { ...record.event.properties, ...record.deferred.fallback },
        },
      };
    }),
  };
  persist();

  return {
    get sessionId() {
      return state.sessionId;
    },
    record,
    recordDeferred,
    markDeferredRetryAttempted,
    resolveDeferred,
    flush,
    setPersonUid(nextPersonUid: string) {
      const trimmed = nextPersonUid.trim();
      if (!isInstallerPersonUid(trimmed)) return;
      personUid = trimmed;
    },
    setInstallAttemptId(installAttemptId: string) {
      if (!INSTALL_ATTEMPT_ID_RE.test(installAttemptId)) return;
      state = { ...state, sessionId: installAttemptId };
      persist();
    },
    recordFirstLaunch(
      outcome?: FirstLaunchSignInReachOutcome,
      installAttemptId?: string,
    ) {
      if (state.firstLaunchRecorded) return false;
      state.firstLaunchRecorded = true;
      const eventSessionId = installAttemptId && INSTALL_ATTEMPT_ID_RE.test(installAttemptId)
        ? installAttemptId
        : state.sessionId;
      recordWithSessionId({
        properties: {
          step: 'welcome-signin',
          action: outcome && outcome !== 'reached-signin' ? 'skipped' : 'entered',
          flow: 'first_launch',
          ...(outcome ? { outcome } : {}),
        },
      }, eventSessionId);
      persist();
      return true;
    },
  };
}

export function desktopPropertiesForOnboardingStep(
  event: OnboardingStepEvent,
): DesktopTelemetryProperties {
  const properties: DesktopTelemetryProperties = {
    step: event.properties.step,
    action: event.properties.action,
    surface: event.properties.surface,
    platform: event.properties.platform,
  };
  for (const key of [
    'component',
    'flow',
    'provider',
    'appVersion',
    'durationMs',
    'attemptCount',
    'detectedToolCount',
    'failedStageCount',
    'failureStage',
  ] as const) {
    const value = event.properties[key];
    if (value !== undefined) properties[key] = value;
  }
  const outcome = event.properties.outcome;
  if (event.properties.step === 'invite-teammate' && event.properties.action === 'skipped') {
    if (INVITE_STEP_HIDDEN_REASONS.includes(outcome as InviteStepHiddenReason)) {
      properties.outcome = outcome;
    }
  } else if (event.properties.step === 'welcome-signin' && event.properties.flow === 'first_launch') {
    const reachOutcome = normalizeFirstLaunchSignInReachOutcome(outcome);
    const actionMatchesOutcome = reachOutcome === 'reached-signin'
      ? event.properties.action === 'entered'
      : reachOutcome !== undefined && event.properties.action === 'skipped';
    if (reachOutcome !== undefined && actionMatchesOutcome) properties.outcome = reachOutcome;
  } else if (
    outcome !== undefined &&
    !FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES.includes(outcome as FirstLaunchSignInReachOutcome)
  ) {
    properties.outcome = outcome;
  }
  if (event.properties.setupRunId !== undefined) {
    properties.setupRunId = event.properties.setupRunId;
  }
  for (const key of ['existingCompanies', 'pendingInvites'] as const) {
    const value = event.properties[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000) {
      properties[key] = value;
    }
  }
  if (typeof event.properties.paidCompany === 'boolean') properties.paidCompany = event.properties.paidCompany;
  if (
    event.properties.namePrefill !== undefined &&
    COMPANY_NAME_PREFILL_VALUES.includes(event.properties.namePrefill)
  ) {
    properties.namePrefill = event.properties.namePrefill;
  }
  if (event.properties.decision !== undefined) {
    properties.decision = (COMPANY_ROUTE_DECISIONS as readonly string[]).includes(event.properties.decision)
      ? event.properties.decision
      : 'unknown';
  }
  if (typeof event.properties.provisioningStep === 'string') {
    properties.provisioningStep = /^[a-z0-9:_-]{1,64}$/.test(event.properties.provisioningStep)
      ? event.properties.provisioningStep
      : 'unknown';
  }
  if (
    event.properties.selfHeal !== undefined &&
    (SELF_HEAL_VALUES as readonly string[]).includes(event.properties.selfHeal)
  ) {
    properties.selfHeal = event.properties.selfHeal;
  }
  if (
    (event.properties.step === 'invite-teammate' ||
      event.properties.step === 'company' ||
      event.properties.selfHeal !== undefined) &&
    typeof event.properties.companyUid === 'string' &&
    event.properties.companyUid.startsWith('cmp_')
  ) {
    properties.companyUid = event.properties.companyUid;
  }
  if (event.properties.step === 'invite-teammate') {
    if (event.properties.companyUidMissing === true) properties.companyUidMissing = true;
    const invitesSent = event.properties.invitesSent;
    if (
      event.properties.action === 'completed' &&
      typeof invitesSent === 'number' &&
      Number.isInteger(invitesSent) &&
      invitesSent >= 0 &&
      invitesSent <= 20
    ) {
      properties.invitesSent = invitesSent;
    }
  }
  if (event.properties.step === 'connector-import') {
    if (event.properties.outcome !== undefined) {
      properties.outcome = normalizeConnectorImportOutcome(event.properties.outcome);
    }
    if (event.properties.detectedSourceSet !== undefined) {
      properties.detectedSourceSet = normalizeConnectorImportSourceSet(
        event.properties.detectedSourceSet,
      );
    }
  }
  if (event.properties.action === 'failed') {
    properties.errorCategory = normalizeErrorCategory(event.properties.errorCategory);
    if (event.properties.step === 'setup') {
      const failureStage = normalizeFailedStageIds([
        event.properties.failureStage,
        event.properties.component,
      ])[0];
      if (failureStage) properties.failureStage = failureStage;
      else delete properties.failureStage;
    }
    if (event.properties.step === 'invite-teammate') {
      properties.errorKind = normalizeInviteErrorKind(event.properties.errorKind);
      const statusCode = normalizeHttpStatus(event.properties.statusCode);
      if (statusCode !== undefined) properties.statusCode = statusCode;
    } else if (event.properties.errorKind !== undefined) {
      properties.errorKind = normalizeSetupErrorKind(event.properties.errorKind);
    }
    if (event.properties.component === 'deps') {
      properties.failedDependency = normalizeFailedDependency(event.properties.failedDependency);
      if (typeof event.properties.retryAttempted === 'boolean') {
        properties.retryAttempted = event.properties.retryAttempted;
      }
      const retryResult = normalizeDepsRetryResult(event.properties.retryResult);
      if (retryResult !== undefined) properties.retryResult = retryResult;
      const depsOperation = normalizeDepsOperation(event.properties.depsOperation);
      if (depsOperation !== undefined) properties.depsOperation = depsOperation;
    } else if (event.properties.component === 'content') {
      if (
        typeof event.properties.errorOperation === 'string' &&
        SYMLINK_ERROR_OPERATIONS.includes(
          event.properties.errorOperation as SymlinkErrorOperation,
        )
      ) {
        properties.errorOperation = event.properties.errorOperation;
      }
      if (
        typeof event.properties.errorIoKind === 'string' &&
        SYMLINK_ERROR_IO_KINDS.includes(event.properties.errorIoKind as SymlinkErrorIoKind)
      ) {
        properties.errorIoKind = event.properties.errorIoKind;
      }
      const errorCode = event.properties.errorCode;
      if (
        typeof errorCode === 'number' &&
        Number.isInteger(errorCode) &&
        errorCode >= 0 &&
        errorCode <= 65_535
      ) {
        properties.errorCode = errorCode;
      }
    }
  }
  if (event.properties.outcome === 'completed_with_failures') {
    properties.failedStages = normalizeFailedStageIds(event.properties.failedStages ?? []);
  }
  return properties;
}

async function emitOnboardingStep(event: OnboardingStepEvent): Promise<void> {
  const properties = desktopPropertiesForOnboardingStep(event);
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

    for (const [key, version] of [[LEGACY_STORAGE_KEY, 3], [OLDER_STORAGE_KEY, 2]] as const) {
      const legacy = parseState(storage?.getItem(key), version);
      if (!legacy) continue;
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(legacy));
        storage?.removeItem(key);
      } catch {
        // Retaining a compatible legacy entry is safe: it remains available.
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
  const pending: PendingTelemetryRecord[] = [];
  if (Array.isArray(parsed.pending)) {
    for (const item of parsed.pending) {
      if (version === SCHEMA_VERSION && isPendingTelemetryRecord(item)) {
        pending.push(item);
      } else if (isEvent(item)) {
        pending.push({ event: item });
      }
    }
  }
  return {
    version: SCHEMA_VERSION,
    sessionId: parsed.sessionId,
    firstLaunchRecorded: parsed.firstLaunchRecorded,
    pending,
  };
}

function isPendingTelemetryRecord(value: unknown): value is PendingTelemetryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingTelemetryRecord>;
  if (!isEvent(record.event)) return false;
  if (record.deferred === undefined) return true;
  return Boolean(
    record.deferred &&
    typeof record.deferred.id === 'string' &&
    typeof record.deferred.retryAttempted === 'boolean' &&
    typeof record.deferred.fallback?.retryAttempted === 'boolean' &&
    typeof record.deferred.fallback?.retryResult === 'string'
  );
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

export {
  CONNECTOR_IMPORT_OUTCOMES,
  CONNECTOR_IMPORT_SOURCE_SETS,
};

export const __INTERNALS__ = { STORAGE_KEY, LEGACY_STORAGE_KEY, OLDER_STORAGE_KEY, SCHEMA_VERSION };
