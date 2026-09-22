/**
 * The three runtime states the New bot wizard used to collapse into one.
 *
 * The wizard read two booleans — `available` and `loggedIn` — and rendered
 * `available && loggedIn` as "signed in". Everything else became
 * "Claude Code · not signed in" with a Sign in button, including the two
 * cases that button cannot fix: the CLI is not on this Mac at all, and the
 * probe could not get an answer out of it. The owner hit exactly that and saw
 * "Opening Claude Code sign-in…" sit there with nothing behind it.
 *
 * So the host now reads a discriminated status per runtime
 * (`agent_session_preflight` → `claudeStatus` / `codexStatus` / `grokStatus`)
 * and the rules here turn it into a chip, a footer and one honest action.
 *
 * Pure on purpose: every state's copy and gating is unit-tested without a DOM.
 */

/** What HQ knows about one runtime CLI on this Mac. Mirrors the Rust enum. */
export type RuntimeStatus =
  | { state: "signedIn" }
  | { state: "signedOut" }
  | { state: "notInstalled"; searched?: readonly string[] }
  | { state: "probeFailed"; reason?: string };

/** The action a runtime's footer offers; `null` when there is nothing to do. */
export type RuntimeAction = "signin" | "retry" | null;

export interface RuntimeFooter {
  /** The sentence under the pills. Plain words, never CLI output. */
  text: string;
  action: RuntimeAction;
  /** Label for the action button, when there is one. */
  actionLabel: string | null;
  /** True for the states the person should read as a problem. */
  isError: boolean;
}

/**
 * Read a status off the host's per-runtime map.
 *
 * `null`/unknown is NOT a state of its own: a host that predates the status
 * field (or one still loading) must keep the old optimistic behaviour, or
 * every runtime would render as broken for a second on every open.
 */
export function runtimeStatusOf(
  statuses: Readonly<Record<string, RuntimeStatus>> | null | undefined,
  id: string,
): RuntimeStatus | null {
  const status = statuses?.[id];
  if (!status || typeof status.state !== "string") return null;
  return status;
}

/** Parse whatever the host command returned into a status, or null. */
export function parseRuntimeStatus(raw: unknown): RuntimeStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.state) {
    case "signedIn":
      return { state: "signedIn" };
    case "signedOut":
      return { state: "signedOut" };
    case "notInstalled":
      return {
        state: "notInstalled",
        searched: Array.isArray(rec.searched) ? rec.searched.filter((d): d is string => typeof d === "string") : [],
      };
    case "probeFailed":
      return { state: "probeFailed", reason: typeof rec.reason === "string" ? rec.reason : "" };
    default:
      return null;
  }
}

/** Trailing text on the runtime pill: "Claude Code · not installed". */
export function runtimeChipSuffix(status: RuntimeStatus | null): string {
  switch (status?.state) {
    case "signedIn":
    case undefined:
      return "";
    case "signedOut":
      return " · not signed in";
    case "notInstalled":
      return " · not installed";
    case "probeFailed":
      return " · couldn’t check";
    default:
      return "";
  }
}

/**
 * Only a runtime whose binary was FOUND may be offered a sign-in. This is the
 * rule the missing state broke: a Sign in on a CLI that is not here spawns
 * nothing and leaves the modal on "Opening … sign-in…" forever.
 */
export function runtimeCanSignIn(status: RuntimeStatus | null): boolean {
  return status === null || status.state === "signedIn" || status.state === "signedOut";
}

/** Whether this status should stop the wizard advancing past the Home step. */
export function runtimeBlocksNext(status: RuntimeStatus | null): boolean {
  if (status === null) return false;
  return status.state !== "signedIn";
}

/** Where to get a runtime, named for the footer's not-installed line. */
const INSTALL_HINT: Readonly<Record<string, string>> = {
  claude: "Install it from claude.ai/download, or run “npm i -g @anthropic-ai/claude-code”.",
  codex: "Install it with the ChatGPT desktop app, or run “npm i -g @openai/codex”.",
  grok: "Install it with “npm i -g @vibe-kit/grok-cli”.",
};

/**
 * The sentence and action under the runtime pills, for one runtime.
 *
 * `canSignIn` is the host's own capability (is there a sign-in API wired at
 * all), kept separate from the status so a host with no sign-in path still
 * gets the right words with a "Settings → AI tools" fallback instead of a
 * button that does nothing.
 */
export function runtimeFooter(
  status: RuntimeStatus | null,
  label: string,
  id: string,
  canSignIn: boolean,
): RuntimeFooter {
  switch (status?.state) {
    case "notInstalled":
      return {
        text: `${label} isn’t installed on this Mac. ${INSTALL_HINT[id] ?? "Install it, then check again."}`,
        action: "retry",
        actionLabel: "Check again",
        isError: true,
      };
    case "probeFailed":
      return {
        text: `Couldn’t check ${label}${status.reason ? ` — ${status.reason}` : ""}.`,
        action: "retry",
        actionLabel: "Try again",
        isError: true,
      };
    case "signedOut":
      return {
        text: canSignIn
          ? `${label} is not signed in on this Mac.`
          : `${label} is not signed in on this Mac. Sign in under Settings → AI tools, or pick another.`,
        action: canSignIn ? "signin" : null,
        actionLabel: canSignIn ? "Sign in" : null,
        isError: false,
      };
    default:
      return {
        text: `Signed in on this Mac — the bot uses your own ${label} plan.`,
        action: null,
        actionLabel: null,
        isError: false,
      };
  }
}

/** The `stepIssue` line for a runtime that cannot host a bot yet. */
export function runtimeStepIssue(status: RuntimeStatus | null, label: string): string | null {
  switch (status?.state) {
    case "notInstalled":
      return `${label} isn’t installed on this Mac.`;
    case "probeFailed":
      return `HQ couldn’t check whether ${label} is signed in.`;
    case "signedOut":
      return `${label} is not signed in on this Mac.`;
    default:
      return null;
  }
}

/**
 * How long the sign-in may sit on "Opening … sign-in…" before it says
 * something. The host call that opens the browser resolves quickly when it
 * works; a spawn that never returns is the failure the owner saw, and silence
 * is the worst possible report of it.
 */
export const RUNTIME_SIGNIN_OPEN_TIMEOUT_MS = 20_000;

/** What that timeout says. */
export function runtimeSignInTimeoutMessage(label: string): string {
  return `${label} didn’t open its sign-in. Check that it is installed and working, then try again.`;
}
