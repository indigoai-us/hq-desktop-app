/**
 * Harness state flags — `?state=empty|loading|error` (shell view).
 *
 * Lets design lanes and QA reach the empty, skeleton and error paint of any
 * page without real data. Boot commands (auth, identity, workspace list,
 * feature gates) always pass through so the shell still mounts; every other
 * data command is rewritten:
 *
 *   empty    run the normal fixture, then clear every list in the result
 *   loading  never resolve, so the page holds its skeleton
 *   error    reject, so the page shows its error and heal path
 *
 * `?state=loading&loadingMs=1500` resolves after the delay instead of never,
 * to watch skeleton → content. Combine freely with `?persona=` and `?theme=`.
 */

export const HARNESS_STATES = ['empty', 'loading', 'error'] as const;
export type HarnessState = (typeof HARNESS_STATES)[number];

/** Commands the shell needs to mount at all; never altered by a state flag. */
const BOOT_COMMANDS = new Set([
  'get_auth_state',
  'get_auth_session',
  'whoami',
  'is_indigo_user',
  'desktop_alt_is_admin',
  'meetings_feature_enabled',
  'list_syncable_workspaces',
  'agent_session_preflight',
  'get_settings',
  'get_config',
  'invalidate_notify_prefs_cache',
]);

export function resolveHarnessState(search: string | null | undefined): HarnessState | null {
  if (!search) return null;
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('state');
  return HARNESS_STATES.includes(value as HarnessState) ? (value as HarnessState) : null;
}

export function resolveLoadingMs(search: string | null | undefined): number | null {
  if (!search) return null;
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('loadingMs');
  const ms = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function isBootCommand(cmd: string): boolean {
  return BOOT_COMMANDS.has(cmd);
}

/** Replace every array in a fixture result with an empty one. */
export function emptyResult(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  // hq_pro_fetch wraps its payload as { status, body: "<json>" }.
  if (typeof record.status === 'number' && typeof record.body === 'string') {
    try {
      return { ...record, body: JSON.stringify(emptyResult(JSON.parse(record.body))) };
    } catch {
      return record;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = emptyResult(child);
  return out;
}

/**
 * Apply the state flag to one invoke. `run` produces the normal fixture.
 */
export async function withHarnessState<T>(
  state: HarnessState | null,
  cmd: string,
  run: () => Promise<T> | T,
  loadingMs: number | null = null,
): Promise<T> {
  if (!state || isBootCommand(cmd)) return run();
  if (state === 'error') {
    throw new Error(`harness: simulated failure for ${cmd}`);
  }
  if (state === 'loading') {
    if (loadingMs === null) return new Promise<T>(() => {});
    await new Promise((resolve) => setTimeout(resolve, loadingMs));
    return run();
  }
  return emptyResult(await run()) as T;
}
