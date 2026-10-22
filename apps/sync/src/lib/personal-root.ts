/**
 * H8 paired personal root (gated, off in shipped builds).
 *
 * Mirrors commands/personal_root.rs. With the gate off every command returns
 * `{ phase: 'legacy' }` and setup runs exactly as before.
 */

export type PersonalRootPhase =
  | 'legacy'
  | 'initialize_pending'
  | 'initialized'
  | 'seed_in_progress'
  | 'seeded'
  | 'owner_observed'
  | 'adoption_review'
  | 'preserved'
  | 'adopted'
  | 'baseline_ready'
  | 'resume_authorized'
  | 'paused';

export type PersonalRootApprovalPhase = 'preserve' | 'adopt' | 'baseline' | 'resume';

export interface PersonalRootPlanEntry {
  key: string;
  reason: string;
}

export interface PersonalRootUploadEntry {
  key: string;
  kind: 'file' | 'symlink';
  size: number;
  wireSize: number;
  localHash: string;
  wireHash: string;
}

export interface PersonalRootPlanView {
  transactionId: string;
  stateDirectory: string;
  authorityDigest: string;
  inventoryDigest: string;
  maxUploadRows: number;
  maxUploadBytes: number;
  maxDurationMs: number;
  /** Every upload the baseline step may make (capped for display). */
  uploadEntries: PersonalRootUploadEntry[];
  approvedPlanDigest: string;
  fileCount: number;
  byteCount: number;
  uploadCount: number;
  uploadBytes: number;
  preservedOnly: PersonalRootPlanEntry[];
  preservedOnlyTotal: number;
  destinationUid: string;
  destinationBucket: string;
  destinationRegion: string;
  destinationEndpoint: string;
  historicalUids: string[];
}

export interface PersonalRootView {
  phase: PersonalRootPhase;
  rootPath: string | null;
  reason: string | null;
  retryable: boolean;
  nextPhase: PersonalRootApprovalPhase | null;
  plan: PersonalRootPlanView | null;
  /** Personal sync is held, but an hq daemon this app did not start is syncing. */
  holdUnenforced: boolean;
}

export type PersonalRootInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const SETUP_READY: ReadonlySet<PersonalRootPhase> = new Set<PersonalRootPhase>([
  'legacy',
  'initialized',
  'seeded',
  'owner_observed',
  'resume_authorized',
]);

const ADOPTION_PHASES: ReadonlySet<PersonalRootPhase> = new Set<PersonalRootPhase>([
  'adoption_review',
  'preserved',
  'adopted',
  'baseline_ready',
]);

/** Setup may continue: the gate is off, or the root is new or confirmed. */
export function personalRootAllowsSetup(view: PersonalRootView | null | undefined): boolean {
  return !view || (SETUP_READY.has(view.phase) && !view.reason);
}

/**
 * The folder is in an adoption review the person can act on. A stop that is
 * not retryable (account changed, folder replaced, ...) offers no step until
 * the folder is checked again.
 */
export function personalRootOffersAdoption(view: PersonalRootView): boolean {
  return (
    ADOPTION_PHASES.has(view.phase) &&
    view.reason !== 'owner_mismatch' &&
    (!view.reason || view.retryable === true)
  );
}

/** A stop that is not retryable: offer to check the folder again instead. */
export function personalRootCanCheckAgain(view: PersonalRootView): boolean {
  return !!view.reason && view.retryable !== true;
}

/** Only busy and authority_unavailable come back retryable. */
export function personalRootCanRetry(view: PersonalRootView): boolean {
  return view.retryable === true;
}

