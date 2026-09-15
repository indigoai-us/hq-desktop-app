export type StageId =
  | 'content'
  | 'deps'
  | 'initial-sync'
  | 'git-init'
  | 'personalize'
  | 'indexing';

export const FAILED_DEPENDENCIES = [
  'node',
  'yq',
  'jq',
  'git',
  'qmd',
  'hq-cli',
  'path-write',
  'unknown',
] as const;

export type FailedDependency = (typeof FAILED_DEPENDENCIES)[number];

export const ERROR_CATEGORIES = [
  'network',
  'checksum',
  'permission',
  'not-found',
  'timeout',
  'spawn-failed',
  'exit-nonzero',
  'concurrent-install',
  'cancelled',
  'cancel-cleanup-failed',
  'unsupported-platform',
  'disk',
  'unknown',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Claude Desktop connector import observes only its documented local config,
 * never Codex, browser sessions, or cloud integrations. Keep the emitted
 * outcomes finite so a malformed native response cannot become telemetry.
 */
export const CONNECTOR_IMPORT_OUTCOMES = [
  'tool_not_installed',
  'config_path_unavailable',
  'config_missing',
  'config_unreadable',
  'config_invalid',
  'zero_servers',
  'imported',
  'import_failed',
  'command_failed',
  'user_skipped',
  'unknown',
] as const;

export type ConnectorImportOutcome = (typeof CONNECTOR_IMPORT_OUTCOMES)[number];

/** The complete inspected-source set for the connector-import probe. */
export const CONNECTOR_IMPORT_SOURCE_SETS = [
  'claude_desktop_config',
  'unknown',
] as const;

export type ConnectorImportSourceSet = (typeof CONNECTOR_IMPORT_SOURCE_SETS)[number];

export function normalizeConnectorImportOutcome(value: unknown): ConnectorImportOutcome {
  return typeof value === 'string' && CONNECTOR_IMPORT_OUTCOMES.includes(value as ConnectorImportOutcome)
    ? (value as ConnectorImportOutcome)
    : 'unknown';
}

export function normalizeConnectorImportSourceSet(value: unknown): ConnectorImportSourceSet {
  return typeof value === 'string' && CONNECTOR_IMPORT_SOURCE_SETS.includes(value as ConnectorImportSourceSet)
    ? (value as ConnectorImportSourceSet)
    : 'unknown';
}

export const STAGE_ORDER: StageId[] = [
  'content',
  'deps',
  'initial-sync',
  'git-init',
  'personalize',
  'indexing',
];

export function normalizeFailedDependency(value: unknown): FailedDependency {
  return typeof value === 'string' && FAILED_DEPENDENCIES.includes(value as FailedDependency)
    ? (value as FailedDependency)
    : 'unknown';
}

export function normalizeErrorCategory(value: unknown): ErrorCategory {
  return typeof value === 'string' && ERROR_CATEGORIES.includes(value as ErrorCategory)
    ? (value as ErrorCategory)
    : 'unknown';
}

export function normalizeFailedStageIds(values: Iterable<unknown>): StageId[] {
  const normalized: StageId[] = [];
  for (const value of values) {
    if (
      typeof value === 'string' &&
      (STAGE_ORDER as string[]).includes(value) &&
      !normalized.includes(value as StageId)
    ) {
      normalized.push(value as StageId);
    }
    if (normalized.length === STAGE_ORDER.length) break;
  }
  return normalized;
}

export interface SetupFailureTelemetryDetails {
  errorCategory: ErrorCategory;
  failedDependency?: FailedDependency;
}

export function setupFailureTelemetryDetails(input: {
  stageId: StageId;
  errorCategory?: unknown;
  failedDependency?: unknown;
}): SetupFailureTelemetryDetails {
  const errorCategory = normalizeErrorCategory(input.errorCategory);
  return input.stageId === 'deps'
    ? {
        errorCategory,
        failedDependency: normalizeFailedDependency(input.failedDependency),
      }
    : { errorCategory };
}

export function createSetupRunId(randomUuid: () => string = () => crypto.randomUUID()): string {
  const value = randomUuid();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  return crypto.randomUUID();
}

export interface InFlightOperation<T> {
  operation: Promise<T> | null;
}

/** Reuse unfinished work so a timed-out retry cannot start it twice. */
export function reuseInFlightOperation<T>(
  state: InFlightOperation<T>,
  start: () => Promise<T>,
): Promise<T> {
  if (state.operation) return state.operation;

  const operation = Promise.resolve().then(start);
  state.operation = operation;
  const clear = () => {
    if (state.operation === operation) state.operation = null;
  };
  void operation.then(clear, clear);
  return operation;
}

export const STAGE_LABELS: Record<StageId, string> = {
  content: 'Downloading HQ template',
  deps: 'Installing dependencies',
  'initial-sync': 'Syncing initial cloud data',
  'git-init': 'Initialising workspace',
  personalize: 'Preparing personal workspace',
  indexing: 'Registering for search',
};

export type StageStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  error?: string | null;
}

