/**
 * The coding tool a person chose with "Continue in <tool>" on the first-run
 * decision. The press installs HQ into that tool and lands on the welcome
 * report; this choice is what the welcome edition, and later the Daily Brief,
 * uses to open the tool when they ask.
 */
export const BRIEF_OPEN_TOOL_KEY = "hq.brief.open-tool";
/**
 * How Continue left the install. Older sessions stored "1" (the install
 * returned ok) or "0" (it did not). A live check replaces a stale "1".
 */
export const BRIEF_OPEN_TOOL_INSTALLED_KEY = "hq.brief.open-tool-installed";

export type BriefOpenToolRuntime = "claude" | "codex" | "grok";

/** What Continue recorded. `pending` is still running. `skipped` installed nothing. */
export type BriefInstallSettle = "installed" | "pending" | "failed" | "skipped";

/** What the line under Open says, after a live check is applied. */
export type BriefInstallView = "installed" | "pending" | "failed" | "folder";

export interface BriefOpenToolAction {
  label: string;
  /** One line under the button. Says the tool is set up only when HQ is installed now. */
  detail: string;
  busy: boolean;
  error: string | null;
  onopen: () => void;
}

/** The name the decision screen uses. */
export function briefOpenToolName(runtime: BriefOpenToolRuntime): string {
  if (runtime === "codex") return "Codex";
  if (runtime === "grok") return "Grok";
  return "Claude Code";
}

/** The button label. Claude Code and Codex use the names the decision screen uses. */
export function briefOpenToolLabel(runtime: BriefOpenToolRuntime): string {
  return `Open ${briefOpenToolName(runtime)}`;
}

/**
 * The line under Open.
 * `installed` is a live install. `pending` is still running and must not be
 * frozen as failed. `failed` is a real install error after Enable. `folder`
 * is Not now, HQ Anywhere off, or a setup that was removed.
 */
export function briefOpenToolContext(runtime: BriefOpenToolRuntime, view: BriefInstallView): string {
  const name = briefOpenToolName(runtime);
  if (view === "installed") return `${name} is set up with HQ. Open it to keep working there.`;
  if (view === "pending") return `HQ is still setting up in ${name}. You can open it in your HQ folder.`;
  if (view === "failed") return `HQ is not installed in ${name} yet. You can try again from Settings.`;
  return `Open ${name} in your HQ folder to keep working there.`;
}

/**
 * The install-queue item that is still installing HQ. Any other running
 * item, including node, is not this install.
 */
export const BRIEF_INSTALL_QUEUE_ITEM = "hq-cli";

/** True only while the queue is running the HQ command-line install. */
export function briefInstallQueueStillRunning(
  status: { state: string; currentId: string | null } | null,
): boolean {
  return status?.state === "running" && status.currentId === BRIEF_INSTALL_QUEUE_ITEM;
}

/**
 * What to store after a live check. A miss clears a recorded install that
 * is gone. A pending install that is still running stays pending. After a
 * restart the install is not running, so pending plus not installed is a
 * failure. `checked` null is not this function: the recorded settle stands.
 */
export function briefInstallAfterCheck(
  settle: BriefInstallSettle,
  checked: boolean,
  stillRunning = false,
): BriefInstallSettle {
  if (checked) return "installed";
  if (settle === "pending") return stillRunning ? "pending" : "failed";
  if (settle === "failed") return "failed";
  return "skipped";
}

/** A timed-out install's real result. Ignored once a later check already moved on. */
export function briefInstallAfterSettle(settle: BriefInstallSettle, ok: boolean): BriefInstallSettle {
  if (settle !== "pending") return settle;
  return ok ? "installed" : "failed";
}

export function briefOpenToolView(
  settle: BriefInstallSettle,
  checked: boolean | null,
  stillRunning = false,
): BriefInstallView {
  if (checked === true) return "installed";
  if (checked === false && settle === "pending") return stillRunning ? "pending" : "failed";
  if (checked === false && settle === "failed") return "failed";
  if (checked === false) return "folder";
  if (settle === "installed") return "installed";
  if (settle === "pending") return "pending";
  if (settle === "failed") return "failed";
  return "folder";
}

/** The Connect your AI apps row for this tool. Grok has no HQ install. */
export function briefOpenToolConnectorId(runtime: BriefOpenToolRuntime | null): "claude-code" | "codex" | null {
  if (runtime === "claude") return "claude-code";
  if (runtime === "codex") return "codex";
  return null;
}

function isRuntime(value: string | null): value is BriefOpenToolRuntime {
  return value === "claude" || value === "codex" || value === "grok";
}

export function readBriefOpenTool(): BriefOpenToolRuntime | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(BRIEF_OPEN_TOOL_KEY);
    return isRuntime(value) ? value : null;
  } catch (err) {
    console.warn("[brief] could not read the open-tool choice", err);
    return null;
  }
}

function isSettle(value: string | null): value is BriefInstallSettle {
  return value === "installed" || value === "pending" || value === "failed" || value === "skipped";
}

export function rememberBriefOpenTool(runtime: BriefOpenToolRuntime, settle: BriefInstallSettle = "skipped"): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, runtime);
    window.localStorage.setItem(BRIEF_OPEN_TOOL_INSTALLED_KEY, settle);
  } catch (err) {
    console.warn("[brief] could not keep the open-tool choice", err);
  }
}

/** What Continue recorded. An older "1" is installed; an older "0" installed nothing. */
export function readBriefOpenToolSettle(): BriefInstallSettle {
  if (!readBriefOpenTool()) return "skipped";
  if (typeof window === "undefined") return "skipped";
  try {
    const value = window.localStorage.getItem(BRIEF_OPEN_TOOL_INSTALLED_KEY);
    if (value === "1") return "installed";
    if (isSettle(value)) return value;
    return "skipped";
  } catch (err) {
    console.warn("[brief] could not read whether HQ was installed", err);
    return "skipped";
  }
}

/** A new first run has not chosen Continue yet, so a previous choice does not leak into Skip. */
export function forgetBriefOpenTool(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(BRIEF_OPEN_TOOL_KEY);
    window.localStorage.removeItem(BRIEF_OPEN_TOOL_INSTALLED_KEY);
  } catch (err) {
    console.warn("[brief] could not clear the open-tool choice", err);
  }
}
