/**
 * Install-choice adapter — pure functions that turn "no coding tool on this
 * computer" into a set of buttons the person can actually press. The rule is
 * the operator's rule: never tell them to open a terminal or type a command.
 *
 * Two paths exist. When one of the assistant desktop apps IS on this
 * computer (Claude Desktop for Claude Code, or the ChatGPT desktop app for
 * Codex), HQ can open it with a fixed prompt already in the composer that
 * asks the assistant to install the tool. When neither app is here (or the
 * person is on the web), HQ falls back to its own one-click installer that
 * runs the installer itself and then opens the tool's sign-in. The panel
 * that renders these is imported by BOTH the New bot wizard and the setup
 * assistant so the two cannot drift.
 *
 * Security: the prompt and every URL are built here from fixed strings. The
 * server never contributes text and neither does any other user. The URL
 * builder uses `URLSearchParams` for encoding so the byte-level validator
 * in Rust (`validate_assistant_deep_link`) accepts the result.
 */

import type { AiTools } from "../settings/setup-launch.js";
export type { AiTools } from "../settings/setup-launch.js";

/** The two assistant desktop apps HQ can hand a prompt to. */
export type AssistantId = "claude-desktop" | "chatgpt-desktop";

/** The coding tool HQ is trying to get on this computer. */
export type CodingTool = "claude" | "codex";

/**
 * Plain-language reason the direct install failed, or a dispatch failed.
 * Mirrors the shape SetupInstallGuide already uses so adapter callbacks
 * are shared.
 */
export interface InstallOutcome {
  ok: boolean;
  reason?: string;
}

/**
 * One thing the person can press when their coding tool is missing.
 *
 * `assistant` — open the person's assistant app with the install prompt
 *   pre-filled in the composer. The person still presses send inside the
 *   assistant app; auto-send is not part of any documented URL contract.
 * `direct-install` — HQ runs the platform installer itself, then opens the
 *   tool's own sign-in. The existing SetupInstallGuide path.
 * `probing` — a placeholder while `detect_ai_tools` is still resolving. No
 *   button yet; the panel renders a neutral checking line.
 */
export type InstallChoice =
  | {
      kind: "assistant";
      assistant: AssistantId;
      tool: CodingTool;
      /** The URL to hand to the OS URL dispatcher. `claude://` or `codex://`. */
      deepLink: string;
      /** Button label the person reads. */
      buttonLabel: string;
    }
  | {
      kind: "direct-install";
      tool: CodingTool;
      buttonLabel: string;
    }
  | { kind: "probing" };

/**
 * The install prompt HQ hands to Claude Desktop's Code area. This is the
 * message that appears in Claude Code's composer when the person clicks
 * "Set up with Claude" — they press send and Claude Code walks them through
 * installing the CLI on their computer. Fixed here so a test can pin it and
 * so no server can alter the text.
 */
export const INSTALL_VIA_CLAUDE_PROMPT =
  "I am setting up HQ on this computer. HQ needs Claude Code installed here so my HQ bots can work. Please install Claude Code with Anthropic's official installer for this operating system, check that it runs, and help me sign in with my Claude account. Ask me before you run anything you are unsure about. When it is done, tell me to go back to HQ and click Check again.";

/**
 * The install prompt HQ hands to the ChatGPT desktop app's Codex area. Codex
 * inside ChatGPT can run commands on the computer with the person's approval,
 * so the prompt asks Codex to install the Codex CLI. Fixed here so a test can
 * pin it and so no server can alter the text.
 */
export const INSTALL_VIA_CHATGPT_PROMPT =
  "I am setting up HQ on this computer. HQ needs Codex installed here so my HQ bots can work. Please install Codex with OpenAI's official installer for this operating system, check that it runs, and help me sign in with my ChatGPT account. Ask me before you run anything you are unsure about. When it is done, tell me to go back to HQ and click Check again.";

/**
 * Build the `claude://code/new?q=…&folder=…` URL that opens Claude Code with
 * a prompt already in the composer. Uses `URLSearchParams` for encoding so
 * the byte-level validator in Rust accepts it. Kept in sync with the shape
 * used by `buildClaudeCodeUrl` (which the hq-cli auto-update banner ships).
 */
export function buildClaudeDesktopInstallUrl(input: {
  prompt: string;
  folder?: string;
}): string {
  const params = new URLSearchParams();
  if (input.prompt.trim()) params.set("q", input.prompt);
  if (input.folder && input.folder.trim()) params.set("folder", input.folder);
  const query = params.toString();
  return query ? `claude://code/new?${query}` : "claude://code/new";
}