export type ManifestItemStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'skipped';

export interface InstallManifest {
  schemaVersion: number;
  installerVersion: string;
  installPath: string;
  startedAt: string;
  completedAt: string | null;
  steps: Partial<Record<StageId | string, { status: ManifestItemStatus; error?: string | null }>>;
}

export function buildInitialStages(): StageState[] {
  return STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: 'pending',
    error: null,
  }));
}

export function resumeStartStageFromManifest(
  manifest: InstallManifest | null | undefined,
): StageId {
  if (!manifest || manifest.completedAt) return STAGE_ORDER[0];
  for (const id of STAGE_ORDER) {
    if (manifest.steps?.[id]?.status !== 'ok') return id;
  }
  return STAGE_ORDER[0];
}

export function buildStagesFromManifest(
  manifest: InstallManifest | null | undefined,
  startStage: StageId = resumeStartStageFromManifest(manifest),
): StageState[] {
  const startIndex = STAGE_ORDER.indexOf(startStage);
  return STAGE_ORDER.map((id, index) => {
    const step = manifest?.steps?.[id];
    const beforeStart = startIndex > 0 && index < startIndex;
    return {
      id,
      label: STAGE_LABELS[id],
      status: beforeStart && step?.status === 'ok' ? 'ok' : 'pending',
      error: null,
    };
  });
}

export interface FailedStageDetail {
  id: StageId;
  label: string;
  message: string;
}

export interface SetupCompletionResult {
  stages: StageState[];
  failedStages: FailedStageDetail[];
  needsAttention: boolean;
}

const REQUIRED_STAGE_IDS = new Set<StageId>(STAGE_ORDER);

export function failedRequiredStages(
  stages: StageState[],
): FailedStageDetail[] {
  return stages
    .filter((stage) => stage.status === 'failed' && REQUIRED_STAGE_IDS.has(stage.id))
    .map((stage) => ({
      id: stage.id,
      label: stage.label,
      message: stage.error?.trim() || 'Stage failed with no detail recorded.',
    }));
}

export function setupNeedsAttention(stages: StageState[]): boolean {
  return failedRequiredStages(stages).length > 0;
}

export function setupCompletionResult(
  stages: StageState[],
): SetupCompletionResult {
  const snapshot = stages.map((stage) => ({ ...stage }));
  const failedStages = failedRequiredStages(snapshot);
  return {
    stages: snapshot,
    failedStages,
    needsAttention: failedStages.length > 0,
  };
}

export function allSettled(stages: StageState[]): boolean {
  return stages.every(
    (stage) => stage.status === 'ok' || stage.status === 'failed',
  );
}

export interface SetupProgressInput {
  settledCount: number;
  totalStages: number;
  hasRunningStage: boolean;
  stageCreep: number;
  allDone?: boolean;
}