const REASON_TEXT: Record<string, string> = {
  adoption_required:
    'This folder already has files, so HQ will not set it up as new. Review what is in it before HQ syncs it.',
  owner_mismatch:
    'This folder belongs to a different HQ account, so HQ will not adopt it. To move its files, export them from that account and import them into this one.',
  authority_changed:
    'You are signed in to a different HQ account than the one this folder was set up with. Sign in to the original account, or start recovery.',
  authority_unavailable:
    'HQ cannot reach your HQ account right now. Check your connection, then try again.',
  state_unreadable: 'HQ could not read its records for this folder. Your files are untouched.',
  seed_recovery_required: 'HQ stopped during the first setup of this folder. Your files are preserved. Personal sync stays off; review recovery before continuing. HQ will not retry or replace these files automatically.',
  state_changed:
    'The folder or HQ’s records changed while HQ was working. Your files are untouched. Review the folder again.',
  root_replaced: 'This folder was moved or replaced. Your files are untouched.',
  busy: 'Another HQ task is using this folder. Try again when it finishes.',
  invalid_request: 'HQ’s sync tool rejected the request. Please report this problem.',
  lease_released: 'HQ lost its hold on this folder before it finished. Your files are untouched.',
  unsupported_cli:
    'This version of HQ’s sync tool cannot set up folders safely. Update HQ, then try again.',
  cancelled: 'HQ stopped before it finished. It checks the folder again next time.',
  spawn_failed: 'HQ could not start its sync tool.',
  timeout: 'HQ’s sync tool took too long and was stopped. HQ checks the folder again next time.',
  request_rejected: 'HQ refused this request before running it.',
  response_too_large: 'This folder’s review is too large for HQ to show.',
  state_inside_root: 'HQ keeps its own records inside this folder. Choose a different folder.',
  state_in_use_by_other_root: 'HQ on this computer already manages a different personal folder.',
  parent_unavailable: 'HQ could not prepare the folder that will hold HQ.',
};

export function personalRootReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  return REASON_TEXT[reason] ?? 'HQ stopped setting up this folder. Your files are untouched.';
}

export const APPROVAL_LABELS: Record<PersonalRootApprovalPhase, string> = {
  preserve: 'Keep a copy of these files',
  adopt: 'Make this folder yours',
  baseline: 'Upload the reviewed files',
  resume: 'Turn on personal sync',
};

export const APPROVAL_STEP: Record<PersonalRootApprovalPhase, number> = {
  preserve: 1,
  adopt: 2,
  baseline: 3,
  resume: 4,
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0))} bytes`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function normalizePersonalRootView(value: unknown): PersonalRootView {
  const v = (value ?? {}) as Partial<PersonalRootView>;
  return {
    phase: (v.phase ?? 'paused') as PersonalRootPhase,
    rootPath: v.rootPath ?? null,
    reason: v.reason ?? null,
    retryable: v.retryable === true,
    nextPhase: v.nextPhase ?? null,
    plan: v.plan ? { ...v.plan, uploadEntries: v.plan.uploadEntries ?? [] } : null,
    holdUnenforced: v.holdUnenforced === true,
  };
}

/** Read the saved state (relaunch, desktop window). */
export async function loadPersonalRoot(invoke: PersonalRootInvoke): Promise<PersonalRootView> {
  return normalizePersonalRootView(await invoke('personal_root_state'));
}

/**
 * Try again / Check this folder again: re-runs inspect (and initialize for a
 * new root) for the saved folder. Never repeats an approved step.
 */
export async function recheckPersonalRoot(invoke: PersonalRootInvoke): Promise<PersonalRootView> {
  return normalizePersonalRootView(await invoke('personal_root_recheck'));
}

/** Directory step: authority, inspect, then initialize for a new root. */
export async function preparePersonalRoot(
  invoke: PersonalRootInvoke,
  path: string,
): Promise<PersonalRootView> {
  return normalizePersonalRootView(await invoke('prepare_personal_root', { path }));
}

/** Ask for the adoption plan. Uploads nothing. */
export async function requestAdoptionPlan(invoke: PersonalRootInvoke): Promise<PersonalRootView> {
  return normalizePersonalRootView(await invoke('personal_root_plan_adoption'));
}

/**
 * One click, one phase. Sends the phase the view says is next and the digest
 * of the plan the person is looking at. Never chains to the next phase.
 */
export async function approveNextPhase(
  invoke: PersonalRootInvoke,
  view: PersonalRootView,
): Promise<PersonalRootView> {
  if (!view.nextPhase || !view.plan) {
    throw new Error('There is no step to approve.');
  }
  return normalizePersonalRootView(
    await invoke('personal_root_approve_phase', {
      phase: view.nextPhase,
      planDigest: view.plan.approvedPlanDigest,
    }),
  );
}
