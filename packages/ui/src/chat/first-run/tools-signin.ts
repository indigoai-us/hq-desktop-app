/**
 * Sign in on the first run's coding tools screen (owner, 2026-10-10: "We
 * totally need at least one coding tool signed in since the local bot runs on
 * that so we should facilitate signin").
 *
 * While no coding tool is signed in, the screen shows one row per tool
 * (Claude Code and Codex) with a one-click Sign in. Sign in runs the tool's
 * own browser login in the background through the host
 * (`agent_provider_login_start`: `claude auth login` / `codex login` on the
 * binary HQ will run), then readiness is read again from
 * `agent_session_preflight`. Nothing here reads or copies a desktop app's own
 * login, signs in on its own, or installs anything without a press.
 *
 * Most people have Claude Desktop or the ChatGPT app rather than a terminal,
 * so the screen leads with the tool whose desktop app is here and names it.
 * Pure on purpose: the rules and every line of copy are unit-tested here, the
 * runner is tested with fake timers, and FirstRunToolsSignIn.svelte only
 * renders them.
 */

import type { AiTools } from "../../install-choice/install-choice.js";
import type { RuntimeSignInApi, RuntimeSignInState } from "../create-bot/RuntimeSignIn.svelte";
import type { RuntimeStatus } from "../create-bot/runtime-status.js";

/** The coding tools the first run helps sign in to. */
export type SignInTool = "claude" | "codex";
export const SIGN_IN_TOOLS: readonly SignInTool[] = ["claude", "codex"];

/**
 * What a tool's row offers before anything is pressed.
 *
 *   checking     readiness is not known yet: no button.
 *   signIn       the binary HQ runs is here and signed out: Sign in.
 *   signedIn     the binary HQ runs says it is signed in.
 *   openDesktop  the desktop app is here but HQ has no runnable CLI from it
 *                (Claude Desktop before its Code tab was used): open the app.
 *   install      neither the CLI nor its desktop app is here: Install.
 *   recheck      HQ could not get an answer from the CLI: Try again.
 */
export type ToolRowKind = "checking" | "signIn" | "signedIn" | "openDesktop" | "install" | "recheck";

export const TOOL_LABEL: Readonly<Record<SignInTool, string>> = { claude: "Claude Code", codex: "Codex" };
/** The desktop app that carries each tool, as people know it. */
export const TOOL_APP: Readonly<Record<SignInTool, string>> = { claude: "Claude", codex: "ChatGPT" };

/** Whether the tool's desktop app is on this computer (`detect_ai_tools`). */
export function desktopAppHere(tool: SignInTool, tools: AiTools | null | undefined): boolean {
  return tool === "claude" ? tools?.claude_desktop === true : tools?.codex_desktop === true;
}

/**
 * The row's kind, from the per-tool status (`agent_session_preflight`
 * `claudeStatus` / `codexStatus`), the readiness booleans (`Available &&
 * LoggedIn`) and the desktop apps found. Signed in is ONLY what the binary HQ
 * runs reported: a desktop app being here never counts as signed in.
 */
export function toolRowKind(
  tool: SignInTool,
  status: RuntimeStatus | null,
  ready: Record<string, boolean> | null | undefined,
  tools: AiTools | null | undefined,
): ToolRowKind {
  if (ready?.[tool] === true || status?.state === "signedIn") return "signedIn";
  switch (status?.state) {
    case "signedOut":
      return "signIn";
    case "notInstalled":
      return desktopAppHere(tool, tools) ? "openDesktop" : "install";
    case "probeFailed":
      return "recheck";
    default:
      // A host without per-tool status: the booleans are all there is.
      return ready ? "signIn" : "checking";
  }
}

/**
 * The tool the screen leads with and preselects: the one whose desktop app is
 * here and that can be signed in to now (Claude first when both), else any
 * tool that can be signed in to, else the one whose desktop app is here, else
 * Claude Code.
 */
export function preferredSignInTool(
  kinds: Readonly<Record<SignInTool, ToolRowKind>>,
  tools: AiTools | null | undefined,
): SignInTool {
  const ok = (tool: SignInTool) => kinds[tool] === "signIn" || kinds[tool] === "signedIn";
  return (
    SIGN_IN_TOOLS.find((tool) => desktopAppHere(tool, tools) && ok(tool)) ??
    SIGN_IN_TOOLS.find(ok) ??
    SIGN_IN_TOOLS.find((tool) => desktopAppHere(tool, tools)) ??
    "claude"
  );
}