export function setupProgressPercent(input: SetupProgressInput): number {
  const total = Math.max(1, input.totalStages);
  const settled = Math.min(Math.max(0, input.settledCount), total);
  const allDone = input.allDone ?? settled >= total;
  if (allDone) return 100;

  const base = settled / total;
  const next = input.hasRunningStage
    ? Math.min(settled + 1, total) / total
    : base;
  const creep = Math.min(Math.max(0, input.stageCreep), 0.92);

  return Math.min(99, Math.round((base + (next - base) * creep) * 100));
}

export type FriendlySetupBandStatus = 'pending' | 'active' | 'done';

export interface FriendlySetupBand {
  label: string;
  status: FriendlySetupBandStatus;
}

export const FRIENDLY_SETUP_BAND_LABELS = [
  'Laying the groundwork',
  'Building your workspace',
  'Bringing in your AI workers and workflows',
  'Making it yours',
  'Syncing across your devices',
] as const;

export function friendlySetupBands(overallPercent: number): FriendlySetupBand[] {
  const clamped = Math.max(0, Math.min(100, overallPercent));
  const activeBand = clamped >= 100 ? -1 : Math.min(4, Math.floor(clamped / 20));

  return FRIENDLY_SETUP_BAND_LABELS.map((label, index) => {
    const done = clamped >= (index + 1) * 20;
    return {
      label,
      status: done ? 'done' : index === activeBand ? 'active' : 'pending',
    };
  });
}

export function setStageStatus(
  stages: StageState[],
  id: StageId,
  status: StageStatus,
  error: string | null = null,
): StageState[] {
  return stages.map((stage) =>
    stage.id === id
      ? {
          ...stage,
          status,
          error,
        }
      : stage,
  );
}

// Stage-level backend commands are intentionally scaffolded ahead of their Rust
// implementations. Missing commands fail non-fatally in the dispatcher.
export const STAGE_COMMAND: Partial<Record<StageId, string>> = {
  content: 'fetch_and_extract_template',
  deps: 'install_deps',
  'initial-sync': 'start_initial_cloud_sync',
  'git-init': 'git_init',
  personalize: 'personalize_hq',
  indexing: 'register_search_index',
};

export interface StageCommandContext {
  installPath: string | null;
}

export interface StageCommandInvocation {
  command: string;
  args?: Record<string, unknown>;
  required: boolean;
}

export function stageCommandInvocations(
  id: StageId,
  context: StageCommandContext,
): StageCommandInvocation[] {
  const command = STAGE_COMMAND[id];
  if (!command) return [];

  const invocations: StageCommandInvocation[] = [{ command, required: true }];

  if (id === 'deps' && context.installPath) {
    invocations.push({
      command: 'configure_claude_settings_path',
      args: { hqPath: context.installPath },
      required: false,
    });
  }

  // TODO(windows): surface is_long_paths_enabled/enable_long_paths in a
  // dedicated remediation UI before deps; invoking it here could surprise
  // users with a UAC prompt.
  return invocations;
}

// The old installer revealed a manual skip affordance after these thresholds:
// most stages after 90s, network/toolchain-heavy ones later. A separate hard
// timeout keeps setup from wedging if the user ignores the affordance.
export const DEFAULT_STAGE_SKIP_THRESHOLD_MS = 90_000;

export const STAGE_SKIP_THRESHOLD_MS: Partial<Record<StageId, number>> = {
  content: 240_000, // GitHub tarball download + extract
  deps: 240_000, // managed-toolchain / npm installs
  indexing: 180_000, // full-corpus reindex can be slow on first run
};

export const STAGE_TIMEOUT_GRACE_MS = 300_000;
export const DEFAULT_STAGE_TIMEOUT_MS =
  DEFAULT_STAGE_SKIP_THRESHOLD_MS + STAGE_TIMEOUT_GRACE_MS;

export const STAGE_TIMEOUT_MS: Partial<Record<StageId, number>> =
  Object.fromEntries(
    STAGE_ORDER.map((id) => [
      id,
      (STAGE_SKIP_THRESHOLD_MS[id] ?? DEFAULT_STAGE_SKIP_THRESHOLD_MS) +
        STAGE_TIMEOUT_GRACE_MS,
    ]),
  ) as Partial<Record<StageId, number>>;

