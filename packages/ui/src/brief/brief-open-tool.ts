/**
 * The coding tool a person chose with "Continue in <tool>" on the first-run
 * decision. The press installs HQ into that tool and lands on the welcome
 * report; this choice is what the welcome edition, and later the Daily Brief,
 * uses to open the tool when they ask.
 */
export const BRIEF_OPEN_TOOL_KEY = "hq.brief.open-tool";
/** "1" only when the HQ install for that tool returned ok. Absent means it did not. */
export const BRIEF_OPEN_TOOL_INSTALLED_KEY = "hq.brief.open-tool-installed";

export type BriefOpenToolRuntime = "claude" | "codex" | "grok";

export interface BriefOpenToolAction {
  label: string;
  /** One line under the button. Says the tool is set up only when the install worked. */
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
 * The line under Open. The set-up sentence is only for an install that
 * returned ok. Anything else stays honest and leaves Copy on the connect card.
 */
export function briefOpenToolContext(runtime: BriefOpenToolRuntime, installed: boolean): string {
  const name = briefOpenToolName(runtime);
  if (installed) return `${name} is set up with HQ. Open it to keep working there.`;
  return `HQ is not installed in ${name} yet. You can still open it.`;
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

export function rememberBriefOpenTool(runtime: BriefOpenToolRuntime, installed = false): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, runtime);
    window.localStorage.setItem(BRIEF_OPEN_TOOL_INSTALLED_KEY, installed ? "1" : "0");
  } catch (err) {
    console.warn("[brief] could not keep the open-tool choice", err);
  }
}

/** True only when Continue's install for the remembered tool returned ok. */
export function readBriefOpenToolInstalled(): boolean {
  if (!readBriefOpenTool()) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BRIEF_OPEN_TOOL_INSTALLED_KEY) === "1";
  } catch (err) {
    console.warn("[brief] could not read whether HQ was installed", err);
    return false;
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