/** The rows in screen order: the preferred tool first. */
export function orderedSignInTools(preferred: SignInTool): SignInTool[] {
  return [preferred, ...SIGN_IN_TOOLS.filter((tool) => tool !== preferred)];
}

/** The one-click Sign in on a tool's row. */
export function toolSignInLabel(tool: SignInTool): string {
  return `Sign in with your ${TOOL_APP[tool]} account`;
}

/**
 * The sentence under the title while no tool is signed in. Names the account
 * to use when the lead tool's desktop app is here.
 */
export function toolsSignInLead(
  name: string,
  noun: string,
  preferred: SignInTool,
  kinds: Readonly<Record<SignInTool, ToolRowKind>>,
  tools: AiTools | null | undefined,
): string {
  const shown = name.trim() || "Your assistant";
  const host = noun.trim() || "computer";
  if (desktopAppHere(preferred, tools) && kinds[preferred] === "signIn") {
    return `${shown} thinks with ${TOOL_LABEL[preferred]} on this ${host}. You have the ${TOOL_APP[preferred]} app, so sign in with your ${TOOL_APP[preferred]} account. One coding tool is enough.`;
  }
  return `${shown} thinks with a coding tool signed in on this ${host}, under your own login. Sign in to one to go on.`;
}

/** The quiet line on a row that has nothing running. */
export function toolRowNote(tool: SignInTool, kind: ToolRowKind, noun: string): string {
  const host = noun.trim() || "computer";
  const app = TOOL_APP[tool];
  switch (kind) {
    case "checking":
      return "Checking…";
    case "signIn":
      return "Opens your browser to sign in.";
    case "signedIn":
      return "Signed in.";
    case "openDesktop":
      return tool === "claude"
        ? `The ${app} app is here, but Claude Code is not set up in it yet. Open ${app} and use its Code tab once, then come back.`
        : `The ${app} app is here, but its Codex is not ready yet. Open ${app} and use Codex once, then come back.`;
    case "install":
      return `Not on this ${host} yet.`;
    case "recheck":
      return `HQ couldn't check ${TOOL_LABEL[tool]}.`;
  }
}

/** The row's button for its kind; null when there is nothing to press. */
export function toolRowAction(tool: SignInTool, kind: ToolRowKind): string | null {
  switch (kind) {
    case "signIn":
      return toolSignInLabel(tool);
    case "openDesktop":
      return `Open ${TOOL_APP[tool]}`;
    case "install":
      return `Install ${TOOL_LABEL[tool]}`;
    case "recheck":
      return "Try again";
    default:
      return null;
  }
}

/** Plain copy for a press that is running or failed. Never host or CLI text. */
export const TOOL_SIGNIN_COPY = {
  opening: "Opening your browser…",
  waiting: "Finish signing in in your browser. HQ will notice on its own.",
  connected: "Signed in.",
  failed: "Sign in did not finish.",
  retry: "Try again",
  cancel: "Cancel",
  checking: "Checking…",
  openFailed: (tool: SignInTool) => `HQ couldn't open ${TOOL_APP[tool]}.`,
  opened: (tool: SignInTool) =>
    tool === "claude"
      ? `When Claude Code is set up in ${TOOL_APP[tool]}, come back here.`
      : `When Codex is ready in ${TOOL_APP[tool]}, come back here.`,
  installing: (tool: SignInTool, noun: string) =>
    `Installing ${TOOL_LABEL[tool]} on this ${noun.trim() || "computer"}. This takes about a minute.`,
  installFailed: "That did not work.",
} as const;

// ── the sign-in runner ─────────────────────────────────────────────────────

export type ToolSignInPhase = "opening" | "waiting" | "connected" | "failed";

export interface ToolSignInState {
  tool: SignInTool;
  phase: ToolSignInPhase;
}

/** How long a row may say "Checking…" before it offers Check again. */
export const TOOL_CHECKING_STALE_MS = 10_000;

/** How long opening the sign-in may take before the row says it failed. */
export const TOOL_SIGNIN_OPEN_TIMEOUT_MS = 20_000;

export interface ToolSignInRunnerOptions {
  api: RuntimeSignInApi;
  /** Every change of the one sign-in, or null when none is on screen. */
  onchange: (state: ToolSignInState | null) => void;
  /** The tool said it is signed in: read readiness again. */
  onconnected: (tool: SignInTool) => void | Promise<void>;
  /** The sign-in ended without one: read readiness again anyway. */
  onfailed?: (tool: SignInTool) => void | Promise<void>;
  pollMs?: number;
  openTimeoutMs?: number;
}