export function stageSkipThresholdMs(id: StageId): number {
  return STAGE_SKIP_THRESHOLD_MS[id] ?? DEFAULT_STAGE_SKIP_THRESHOLD_MS;
}

export function stageTimeoutMs(id: StageId): number {
  return STAGE_TIMEOUT_MS[id] ?? DEFAULT_STAGE_TIMEOUT_MS;
}

export interface StageSkipEligibilityInput {
  activeStageId: StageId | null;
  stageId: StageId;
  elapsedMs: number;
  setupDone?: boolean;
}

export function isStageSkipEligible(input: StageSkipEligibilityInput): boolean {
  return (
    !input.setupDone &&
    input.activeStageId === input.stageId &&
    input.elapsedMs >= stageSkipThresholdMs(input.stageId)
  );
}

export interface ContentRetryProgress {
  stalled?: boolean | null;
}

export interface ContentRetryEligibilityInput {
  contentStage: StageState | null | undefined;
  activeStageId: StageId | null;
  progress?: ContentRetryProgress | null;
  retrying?: boolean;
}

export function isContentRetryEligible(
  input: ContentRetryEligibilityInput,
): boolean {
  if (input.retrying || !input.contentStage) return false;
  if (input.contentStage.id !== 'content') return false;
  if (input.contentStage.status === 'failed') return true;
  return (
    input.contentStage.status === 'running' &&
    input.activeStageId === 'content' &&
    input.progress?.stalled === true
  );
}

export const DEFAULT_STAGE_AUTO_RETRY_LIMIT = 0;
export const STAGE_AUTO_RETRY_LIMITS: Partial<Record<StageId, number>> = {
  content: 2,
  deps: 1,
  'initial-sync': 1,
  indexing: 1,
};

export const DEFAULT_SETUP_AUTO_RETRY_DELAY_MS = 1_000;
export const MAX_SETUP_AUTO_RETRY_DELAY_MS = 8_000;

export function stageAutoRetryLimit(id: StageId): number {
  return STAGE_AUTO_RETRY_LIMITS[id] ?? DEFAULT_STAGE_AUTO_RETRY_LIMIT;
}

export function setupAutoRetryDelayMs(retryNumber: number): number {
  const normalizedRetryNumber = Math.max(1, Math.floor(retryNumber));
  return Math.min(
    DEFAULT_SETUP_AUTO_RETRY_DELAY_MS * 2 ** (normalizedRetryNumber - 1),
    MAX_SETUP_AUTO_RETRY_DELAY_MS,
  );
}

export interface TransientSetupStageFailureInput {
  stageId: StageId;
  message: string | null | undefined;
}

export function isHardStageTimeoutMessage(
  message: string | null | undefined,
): boolean {
  const normalized = (message ?? '').toLowerCase();
  return (
    normalized.includes('this step took too long') ||
    normalized.includes('skipped after timeout')
  );
}

export function isTransientSetupStageFailure(
  input: TransientSetupStageFailureInput,
): boolean {
  const normalized = (input.message ?? '').toLowerCase();
  if (!normalized || isHardStageTimeoutMessage(normalized)) return false;
  if (
    normalized.includes('cancelled') ||
    normalized.includes('canceled') ||
    normalized.includes('permission denied') ||
    normalized.includes('not found (404)') ||
    normalized.includes('unsupported') ||
    normalized.includes('invalid ')
  ) {
    return false;
  }

  const transientPattern =
    /\b(network|timeout|timed out|temporary|temporarily|econnreset|econnaborted|etimedout|enotfound|eai_again|dns|socket|connection reset|connection closed|connection refused|tls|ssl|fetch|download|stream|stalled|github|rate limit|429|5\d\d|npm|registry|tarball|release|proxy|offline)\b/i;
  if (!transientPattern.test(normalized)) return false;

  return stageAutoRetryLimit(input.stageId) > 0;
}

