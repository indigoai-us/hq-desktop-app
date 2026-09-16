export type StageId =
  | "content"
  | "deps"
  | "initial-sync"
  | "packages"
  | "git-init"
  | "personalize"
  | "import"
  | "indexing"
  | "menubar"
  | "mesh";

export const STAGE_ORDER: StageId[] = [
  "content",
  "deps",
  "initial-sync",
  "packages",
  "git-init",
  "personalize",
  "import",
  "indexing",
  "menubar",
  "mesh",
];

/** Existing HQ: do not extract or overwrite. Only install/sync the Work Mesh. */
export const UPGRADE_STAGE_ORDER: StageId[] = ["mesh"];

export function setupStageOrder(existingHq: boolean): StageId[] {
  return existingHq ? UPGRADE_STAGE_ORDER : STAGE_ORDER;
}

export const STAGE_LABELS: Record<StageId, string> = {
  content: "Downloading HQ template",
  deps: "Installing dependencies",
  "initial-sync": "Starting initial cloud sync",
  packages: "Installing packages",
  "git-init": "Initialising workspace",
  personalize: "Personalizing",
  import: "Importing existing setup",
  indexing: "Registering for search",
  menubar: "Finishing up",
  mesh: "Installing daemon",
};

/**
 * `retrying` is the gap between a transient stage failure and its automatic
 * next attempt. It is deliberately distinct from both `pending` (has not run)
 * and `failed` (will not run again): the stage still owns the active band, so
 * the ring and the band list do not move backward while it waits.
 */
export type StageStatus =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "retrying";

export interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  error?: string | null;
}

export type ManifestItemStatus =
  "pending" | "running" | "ok" | "failed" | "skipped";

export interface InstallManifest {
  schemaVersion: number;
  installerVersion: string;
  installPath: string;
  startedAt: string;
  completedAt: string | null;
  steps: Partial<
    Record<
      StageId | string,
      { status: ManifestItemStatus; error?: string | null }
    >
  >;
}

export function buildInitialStages(
  order: readonly StageId[] = STAGE_ORDER,
): StageState[] {
  return order.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: "pending",
    error: null,
  }));
}

export function resumeStartStageFromManifest(
  manifest: InstallManifest | null | undefined,
  order: readonly StageId[] = STAGE_ORDER,
): StageId {
  if (!manifest || manifest.completedAt) return order[0] ?? "mesh";
  for (const id of order) {
    if (manifest.steps?.[id]?.status !== "ok") return id;
  }
  return order[0] ?? "mesh";
}

