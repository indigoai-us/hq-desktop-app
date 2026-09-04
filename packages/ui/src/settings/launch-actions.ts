/**
 * Shared Claude / Codex / Grok launch cascades.
 *
 * WHY a factory, not three one-off copies: SetupChannelIntro pre-fills `/setup`
 * and the title-bar Launch menu opens a plain workspace in the same HQ folder.
 * The preference order (desktop deep link / ChatGPT Codex surface → CLI in a
 * terminal → clipboard last resort) must stay identical; only the prefilled
 * prompt and the "not detected" copy change. One module, two call sites, so a
 * cascade bug cannot regress in one surface and not the other.
 *
 * `prompt` is optional. SetupChannelIntro passes `SETUP_LAUNCH_COMMANDS`'
 * `/setup` strings (preserving clipboard copy + the "run /setup" error
 * wording). The title-bar Launch menu omits it so the session just opens at
 * the HQ root — no pre-typed command.
 */

import type { ShellApi } from "@hq/platform";
import { SETUP_LAUNCH_COMMANDS } from "../chat/setup-channel";
import { buildClaudeCodeUrl } from "./claude-code-link";
import {
  resolveClaudeLaunchPath,
  resolveCodexLaunchPath,
  type AiTools,
} from "./setup-launch";

export type LaunchKey = "claude" | "codex" | "grok";

export type LaunchShell = Pick<
  ShellApi,
  | "detectAiTools"
  | "openClaudeCodeLink"
  | "launchClaudeCode"
  | "launchCodexWorkspace"
  | "launchCliInTerminal"
>;

export interface LaunchActionsInput {
  shell: LaunchShell;
  /** Absolute HQ root the session opens in. Empty = no-op. */
  hqFolderPath: string;
  /**
   * Prefilled composer prompt. SetupChannelIntro passes `/setup`. Omit (or
   * pass empty) for a plain workspace launch — Claude's `q` param and Codex's
   * prompt argument are left unset, and error copy never tells the user to
   * run `/setup`.
   */
  prompt?: string;
  /**
   * Prompt for the Claude Code DESKTOP DEEP LINK only, when it must differ
   * from `prompt`. Defaults to `prompt`.
   *
   * WHY the seam exists: Claude Desktop scans skills before a folder handed
   * to it by a `claude://` link is trusted, so a project skill such as HQ's
   * `/setup` is not registered in the session the link opens and the
   * pre-typed slash command lands as an unknown command. The terminal-CLI
   * path settles trust before that scan, so it keeps `prompt` unchanged.
   */
  deepLinkPrompt?: string;
}

export interface LaunchActions {
  launchClaude(): Promise<string | null>;
  launchCodex(): Promise<string | null>;
  launchGrok(): Promise<string | null>;
}

type FailedLaunch = { ok: false; reason: string; message?: string };

function prefillOf(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim();
  return trimmed ? trimmed : undefined;
}

function failureMessage(res: FailedLaunch, what: string): string {
  if (res.reason === "unavailable") {
    return `${what} isn't available in this app. Use the HQ desktop app.`;
  }
  return `Could not open ${what}: ${res.message ?? "the command failed."}`;
}

function claudeNotDetectedMessage(prefill: string | undefined): string {
  if (prefill) {
    return `Claude Code was not detected. Open your HQ folder in Claude Code and run ${prefill}.`;
  }
  return "Claude Code was not detected. Open your HQ folder in Claude Code.";
}

function codexNotDetectedMessage(
  copied: boolean,
  prefill: string | undefined,
): string {
  if (prefill) {
    return copied
      ? `Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI) and run ${prefill} — the prompt was copied to your clipboard.`
      : `Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI) and run ${prefill}.`;
  }
  return "Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI).";
}

/**
 * Build the three per-tool launch functions for a given folder + optional
 * prompt. `detectAiTools` is cached on the returned object so Claude then
 * Codex in the same menu doesn't pay for two probes.
 */
export function createLaunchActions({
  shell,
  hqFolderPath,
  prompt,
  deepLinkPrompt,
}: LaunchActionsInput): LaunchActions {
  const folder = hqFolderPath.trim();
  const prefill = prefillOf(prompt);
  const deepLinkPrefill = prefillOf(deepLinkPrompt) ?? prefill;
  let aiTools: AiTools | null | undefined;

  async function ensureAiTools(): Promise<AiTools | null> {
    if (aiTools !== undefined) return aiTools;
    const res = await shell.detectAiTools();
    aiTools = res.ok ? (res.value as unknown as AiTools) : null;
    return aiTools;
  }

  async function launchClaude(): Promise<string | null> {
    if (!folder) return null;
    const path = resolveClaudeLaunchPath(await ensureAiTools());
    if (path === "deep-link") {
      const res = await shell.openClaudeCodeLink(
        buildClaudeCodeUrl({ folder, prompt: deepLinkPrefill }),
      );
      return res.ok ? null : failureMessage(res, "Claude Code");
    }
    if (path === "cli") {
      const res = await shell.launchClaudeCode(folder);
      return res.ok ? null : failureMessage(res, "Claude Code");
    }
    return claudeNotDetectedMessage(prefill);
  }

  async function launchCodex(): Promise<string | null> {
    if (!folder) return null;
    const tools = await ensureAiTools();
    const path = resolveCodexLaunchPath(tools);
    // Cascade: ChatGPT desktop app's Codex surface (workspace + optional
    // prompt pre-typed) → codex CLI in a terminal → clipboard copy of the
    // prompt when one was requested.
    if (path === "desktop") {
      const res = prefill
        ? await shell.launchCodexWorkspace(folder, prefill)
        : await shell.launchCodexWorkspace(folder);
      if (res.ok) return null;
      // Desktop launch failed — fall through to the terminal CLI if one
      // is on PATH, otherwise surface the failure.
      if (!tools?.codex_cli) {
        return failureMessage(res, "Codex");
      }
    }
    if (path !== "none") {
      const res = await shell.launchCliInTerminal({
        path: folder,
        tool: SETUP_LAUNCH_COMMANDS.codex.kind,
      });
      return res.ok ? null : failureMessage(res, "Codex");
    }
    let copied = false;
    if (prefill) {
      try {
        await navigator.clipboard.writeText(prefill);
        copied = true;
      } catch {
        copied = false;
      }
    }
    return codexNotDetectedMessage(copied, prefill);
  }

  async function launchGrok(): Promise<string | null> {
    if (!folder) return null;
    const res = await shell.launchCliInTerminal({
      path: folder,
      tool: SETUP_LAUNCH_COMMANDS.grok.tool,
    });
    return res.ok ? null : failureMessage(res, "Grok Build");
  }

  return { launchClaude, launchCodex, launchGrok };
}