export type SetupStageRecoveryAction =
  | { kind: 'retry'; delayMs: number; nextRetryCount: number; message: string }
  | { kind: 'skip'; message: string }
  | { kind: 'fail'; message: string };

export interface SetupStageRecoveryInput {
  stageId: StageId;
  message: string | null | undefined;
  retryCount: number;
}

export function setupStageRecoveryAction(
  input: SetupStageRecoveryInput,
): SetupStageRecoveryAction {
  const message =
    input.message?.trim() || 'Stage failed with no detail recorded.';
  if (isHardStageTimeoutMessage(message)) {
    return { kind: 'skip', message };
  }

  const nextRetryCount = Math.max(0, Math.floor(input.retryCount)) + 1;
  if (
    isTransientSetupStageFailure({ stageId: input.stageId, message }) &&
    nextRetryCount <= stageAutoRetryLimit(input.stageId)
  ) {
    return {
      kind: 'retry',
      delayMs: setupAutoRetryDelayMs(nextRetryCount),
      nextRetryCount,
      message,
    };
  }

  return { kind: 'fail', message };
}

export class StageTimeoutError extends Error {
  constructor(public readonly stageId: StageId, public readonly ms: number) {
    super(`This step took too long (over ${Math.round(ms / 1000)}s) and was skipped.`);
    this.name = 'StageTimeoutError';
  }
}

/**
 * Resolve/reject with `promise`, but reject with `onTimeout()` if it hasn't
 * settled within `ms`. A caller can pass `onTimeoutCancel` to stop foreground
 * backend work before the wizard moves on. A non-positive `ms` disables the
 * timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  onTimeoutCancel?: () => void | Promise<void>,
): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        void onTimeoutCancel?.();
      } finally {
        reject(onTimeout());
      }
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ─── Live sub-status under the active band ──────────────────────────────────
//
// A band covers 20% of the ring but several stages take minutes (initial cloud
// sync in particular), so the band alone reads as frozen. The wizard shows one
// honest sub-step line under the active band, rotated on a timer, plus a
// "still working" elapsed cue once the stage has been running a while.
//
// Where the pipeline reports something real we prefer it: the template
// download emits `content:progress` with a phase and a byte percentage.
// `install:progress` only carries raw installer stdout, which is not
// user-facing copy, so the deps stage rotates its written sub-steps instead.

/** Honest, ordered sub-steps for each stage. Rotated while the stage runs. */
export const STAGE_SUB_STEPS: Record<StageId, readonly string[]> = {
  content: [
    'Downloading the HQ template…',
    'Unpacking files…',
    'Checking everything arrived…',
  ],
  deps: [
    'Checking what’s already installed…',
    'Installing the tools HQ needs…',
    'Wiring them into your shell…',
  ],
  'initial-sync': [
    'Downloading worker definitions…',
    'Installing workflows…',
    'Syncing your personal vault…',
    'Almost there…',
  ],
  'git-init': [
    'Setting up version history…',
    'Recording the first snapshot…',
  ],
  personalize: [
    'Creating your personal workspace…',
    'Applying your preferences…',
  ],
  indexing: [
    'Reading through your files…',
    'Building the search index…',
    'Almost there…',
  ],
};

/** How long each sub-step is shown before the next one. */
export const SETUP_SUB_STATUS_ROTATE_MS = 6_000;
/** After this long on one stage, add the "still working" elapsed cue. */
export const SETUP_STILL_WORKING_AFTER_MS = 20_000;

/**
 * Readable fallback for a stage id with no written sub-steps — a newly added
 * backend stage must never render a blank line (hq-wizard-step-label-coverage).
 */
