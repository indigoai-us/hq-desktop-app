/**
 * The coding tool a person chose with "Continue in <tool>" on the first-run
 * decision. The press installs HQ into that tool and lands on the welcome
 * report; this choice is what the welcome edition, and later the Daily Brief,
 * uses to open the tool when they ask.
 */
export const BRIEF_OPEN_TOOL_KEY = "hq.brief.open-tool";

export type BriefOpenToolRuntime = "claude" | "codex" | "grok";

export interface BriefOpenToolAction {
  label: string;
  busy: boolean;
  error: string | null;
  onopen: () => void;
}

/** The button label. Claude Code and Codex use the names the decision screen uses. */
export function briefOpenToolLabel(runtime: BriefOpenToolRuntime): string {
  if (runtime === "codex") return "Open Codex";
  if (runtime === "grok") return "Open Grok";
  return "Open Claude Code";
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

export function rememberBriefOpenTool(runtime: BriefOpenToolRuntime): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, runtime);
  } catch (err) {
    console.warn("[brief] could not keep the open-tool choice", err);
  }
}

/** A new first run has not chosen Continue yet, so a previous choice does not leak into Skip. */
export function forgetBriefOpenTool(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(BRIEF_OPEN_TOOL_KEY);
  } catch (err) {
    console.warn("[brief] could not clear the open-tool choice", err);
  }
}