/**
 * Build the `codex://threads/new?prompt=…` URL that opens the ChatGPT
 * desktop app's Codex area with a prompt already in the composer. Uses
 * `URLSearchParams` for encoding.
 */
export function buildChatGptCodexInstallUrl(input: {
  prompt: string;
}): string {
  const params = new URLSearchParams();
  if (input.prompt.trim()) params.set("prompt", input.prompt);
  const query = params.toString();
  return query ? `codex://threads/new?${query}` : "codex://threads/new";
}

/**
 * Which assistant desktop apps are on this computer according to
 * `detect_ai_tools`.
 */
export interface AssistantAvailability {
  claudeDesktop: boolean;
  chatgptDesktop: boolean;
}

/** Read the two flags off the shared AiTools record. */
export function assistantAvailability(
  tools: AiTools | null,
): AssistantAvailability {
  return {
    claudeDesktop: Boolean(tools?.claude_desktop),
    chatgptDesktop: Boolean(tools?.codex_desktop),
  };
}

/**
 * Resolve the ordered list of choices HQ offers when the given coding tool is
 * missing on this computer. Route rules:
 *
 * 1. If the assistant app that ships the matching coding surface is
 *    installed, offer it first ("Set up with Claude" for the Claude case;
 *    "Set up with ChatGPT" for the Codex case).
 * 2. If the OTHER assistant is installed, offer it next — Codex inside
 *    ChatGPT can install Claude Code on the person's computer, and Claude's
 *    Code area can install Codex the same way. This keeps a person from
 *    reading a dead choice list on a machine that only has one assistant.
 * 3. Always end with the direct-install fallback so the panel never dead-ends
 *    on a machine with no assistant app at all.
 *
 * `tools = null` (still probing) → single "probing" entry; the panel renders
 * a neutral checking line and no button.
 */
export function resolveInstallChoices(input: {
  tools: AiTools | null;
  tool: CodingTool;
  hqFolder?: string;
}): InstallChoice[] {
  if (input.tools === null) return [{ kind: "probing" }];

  const availability = assistantAvailability(input.tools);
  const choices: InstallChoice[] = [];

  const claudeChoice: InstallChoice = {
    kind: "assistant",
    assistant: "claude-desktop",
    tool: input.tool,
    deepLink: buildClaudeDesktopInstallUrl({
      prompt:
        input.tool === "claude"
          ? INSTALL_VIA_CLAUDE_PROMPT
          : INSTALL_VIA_CHATGPT_PROMPT,
      folder: input.hqFolder,
    }),
    buttonLabel: "Set up with Claude",
  };
  const chatgptChoice: InstallChoice = {
    kind: "assistant",
    assistant: "chatgpt-desktop",
    tool: input.tool,
    deepLink: buildChatGptCodexInstallUrl({
      prompt:
        input.tool === "codex"
          ? INSTALL_VIA_CHATGPT_PROMPT
          : INSTALL_VIA_CLAUDE_PROMPT,
    }),
    buttonLabel: "Set up with ChatGPT",
  };

  if (input.tool === "claude") {
    if (availability.claudeDesktop) choices.push(claudeChoice);
    if (availability.chatgptDesktop) choices.push(chatgptChoice);
  } else {
    if (availability.chatgptDesktop) choices.push(chatgptChoice);
    if (availability.claudeDesktop) choices.push(claudeChoice);
  }

  choices.push({
    kind: "direct-install",
    tool: input.tool,
    buttonLabel:
      input.tool === "claude" ? "Install Claude Code" : "Install Codex",
  });

  return choices;
}

/**
 * Filter a choice list to keep only the assistant options. Used when the
 * caller (SetupInstallGuide) already has its own direct-install button and
 * only wants InstallChoice to add the "Set up with Claude / ChatGPT"
 * buttons above it.
 */
export function assistantOnlyChoices(choices: InstallChoice[]): InstallChoice[] {
  return choices.filter(
    (choice) => choice.kind === "assistant" || choice.kind === "probing",
  );
}

/**
 * The lede the panel reads BEFORE it names any tool. Non-technical readers
 * should hear the purpose first ("HQ runs on your Claude or ChatGPT account")
 * and the specific tool name second. `noun` is "Mac" / "PC" / "computer" from
 * `hostComputerNoun`; a Windows person must never read "Mac".
 */
export function installPanelLede(noun: string): string {
  const host = noun.trim() || "computer";
  return `HQ runs on your Claude or ChatGPT account. Connect it on this ${host} to continue.`;
}
