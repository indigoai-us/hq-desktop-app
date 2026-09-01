/**
 * Pure launch-path resolution for the "Finish setting up HQ" card
 * (SetupIncompleteCard.svelte). Mirrors the onboarding wizard's launch
 * preference order so the desktop window behaves exactly like the installer's
 * final step: Claude Code desktop deep link (with `/setup` pre-entered)
 * first, Claude CLI in a terminal second, nothing when neither is detected.
 */
import type { AiTools } from '../../lib/onboarding-summary';

export type ClaudeLaunchPath = 'deep-link' | 'cli' | 'none';

/** The prompt pre-entered into the launched agent session. */
export const SETUP_PROMPT = '/setup';

export function resolveClaudeLaunchPath(tools: AiTools | null): ClaudeLaunchPath {
  if (tools?.claude_desktop) return 'deep-link';
  if (tools?.claude_cli) return 'cli';
  return 'none';
}

export function codexAvailable(tools: AiTools | null): boolean {
  // codex_cli covers PATH installs AND the CLI bundled inside the ChatGPT
  // app (detect_ai_tools folds the bundled binary in), so desktop-only
  // machines launch too.
  return Boolean(tools?.codex_cli || tools?.codex_desktop);
}

export type CodexLaunchPath = 'desktop' | 'cli' | 'none';

/**
 * Codex launch preference order, mirroring `resolveClaudeLaunchPath`:
 * the ChatGPT desktop app's Codex surface first (workspace loaded via
 * `codex app <path>`, `/setup` pre-typed via `codex://threads/new?prompt=`),
 * a CLI in a terminal second, nothing when neither is detected.
 * `codex_desktop` means the ChatGPT/Codex app bundle is installed — exactly
 * the machines where `codex app` opens the desktop app.
 */
export function resolveCodexLaunchPath(tools: AiTools | null): CodexLaunchPath {
  if (tools?.codex_desktop) return 'desktop';
  if (tools?.codex_cli) return 'cli';
  return 'none';
}
