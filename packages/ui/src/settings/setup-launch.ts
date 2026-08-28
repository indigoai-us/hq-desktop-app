/**
 * Pure launch-path resolution for the "Finish setting up HQ" card
 * (SetupIncompleteCard.svelte). Mirrors the onboarding wizard's launch
 * preference order so the desktop window behaves exactly like the installer's
 * final step: Claude Code desktop deep link (with `/setup` pre-entered)
 * first, Claude CLI in a terminal second, nothing when neither is detected.
 *
 * `AiTools` is inlined here (from the desktop `lib/onboarding-summary.ts`)
 * so packages/ui stays self-contained; the adapter's `shell.detectAiTools`
 * payload maps onto it structurally.
 */

export interface AiTools {
  claude_cli: boolean;
  claude_desktop: boolean;
  codex_cli: boolean;
  codex_desktop: boolean;
  grok_cli: boolean;
  claude_last_used_ms: number | null;
  codex_last_used_ms: number | null;
  grok_last_used_ms: number | null;
  any: boolean;
}

export const NO_AI_TOOLS: AiTools = {
  claude_cli: false,
  claude_desktop: false,
  codex_cli: false,
  codex_desktop: false,
  grok_cli: false,
  claude_last_used_ms: null,
  codex_last_used_ms: null,
  grok_last_used_ms: null,
  any: false,
};

export type ClaudeLaunchPath = "deep-link" | "cli" | "none";

/** The prompt pre-entered into the launched agent session. */
export const SETUP_PROMPT = "/setup";

export function resolveClaudeLaunchPath(
  tools: AiTools | null,
): ClaudeLaunchPath {
  if (tools?.claude_desktop) return "deep-link";
  if (tools?.claude_cli) return "cli";
  return "none";
}

export function codexAvailable(tools: AiTools | null): boolean {
  return Boolean(tools?.codex_cli);
}
