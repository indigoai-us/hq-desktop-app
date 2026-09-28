/**
 * Startup gate: decides which surface the main window shows on launch.
 *
 * The Welcome / setup card and the sign-in card are destinations for a
 * machine we have POSITIVELY determined is not set up. Until the startup
 * probe resolves, the only honest surface is a neutral loading state.
 *
 * Why this exists: after an auto-update relaunch the backend probe can fail
 * transiently (the settings/token files are being rewritten, the HQ folder is
 * briefly unreadable, the IPC bridge is not up yet). Collapsing those failures
 * to "not signed in" showed a fresh install's Welcome card to people who were
 * set up the whole time (customer report 2026-09-19, v0.10.296 -> v0.10.297).
 */

import type { StartupSetupEvidence } from './unexpected-startup-surface';

export type TokenPresence = 'present' | 'absent' | 'unknown';

export function normalizeTokenPresence(value: unknown): TokenPresence {
  return value === 'present' || value === 'absent' ? value : 'unknown';
}

export type StartupProbeResult = {
  /** `get_lifecycle_state` verdict, or null when the command is unavailable. */
  lifecycleState: string | null;
  /** Raw token-file presence hint, for reauth copy selection. */
  hadStoredToken: boolean;
  /** Bounded observation used to diagnose startup auth restoration. */
  tokenPresence: TokenPresence;
  /** Persisted setup evidence used to reconcile startup routing and reporting. */
  setupEvidence?: StartupSetupEvidence | null;
  auth: { authenticated: boolean; expiresAt: string | null };
};

export type StartupPhase = 'loading' | 'resolved';

export type StartupSurface = 'loading' | 'onboarding' | 'signed-in' | 'sign-in';

/**
 * A completed first run is stronger evidence than a stale consent-only state.
 * Keep the onboarding route only when setup evidence is missing or incomplete.
 */
export function lifecycleStateForStartup(
  lifecycleState: string | null,
  setupEvidence?: StartupSetupEvidence | null,
): string | null {
  if (
    lifecycleState === 'InstalledFirstRun' &&
    setupEvidence?.firstRunCompleted &&
    setupEvidence.hqRootValid &&
    !setupEvidence.installInProgress &&
    !setupEvidence.manifestIncomplete
  ) {
    return 'SteadyState';
  }
  return lifecycleState;
}

export type StartupProbeOutcome =
  | { ok: true; result: StartupProbeResult; attempts: number }
  | { ok: false; error: unknown; attempts: number };

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 400;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the startup probe, retrying a transient failure before giving up.
 *
 * A failure here is "we could not tell", never "signed out". The caller must
 * keep the loading surface when `ok` is false.
 */
export async function resolveStartupState(
  probe: () => Promise<StartupProbeResult>,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {},
): Promise<StartupProbeOutcome> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await probe();
      return { ok: true, result, attempts: attempt };
    } catch (err) {
      lastError = err;
      opts.onRetry?.(attempt, err);
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }

  return { ok: false, error: lastError, attempts };
}

const ONBOARDING_STATES = new Set([
  'NeedsInstall',
  'InstallResume',
  'NeedsAuthForInstall',
  'InstalledFirstRun',
]);

/**
 * Pure surface selector. `phase` is `loading` until the probe has resolved at
 * least once — an unresolved probe never yields `onboarding` or `sign-in`.
 */
export function startupSurface(input: {
  phase: StartupPhase;
  lifecycleState: string | null;
  authenticated: boolean;
  setupEvidence?: StartupSetupEvidence | null;
}): StartupSurface {
  if (input.phase !== 'resolved') return 'loading';
  const lifecycleState = lifecycleStateForStartup(input.lifecycleState, input.setupEvidence);
  if (lifecycleState !== null && ONBOARDING_STATES.has(lifecycleState)) {
    return 'onboarding';
  }
  return input.authenticated ? 'signed-in' : 'sign-in';
}
