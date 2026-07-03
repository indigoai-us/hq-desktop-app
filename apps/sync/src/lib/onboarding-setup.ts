export type StageId =
  | 'content'
  | 'deps'
  | 'initial-sync'
  | 'packages'
  | 'git-init'
  | 'personalize'
  | 'import'
  | 'indexing'
  | 'menubar';

export const STAGE_ORDER: StageId[] = [
  'content',
  'deps',
  'initial-sync',
  'packages',
  'git-init',
  'personalize',
  'import',
  'indexing',
  'menubar',
];

export const STAGE_LABELS: Record<StageId, string> = {
  content: 'Downloading HQ template',
  deps: 'Installing dependencies',
  'initial-sync': 'Starting initial cloud sync',
  packages: 'Installing packages',
  'git-init': 'Initialising workspace',
  personalize: 'Personalizing',
  import: 'Importing existing setup',
  indexing: 'Registering for search',
  menubar: 'Finishing up',
};

export type StageStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  error?: string | null;
}

export function buildInitialStages(): StageState[] {
  return STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: 'pending',
    error: null,
  }));
}

export function allSettled(stages: StageState[]): boolean {
  return stages.every(
    (stage) => stage.status === 'ok' || stage.status === 'failed',
  );
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
  packages: 'install_default_packages',
  'git-init': 'git_init',
  personalize: 'personalize_hq',
  import: 'import_existing_setup',
  indexing: 'register_search_index',
  menubar: 'install_menubar_app',
};

// Per-stage timeout so a hung backend stage can never wedge the whole wizard.
// Without this, `await invoke(command)` on a stage whose CLI never exits (e.g.
// `hq reindex` blocked on a lock held by the freshly-started sync daemon)
// leaves the user stuck on "Setting up HQ..." forever. On timeout the stage is
// marked failed and setup moves on — every stage is non-fatal (the tray agent
// re-runs sync/index/packages in steady state). Values mirror the old
// installer's skip thresholds: most stages 90s, network/toolchain-heavy ones
// longer.
export const DEFAULT_STAGE_TIMEOUT_MS = 90_000;

export const STAGE_TIMEOUT_MS: Partial<Record<StageId, number>> = {
  content: 240_000, // GitHub tarball download + extract
  deps: 240_000, // managed-toolchain / npm installs
  indexing: 180_000, // full-corpus reindex can be slow on first run
};

export function stageTimeoutMs(id: StageId): number {
  return STAGE_TIMEOUT_MS[id] ?? DEFAULT_STAGE_TIMEOUT_MS;
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
