import type { PlatformAdapter } from "@hq/platform";
import { buildClaudeCodeUrl } from "../projects/claude-code-link";

export interface AgentWorkflowResult {
  /** Whether the handoff opened, fell back to a usable clipboard prompt, or failed. */
  outcome: "opened" | "copied" | "failed";
  /** True when the Claude Code deep-link was dispatched; false when we fell
   *  back to copying the prompt (or couldn't even do that). */
  ok: boolean;
  /** Plain-language status the caller can surface in a toast. */
  message: string;
}

/** The two adapter slices the workflow handoff needs. */
export type AgentWorkflowApi = Pick<PlatformAdapter, "settings" | "shell">;

/**
 * Hand a prepared prompt to the Claude Code agent — opens a new session cwd'd
 * into the user's HQ folder via the dedicated shell.openClaudeCodeLink seam
 * (former desktop `open_claude_code_link` command).
 *
 * If the deep-link can't be dispatched (capability unavailable on this
 * platform, Claude Code not installed, link rejected), the prompt is copied to
 * the clipboard so the affordance is never a dead end. The returned message is
 * written for a toast, so every hq-* desktop action routes the SAME
 * getConfig → buildClaudeCodeUrl → openClaudeCodeLink → clipboard-fallback
 * sequence through one place.
 *
 * `label` (e.g. "deploy workflow") tunes the success/fallback copy so the toast
 * reads naturally per action.
 */
export async function openAgentWorkflow(
  api: AgentWorkflowApi,
  prompt: string,
  label = "workflow",
): Promise<AgentWorkflowResult> {
  try {
    const configRes = await api.settings.getConfig();
    const config = configRes.ok
      ? (configRes.value as { hqFolderPath?: string })
      : { hqFolderPath: "" };
    const url = buildClaudeCodeUrl({
      folder: config.hqFolderPath ?? "",
      prompt,
    });
    const opened = await api.shell.openClaudeCodeLink(url);
    if (!opened.ok) {
      throw new Error(opened.message ?? opened.code ?? opened.reason);
    }
    return {
      outcome: "opened",
      ok: true,
      message: `Opened the ${label} in Claude Code.`,
    };
  } catch (err) {
    console.error("openAgentWorkflow: openClaudeCodeLink failed:", err);
    try {
      await navigator.clipboard.writeText(prompt);
      return {
        outcome: "copied",
        ok: false,
        message: `Prompt copied — paste it into Claude Code to start the ${label}.`,
      };
    } catch {
      return {
        outcome: "failed",
        ok: false,
        message: "Could not open Claude Code or copy the prompt.",
      };
    }
  }
}
