/**
 * The coding tool's sign-in inside the first run (lane A, owner 2026-10-16:
 * "we want the report to run so make sure the user connects their coding
 * tool during install flow", then "Just have them sign in after we identify
 * what they use most often").
 *
 * "Continue in <tool>" and the name path run the tool's own browser sign-in
 * (the one the signed-out repair card's "Sign in" runs) before they go on,
 * when that tool is not signed in yet. The wait is bounded; on failure or a
 * timeout the person gets Retry and Skip for now, never an endless spinner.
 */
import { signInAgain, type SignInAgainDeps } from "../runtime-sign-in-again.js";
import type { FirstRunRuntime } from "./visual-first-run.js";

/** How long the first run waits on the browser sign-in before it offers Retry and Skip. */
export const FIRST_RUN_SIGNIN_TIMEOUT_MS = 5 * 60_000;

export const FIRST_RUN_SIGNIN_COPY = {
  waiting: (tool: string) => `Signing in to ${tool}…`,
  failed: "Sign-in didn't finish. Try again or skip for now.",
  skip: "Skip for now",
} as const;

/** What the takeover needs from the host to sign a coding tool in. */
export interface FirstRunSignInHost {
  /** Reads the stored login again: true when `runtime` is signed in here. */
  signedIn(runtime: FirstRunRuntime): Promise<boolean>;
  /**
   * Runs the tool's browser sign-in and waits for it (bounded). True once it
   * connected; false when it failed, timed out or was cancelled.
   */
  run(runtime: FirstRunRuntime, opts: { cancelled: () => boolean }): Promise<boolean>;
  /**
   * Stops the running browser sign-in (Skip, or the screen went away). When
   * it had connected after all, the host refreshes readiness so the held
   * report starts.
   */
  cancel?(runtime: FirstRunRuntime): Promise<void>;
}

/**
 * The tool's sign-in with the first run's wait bound. Resolves false (never
 * throws) when it did not connect; `deps.timeoutMs` overrides the bound only
 * for tests. Never forced: the "already signed in" read can be wrong (a
 * failed or slow preflight), and a forced sign-in signs the tool out first,
 * so the vendor's own probe decides and a signed-in person stays signed in.
 */
export async function runFirstRunSignIn(runtime: FirstRunRuntime, deps: SignInAgainDeps): Promise<boolean> {
  try {
    const result = await signInAgain(runtime, { timeoutMs: FIRST_RUN_SIGNIN_TIMEOUT_MS, ...deps, force: false });
    if (!result.ok && !result.cancelled) console.warn("[first-run] sign-in did not finish", result.reason);
    return result.ok;
  } catch (error) {
    console.warn("[first-run] sign-in failed", error);
    return false;
  }
}
