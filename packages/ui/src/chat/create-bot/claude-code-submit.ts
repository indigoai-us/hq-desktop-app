/**
 * The Claude code paste-back on the New Bot waking screen.
 *
 * The server types the pasted code into the bot machine's Claude sign-in and
 * answers with what Claude said: `accepted`, `rejected` or `unknown`. The
 * screen used to treat any answer as "sent", empty the field, and wait for the
 * next scheduled re-check, so a code the machine was not ready for (or one
 * whose result could not be seen) left the person with an empty field and
 * nothing moving (owner, 2026-10-10: "the code disappeared and nothing
 * happened"; the second submit worked).
 *
 * This runs one submit to the end: it sends the code, asks the server to
 * re-check right away, and keeps checking for a bounded time. When Claude's
 * answer is not known, the code is sent once more, as the person had to do by
 * hand. The result is one of four plain outcomes the screen can show.
 */

/**
 * accepted / rejected / unknown: what Claude said, as the server reports it.
 * transient: the request failed in a way that does not say whether the code
 * reached the machine (network, client timeout, 5xx including the gateway's
 * 504). invalid: the server refused the value as not a Claude code.
 * failed: any other refusal (4xx); the code was not delivered.
 */
export type ClaudeCodeAnswer = "accepted" | "rejected" | "unknown" | "transient" | "invalid" | "failed";
export type ClaudeCodeResult = "signed-in" | "rejected" | "invalid" | "failed" | "timeout";

/** How long one submit keeps checking for the sign-in after each send. */
export const CLAUDE_CODE_CONFIRM_MS = 45_000;
/** How long to wait for the sign-in before the code is sent once more, when Claude's answer is not known. */
export const CLAUDE_CODE_RESEND_AFTER_MS = 15_000;
/** Time between two checks while waiting. */
export const CLAUDE_CODE_CHECK_EVERY_MS = 3_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failureStatus(answer: Record<string, unknown>): number | null {
  if (typeof answer.status === "number") return answer.status;
  const match = typeof answer.code === "string" ? /^http-(\d{3})$/i.exec(answer.code.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** A failed request: a refusal (4xx) or a fate that is not known. */
function failedAnswer(answer: Record<string, unknown> | null): ClaudeCodeAnswer {
  if (!answer) return "transient";
  const code = typeof answer.code === "string" ? answer.code.trim() : "";
  if (code === "LOGIN_CODE_INVALID") return "invalid";
  const status = failureStatus(answer);
  return status !== null && status >= 400 && status < 500 ? "failed" : "transient";
}

/**
 * What the server said about one submitted code. A server that does not
 * report Claude's answer (an older one) reads as `unknown`, so the screen
 * still waits for the sign-in.
 */
export function claudeCodeAnswer(result: unknown): ClaudeCodeAnswer {
  const answer = record(result);
  if (!answer || answer.ok !== true) return failedAnswer(answer);
  const value = record(answer.value);
  if (value?.ok === false) return failedAnswer(value);
  const outcome = value?.outcome;
  return outcome === "accepted" || outcome === "rejected" ? outcome : "unknown";
}

export interface ClaudeCodeSubmitDeps {
  /** Send the code. Resolves with the adapter result. */
  send: () => Promise<unknown>;
  /** Ask the server to re-check and read the status. True once the sign-in is seen done. */
  confirm: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** True once nobody waits for the result any more (the screen closed). */
  cancelled?: () => boolean;
  /** Details for the log. Never carries the code. */
  log?: (event: string, detail: Record<string, string | number>) => void;
  /** Skip the send: the code was already accepted and only the check is repeated. */
  alreadyAccepted?: boolean;
  confirmMs?: number;
  resendAfterMs?: number;
  checkEveryMs?: number;
}

async function sendOnce(deps: ClaudeCodeSubmitDeps, attempt: number): Promise<ClaudeCodeAnswer> {
  let answer: ClaudeCodeAnswer;
  try {
    answer = claudeCodeAnswer(await deps.send());
  } catch {
    answer = "transient";
  }
  deps.log?.("claude-code-sent", { attempt, answer });
  return answer;
}

/** Check until the sign-in is seen or `untilMs` passes. */
async function waitForSignIn(deps: ClaudeCodeSubmitDeps, untilMs: number): Promise<boolean> {
  const every = Math.max(1, deps.checkEveryMs ?? CLAUDE_CODE_CHECK_EVERY_MS);
  for (;;) {
    if (deps.cancelled?.()) return false;
    let done = false;
    try {
      done = await deps.confirm();
    } catch {
      done = false;
    }
    if (done) return true;
    if (deps.now() >= untilMs || deps.cancelled?.()) return false;
    await deps.sleep(Math.min(every, Math.max(1, untilMs - deps.now())));
  }
}

/** Run one press of Submit to its end. */
export async function submitClaudeCode(deps: ClaudeCodeSubmitDeps): Promise<ClaudeCodeResult> {
  const confirmMs = deps.confirmMs ?? CLAUDE_CODE_CONFIRM_MS;
  const resendAfterMs = Math.min(deps.resendAfterMs ?? CLAUDE_CODE_RESEND_AFTER_MS, confirmMs);
  let answer: ClaudeCodeAnswer = deps.alreadyAccepted ? "accepted" : await sendOnce(deps, 1);
  if (answer === "rejected" || answer === "invalid" || answer === "failed") {
    deps.log?.("claude-code-result", { result: answer });
    return answer;
  }
  if (answer === "transient") {
    // The request may have reached the machine before it failed here. Look
    // for the sign-in for a while, and do not send the code again: it may be
    // on its way already.
    const seen = await waitForSignIn(deps, deps.now() + resendAfterMs);
    deps.log?.("claude-code-result", { result: seen ? "signed-in" : "timeout", answer });
    return seen ? "signed-in" : "timeout";
  }
  if (answer === "unknown") {
    // Claude's answer was not seen. The machine may not have been at the
    // prompt yet; wait a little, then send the same code once more.
    if (await waitForSignIn(deps, deps.now() + resendAfterMs)) return "signed-in";
    if (deps.cancelled?.()) return "timeout";
    answer = await sendOnce(deps, 2);
    if (answer === "rejected" || answer === "invalid" || answer === "failed") return answer;
  }
  const seen = await waitForSignIn(deps, deps.now() + confirmMs);
  const result: ClaudeCodeResult = seen ? "signed-in" : "timeout";
  deps.log?.("claude-code-result", { result, answer });
  return result;
}
