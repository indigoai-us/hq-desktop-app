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
import {
  INSTALL_QUEUE_PROGRESS_EVENT,
  parseInstallQueueStatus,
  type InstallQueueHost,
  type InstallQueueStatus,
} from "../../shell/finishing-setup.js";
import type { SyncUnlistenFn } from "../../shell/sync-events.js";
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
  /**
   * Waits (bounded) for the tool's background install to settle before the
   * login. `retry` is the person's Retry press: a failed install is queued
   * again first. See `waitForToolInstall`.
   */
  waitForInstall?(
    runtime: FirstRunRuntime,
    opts: { cancelled: () => boolean; retry: boolean },
  ): Promise<FirstRunInstallWait>;
}

/** The install queue item that installs each coding tool. The queue does not install Grok. */
export const FIRST_RUN_TOOL_INSTALL_ITEM: Readonly<Partial<Record<FirstRunRuntime, string>>> = {
  claude: "claude-code",
  codex: "codex",
};

/**
 * How long the sign-in waits on the tool's install. The queue gives the
 * Claude Code and Codex items 20 minutes each; this leaves room for the item
 * ahead of it.
 */
export const FIRST_RUN_INSTALL_WAIT_MS = 25 * 60_000;
/**
 * How long an idle queue with the tool unsettled still counts as about to
 * run: on launch the queue reads idle until `resume_on_launch` starts it.
 */
export const FIRST_RUN_INSTALL_IDLE_GRACE_MS = 10_000;
const INSTALL_POLL_MS = 2_000;

/**
 * `present`: nothing to wait for (installed already, or no queue status).
 * `installed`: the wait ended with the item installed or skipped.
 * `failed`: the item failed or is blocked by a failed prerequisite, the queue
 * stopped short of it, or the wait ran out.
 */
export type FirstRunInstallWait = "present" | "installed" | "failed";

/**
 * Waits for the coding tool's install queue item to settle, reading the
 * queue status and its progress event. Never throws. With `retry`, a failed
 * or blocked item (or one the stopped queue left pending) is queued again
 * first.
 */
export async function waitForToolInstall(
  runtime: FirstRunRuntime,
  queue: InstallQueueHost,
  opts: { cancelled: () => boolean; retry?: boolean; timeoutMs?: number; pollMs?: number; idleGraceMs?: number },
): Promise<FirstRunInstallWait> {
  const id = FIRST_RUN_TOOL_INSTALL_ITEM[runtime];
  if (!id) return "present";
  const read = async (): Promise<InstallQueueStatus | null> => {
    try {
      return parseInstallQueueStatus(await queue.getStatus());
    } catch (error) {
      console.warn("[first-run] install queue status failed", error);
      return null;
    }
  };
  const first = await read();
  if (!first) return "present";
  let status: InstallQueueStatus = first;
  const unsettled = (s: InstallQueueStatus) => s.unsettled?.includes(id) ?? false;
  // Settled but not done or skipped: failed, or blocked by a failed prerequisite.
  const blocked = (s: InstallQueueStatus) => s.failed.includes(id) || (!unsettled(s) && (s.unfinished?.includes(id) ?? false));
  let kicked = false;
  if (opts.retry && (blocked(status) || (unsettled(status) && status.state !== "running"))) {
    try {
      await queue.retry();
      kicked = true;
    } catch (error) {
      console.warn("[first-run] install retry failed", error);
      return "failed";
    }
    status = (await read()) ?? status;
  }
  // An older app build sends no `unsettled`: wait while the queue runs.
  // After a retry the queue's runner was just started, so its first status
  // can still read idle. On launch the queue also reads idle until
  // `resume_on_launch` starts it, so idle holds for a short grace (ended
  // early by the first progress event) before it counts as stopped.
  const graceUntil = Date.now() + (opts.idleGraceMs ?? FIRST_RUN_INSTALL_IDLE_GRACE_MS);
  let progressed = false;
  const idleGrace = (s: InstallQueueStatus) => s.state === "idle" && !progressed && Date.now() < graceUntil;
  const holds = (s: InstallQueueStatus): boolean =>
    !s.failed.includes(id) &&
    (s.unsettled ? s.unsettled.includes(id) && (kicked || s.state === "running" || idleGrace(s)) : s.state === "running");
  const outcome = (waited: boolean): FirstRunInstallWait =>
    blocked(status) || unsettled(status) ? "failed" : waited || kicked ? "installed" : "present";
  if (!holds(status)) return outcome(false);

  const deadline = Date.now() + (opts.timeoutMs ?? FIRST_RUN_INSTALL_WAIT_MS);
  const pollMs = opts.pollMs ?? INSTALL_POLL_MS;
  let wake: (() => void) | null = null;
  let unlisten: SyncUnlistenFn | null = null;
  try {
    unlisten = await queue.listen(INSTALL_QUEUE_PROGRESS_EVENT, (event) => {
      const next = parseInstallQueueStatus(event?.payload);
      if (!next) return;
      status = next;
      progressed = true;
      wake?.();
    });
  } catch (error) {
    console.warn("[first-run] install queue listen failed", error);
  }
  try {
    while (holds(status)) {
      if (opts.cancelled()) return "failed";
      const left = deadline - Date.now();
      if (left <= 0) return "failed";
      // Wake when the idle grace ends so a queue that never started fails then.
      const graceLeft = idleGrace(status) ? graceUntil - Date.now() : Infinity;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Math.min(pollMs, left, graceLeft)));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
      if (!holds(status)) break;
      status = (await read()) ?? status;
    }
    return outcome(true);
  } finally {
    unlisten?.();
  }
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
