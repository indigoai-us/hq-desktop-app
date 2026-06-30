export type StageId =
  | 'deps'
  | 'initial-sync'
  | 'packages'
  | 'git-init'
  | 'personalize'
  | 'import'
  | 'indexing'
  | 'menubar';

export const STAGE_ORDER: StageId[] = [
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
  deps: 'install_deps',
  'initial-sync': 'start_initial_cloud_sync',
  packages: 'install_default_packages',
  'git-init': 'git_init',
  personalize: 'personalize_hq',
  import: 'import_existing_setup',
  indexing: 'register_search_index',
  menubar: 'install_menubar_app',
};
