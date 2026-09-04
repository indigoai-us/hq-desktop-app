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

/**
 * Deep links cannot use the `/setup` slash command — Claude Desktop scans
 * skills before a link-opened folder is trusted, so HQ's project `/setup`
 * skill is suppressed in the session the link creates. Re-exported from the
 * shared constant so there is exactly one copy of that prompt text.
 */
export {
  SETUP_DEEP_LINK_PROMPT,
  SETUP_SKILL_PATH,
  SETUP_CORE_MARKER,
  SETUP_REPAIR_COMMAND,
  SETUP_BOOTSTRAP_COMMAND,
} from "../chat/setup-channel.js";

/**
 * The prompt pre-entered into a TERMINAL agent session, and the text copied
 * to the clipboard when no tool is detected. Terminal launches settle folder
 * trust before the skill scan, so the slash command works there.
 * Deep links must use `SETUP_DEEP_LINK_PROMPT` instead.
 */
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

export type CodexLaunchPath = "desktop" | "cli" | "none";

/**
 * Codex launch preference order, mirroring `resolveClaudeLaunchPath`:
 * the ChatGPT desktop app's Codex surface first (workspace loaded via the
 * bundled CLI's `codex app <path>`, `/setup` pre-typed via
 * `codex://threads/new?prompt=`), a PATH-installed CLI in a terminal second,
 * nothing when neither is detected. `codex_desktop` means the ChatGPT/Codex
 * app bundle is installed — exactly the machines where `codex app` works.
 */
export function resolveCodexLaunchPath(tools: AiTools | null): CodexLaunchPath {
  if (tools?.codex_desktop) return "desktop";
  if (tools?.codex_cli) return "cli";
  return "none";
}
