/**
 * Framework-free orchestration for a manual "check for updates".
 *
 * Shared by the Settings → Updates "Check for updates" button and the macOS
 * app-menu "Check for Updates…" event path so the three-target flow is never
 * duplicated.
 */

export type UpdateTarget = 'app' | 'core' | 'cli';

export interface UpdateCheckDeps {
  invoke: <T>(cmd: string) => Promise<T>; // Tauri invoke
}

export interface TargetResult {
  target: UpdateTarget;
  status: 'up-to-date' | 'update-available' | 'error';
  detail?: unknown;
  error?: string;
}

export interface CheckAllCallbacks {
  onTargetStart?: (t: UpdateTarget) => void;
  onTargetDone?: (r: TargetResult) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkApp(deps: UpdateCheckDeps): Promise<TargetResult> {
  const info = await deps.invoke<unknown>('check_for_updates');
  if (info == null) {
    return { target: 'app', status: 'up-to-date' };
  }
  return { target: 'app', status: 'update-available', detail: info };
}

async function checkCore(deps: UpdateCheckDeps): Promise<TargetResult> {
  // CoreState is treated loosely: callers may omit fields or return null.
  const state = await deps.invoke<any>('check_core_state');
  return {
    target: 'core',
    status: state?.updateAvailable ? 'update-available' : 'up-to-date',
    detail: state,
  };
}

async function checkCli(deps: UpdateCheckDeps): Promise<TargetResult> {
  const info = await deps.invoke<unknown>('check_hq_cli_update');
  if (info == null) {
    return { target: 'cli', status: 'up-to-date' };
  }
  return { target: 'cli', status: 'update-available', detail: info };
}

async function runTarget(
  target: UpdateTarget,
  work: () => Promise<TargetResult>,
  cb?: CheckAllCallbacks,
): Promise<TargetResult> {
  cb?.onTargetStart?.(target);
  try {
    const result = await work();
    cb?.onTargetDone?.(result);
    return result;
  } catch (error) {
    const result: TargetResult = {
      target,
      status: 'error',
      error: errorMessage(error),
    };
    cb?.onTargetDone?.(result);
    return result;
  }
}

export async function checkAllUpdates(
  deps: UpdateCheckDeps,
  cb?: CheckAllCallbacks,
): Promise<TargetResult[]> {
  return Promise.all([
    runTarget('app', () => checkApp(deps), cb),
    runTarget('core', () => checkCore(deps), cb),
    runTarget('cli', () => checkCli(deps), cb),
  ]);
}

export function summarizeResults(
  results: TargetResult[],
): 'up-to-date' | 'update-available' | 'error' {
  if (results.some((r) => r.status === 'update-available')) return 'update-available';
  if (results.some((r) => r.status === 'error')) return 'error';
  return 'up-to-date';
}