export interface ToolSignInRunner {
  /** Start one tool's sign-in. Held while one is opening or waiting. */
  start(tool: SignInTool): void;
  /** Stop the sign-in on screen; the host's login is cancelled best effort. */
  cancel(): void;
  current(): ToolSignInState | null;
  dispose(): void;
}

/**
 * One sign-in at a time: start the host's login, poll its status until it
 * connects or ends, and report each step. Opening has a deadline, so a host
 * call that never answers still ends in a plain failure with Try again.
 */
export function createToolSignInRunner(options: ToolSignInRunnerOptions): ToolSignInRunner {
  const pollMs = options.pollMs ?? 1500;
  const openTimeoutMs = options.openTimeoutMs ?? TOOL_SIGNIN_OPEN_TIMEOUT_MS;
  let state: ToolSignInState | null = null;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;

  function set(next: ToolSignInState | null): void {
    state = next;
    options.onchange(next);
  }
  function clearTimers(): void {
    clearTimeout(pollTimer);
    clearTimeout(openTimer);
    pollTimer = undefined;
    openTimer = undefined;
  }
  function fail(tool: SignInTool, token: number, cancelHost = false): void {
    if (token !== generation) return;
    generation += 1;
    clearTimers();
    set({ tool, phase: "failed" });
    // A start that never answered may still open the browser later: call it
    // off, so nothing opens after the row said it did not finish.
    if (cancelHost) void Promise.resolve().then(() => options.api.loginCancel?.(tool)).catch(() => {});
    void options.onfailed?.(tool);
  }
  function apply(tool: SignInTool, token: number, result: RuntimeSignInState): void {
    if (token !== generation) return;
    clearTimeout(openTimer);
    openTimer = undefined;
    if (result.state === "connected") {
      generation += 1;
      clearTimers();
      set({ tool, phase: "connected" });
      void options.onconnected(tool);
      return;
    }
    if (result.state === "waiting") {
      if (state?.phase !== "waiting") set({ tool, phase: "waiting" });
      pollTimer = setTimeout(() => void poll(tool, token), pollMs);
      return;
    }
    // "error", or "disconnected" (the login ended without signing in). The
    // host's words go to the log only.
    if (result.message) console.warn("[first-run] sign-in ended:", result.message);
    fail(tool, token);
  }
  async function poll(tool: SignInTool, token: number): Promise<void> {
    let result: RuntimeSignInState;
    try {
      result = await options.api.loginStatus(tool);
    } catch (error) {
      console.warn("[first-run] sign-in status check failed:", error);
      result = { state: "error" };
    }
    apply(tool, token, result);
  }

  return {
    start(tool) {
      if (state && (state.phase === "opening" || state.phase === "waiting")) return;
      generation += 1;
      const token = generation;
      clearTimers();
      set({ tool, phase: "opening" });
      openTimer = setTimeout(() => fail(tool, token, true), openTimeoutMs);
      void Promise.resolve()
        .then(() => options.api.loginStart(tool))
        .then(
          (result) => result,
          (error: unknown): RuntimeSignInState => {
            console.warn("[first-run] opening sign-in failed:", error);
            return { state: "error" };
          },
        )
        .then((result) => apply(tool, token, result));
    },
    cancel() {
      const tool = state?.tool;
      generation += 1;
      clearTimers();
      set(null);
      if (tool) void Promise.resolve(options.api.loginCancel?.(tool)).catch(() => {});
    },
    current: () => state,
    dispose() {
      generation += 1;
      clearTimers();
    },
  };
}

/** Every tool's row kind at once. */
export function toolRowKinds(
  statuses: Readonly<Record<string, RuntimeStatus>> | null | undefined,
  ready: Record<string, boolean> | null | undefined,
  tools: AiTools | null | undefined,
): Record<SignInTool, ToolRowKind> {
  const statusOf = (tool: SignInTool): RuntimeStatus | null => {
    const status = statuses?.[tool];
    return status && typeof status.state === "string" ? status : null;
  };
  return {
    claude: toolRowKind("claude", statusOf("claude"), ready, tools),
    codex: toolRowKind("codex", statusOf("codex"), ready, tools),
  };
}