export function buildStagesFromManifest(
  manifest: InstallManifest | null | undefined,
  startStage: StageId = resumeStartStageFromManifest(manifest),
  order: readonly StageId[] = STAGE_ORDER,
): StageState[] {
  const startIndex = order.indexOf(startStage);
  return order.map((id, index) => {
    const step = manifest?.steps?.[id];
    const beforeStart = startIndex > 0 && index < startIndex;
    return {
      id,
      label: STAGE_LABELS[id],
      status: beforeStart && step?.status === "ok" ? "ok" : "pending",
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
    .filter(
      (stage) => stage.status === "failed" && REQUIRED_STAGE_IDS.has(stage.id),
    )
    .map((stage) => ({
      id: stage.id,
      label: stage.label,
      message: stage.error?.trim() || "Stage failed with no detail recorded.",
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

/**
 * A stage that will not run again. Only these may count toward the percent —
 * a `failed` stage that is about to be retried is `retrying`, not `failed`, so
 * it is never counted and then un-counted.
 */
export function isSettledStageStatus(status: StageStatus): boolean {
  return status === "ok" || status === "failed";
}

/** A stage that owns the active band: running, or waiting on its auto-retry. */
export function isActiveStageStatus(status: StageStatus): boolean {
  return status === "running" || status === "retrying";
}

export function countSettledStages(stages: StageState[]): number {
  return stages.filter((stage) => isSettledStageStatus(stage.status)).length;
}

/** The stage that owns the active band, or null when none is in flight. */
export function activeStageId(stages: StageState[]): StageId | null {
  return stages.find((stage) => isActiveStageStatus(stage.status))?.id ?? null;
}

export function allSettled(stages: StageState[]): boolean {
  return stages.every((stage) => isSettledStageStatus(stage.status));
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

  return Math.round((base + (next - base) * creep) * 100);
}

export type FriendlySetupBandStatus = "pending" | "active" | "done";

export interface FriendlySetupBand {
  label: string;
  status: FriendlySetupBandStatus;
}

export const FRIENDLY_SETUP_BAND_LABELS = [
  "Laying the groundwork",
  "Building your workspace",
  "Bringing in your AI workers and workflows",
  "Making it yours",
  "Syncing across your devices",
] as const;

export function friendlySetupBands(
  overallPercent: number,
): FriendlySetupBand[] {
  const clamped = Math.max(0, Math.min(100, overallPercent));
  const activeBand =
    clamped >= 100 ? -1 : Math.min(4, Math.floor(clamped / 20));

  return FRIENDLY_SETUP_BAND_LABELS.map((label, index) => {
    const done = clamped >= (index + 1) * 20;
    return {
      label,
      status: done ? "done" : index === activeBand ? "active" : "pending",
    };
  });
}

// ─── Monotonic progress ──────────────────────────────────────────────
//
// `setupProgressPercent` is a pure function of the stage list, so anything
// that lowers its inputs mid-run — a stage waiting on its retry, a stage list
// rebuilt from a re-read manifest — drags the ring and the bands backward.
// Progress that goes backward reads as "it broke and started over", so the
// displayed value is a high-water mark: within one visit to the setup step it
// only ever rises. Leaving the step and starting over resets it.

export interface SetupProgressTracker {
  /** The highest percent shown so far in this visit. */
  percent: number;
}

export function createSetupProgressTracker(): SetupProgressTracker {
  return { percent: 0 };
}

/** Start over — only for a genuine re-entry of the setup step. */
export function resetSetupProgressTracker(tracker: SetupProgressTracker): void {
  tracker.percent = 0;
}

/** Record `percent` and return the value to display: never below the last one. */
export function trackSetupProgress(
  tracker: SetupProgressTracker,
  percent: number,
): number {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (clamped > tracker.percent) tracker.percent = clamped;
  return tracker.percent;
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
  content: "fetch_and_extract_template",
  deps: "install_deps",
  "initial-sync": "start_initial_cloud_sync",
  packages: "install_default_packages",
  mesh: "install_work_mesh",
  "git-init": "git_init",
  personalize: "personalize_hq",
  import: "import_existing_setup",
  indexing: "register_search_index",
  menubar: "install_menubar_app",
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

  if (id === "deps" && context.installPath) {
    invocations.push({
      command: "configure_claude_settings_path",
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
  mesh: 600_000, // doctor + chat cache warm over a large company
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
  if (input.contentStage.id !== "content") return false;
  if (input.contentStage.status === "failed") return true;
  return (
    input.contentStage.status === "running" &&
    input.activeStageId === "content" &&
    input.progress?.stalled === true
  );
}

export const DEFAULT_STAGE_AUTO_RETRY_LIMIT = 0;
export const STAGE_AUTO_RETRY_LIMITS: Partial<Record<StageId, number>> = {
  content: 2,
  deps: 1,
  "initial-sync": 1,
  packages: 1,
  indexing: 1,
  mesh: 1,
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
  const normalized = (message ?? "").toLowerCase();
  return (
    normalized.includes("this step took too long") ||
    normalized.includes("skipped after timeout")
  );
}

export function isTransientSetupStageFailure(
  input: TransientSetupStageFailureInput,
): boolean {
  const normalized = (input.message ?? "").toLowerCase();
  if (!normalized || isHardStageTimeoutMessage(normalized)) return false;
  if (
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("permission denied") ||
    normalized.includes("not found (404)") ||
    normalized.includes("unsupported") ||
    normalized.includes("invalid ")
  ) {
    return false;
  }

  const transientPattern =
    /\b(network|timeout|timed out|temporary|temporarily|econnreset|econnaborted|etimedout|enotfound|eai_again|dns|socket|connection reset|connection closed|connection refused|tls|ssl|fetch|download|stream|stalled|github|rate limit|429|5\d\d|npm|registry|tarball|release|proxy|offline)\b/i;
  if (!transientPattern.test(normalized)) return false;

  return stageAutoRetryLimit(input.stageId) > 0;
}

export type SetupStageRecoveryAction =
  | { kind: "retry"; delayMs: number; nextRetryCount: number; message: string }
  | { kind: "skip"; message: string }
  | { kind: "fail"; message: string };

export interface SetupStageRecoveryInput {
  stageId: StageId;
  message: string | null | undefined;
  retryCount: number;
}

export function setupStageRecoveryAction(
  input: SetupStageRecoveryInput,
): SetupStageRecoveryAction {
  const message =
    input.message?.trim() || "Stage failed with no detail recorded.";
  if (isHardStageTimeoutMessage(message)) {
    return { kind: "skip", message };
  }

  const nextRetryCount = Math.max(0, Math.floor(input.retryCount)) + 1;
  if (
    isTransientSetupStageFailure({ stageId: input.stageId, message }) &&
    nextRetryCount <= stageAutoRetryLimit(input.stageId)
  ) {
    return {
      kind: "retry",
      delayMs: setupAutoRetryDelayMs(nextRetryCount),
      nextRetryCount,
      message,
    };
  }

  return { kind: "fail", message };
}

export interface SetupRetryAttempt {
  /** 1-based number of the attempt that is about to start. */
  attempt: number;
  /** Total attempts this stage gets, the first one included. */
  of: number;
}

/**
 * The attempt a stage is about to make, from the retry count
 * {@link setupStageRecoveryAction} handed back. Attempt 1 was the original
 * run, so the first auto-retry is attempt 2.
 */
export function setupRetryAttempt(
  stageId: StageId,
  nextRetryCount: number,
): SetupRetryAttempt {
  const of = stageAutoRetryLimit(stageId) + 1;
  const attempt = Math.max(1, Math.floor(nextRetryCount)) + 1;
  return { attempt: Math.min(of, attempt), of };
}

export function setupRetrySubStatusText(retry: SetupRetryAttempt): string {
  return `Retrying — attempt ${retry.attempt} of ${retry.of}…`;
}

export class StageTimeoutError extends Error {
  constructor(
    public readonly stageId: StageId,
    public readonly ms: number,
  ) {
    super(
      `This step took too long (over ${Math.round(ms / 1000)}s) and was skipped.`,
    );
    this.name = "StageTimeoutError";
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