export function humanizeStageId(id: string): string {
  const words = id.trim().replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Working';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Sub-steps for `id`, falling back to a humanized form of an unknown id. */
export function stageSubSteps(id: StageId | string): readonly string[] {
  const known = STAGE_SUB_STEPS[id as StageId];
  if (known && known.length > 0) return known;
  return [`${humanizeStageId(id)}…`];
}

/** `45s`, `2m 05s` — the elapsed cue shown once a stage has run a while. */
export function formatSetupElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export interface SetupSubStatusInput {
  /** The stage currently running; null when nothing is running. */
  stageId: StageId | null;
  /** How long that stage has been running. */
  elapsedMs: number;
  /** Real backend progress text for this stage, when the pipeline sent one. */
  detail?: string | null;
  rotateMs?: number;
  stillWorkingAfterMs?: number;
}

export interface SetupSubStatus {
  /** The line under the active band; null when no stage is running. */
  text: string | null;
  /** "Still working — 45s", or null before the threshold. */
  elapsedLabel: string | null;
}

/**
 * The sub-status shown under the active band. A real backend detail wins; with
 * no detail the stage's written sub-steps rotate on `rotateMs` and hold on the
 * last one, so the line always says something true rather than looping back to
 * "starting" on a stage that has been running for minutes.
 */
export function setupSubStatus(input: SetupSubStatusInput): SetupSubStatus {
  if (!input.stageId) return { text: null, elapsedLabel: null };
  const elapsedMs = Math.max(0, input.elapsedMs);
  const rotateMs = Math.max(1, input.rotateMs ?? SETUP_SUB_STATUS_ROTATE_MS);
  const stillWorkingAfterMs =
    input.stillWorkingAfterMs ?? SETUP_STILL_WORKING_AFTER_MS;

  const detail = input.detail?.trim();
  const steps = stageSubSteps(input.stageId);
  const index = Math.min(steps.length - 1, Math.floor(elapsedMs / rotateMs));

  return {
    text: detail || steps[index] || null,
    elapsedLabel:
      elapsedMs >= stillWorkingAfterMs
        ? `Still working — ${formatSetupElapsed(elapsedMs)}`
        : null,
  };
}

/**
 * User-facing line for a `content:progress` event, or null when the payload
 * says nothing worth showing. Byte percentages are the one place the setup
 * pipeline reports genuine progress.
 */
export function contentProgressSubStatus(payload: {
  phase?: 'download' | 'extract' | 'complete' | string | null;
  percent?: number | null;
  stalled?: boolean | null;
}): string | null {
  if (payload.stalled) return 'The download stalled — retrying…';
  if (payload.phase === 'download') {
    const percent =
      typeof payload.percent === 'number' && Number.isFinite(payload.percent)
        ? Math.max(0, Math.min(100, Math.round(payload.percent)))
        : null;
    return percent === null
      ? 'Downloading the HQ template…'
      : `Downloading the HQ template — ${percent}%`;
  }
  if (payload.phase === 'extract') return 'Unpacking files…';
  return null;
}

// ─── Percent creep inside a band ────────────────────────────────────────────
//
// The ring used to approach its per-stage ceiling on a fixed 14%-per-tick
// curve, which saturates in about 25 seconds. On a stage that runs for minutes
// the displayed number then never changed again. The creep now has two parts:
// a quick rise so short stages still feel responsive, then a slow linear tail
// that keeps the integer percent ticking up for the whole worst-case stage.

/** The most of a stage's span the creep may claim before the stage finishes. */
export const STAGE_CREEP_CEILING = 0.92;
const STAGE_CREEP_FAST_CEILING = 0.45;
const STAGE_CREEP_FAST_TAU_MS = 6_000;
/** The tail reaches the ceiling at roughly the longest stage skip threshold. */
const STAGE_CREEP_TAIL_MS = 180_000;

/** Creep fraction (0…{@link STAGE_CREEP_CEILING}) for a stage running `elapsedMs`. */
export function stageCreepAt(elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  const fast =
    STAGE_CREEP_FAST_CEILING * (1 - Math.exp(-elapsed / STAGE_CREEP_FAST_TAU_MS));
  const tail =
    (STAGE_CREEP_CEILING - STAGE_CREEP_FAST_CEILING) *
    Math.min(1, elapsed / STAGE_CREEP_TAIL_MS);
  return Math.min(STAGE_CREEP_CEILING, fast + tail);
}
