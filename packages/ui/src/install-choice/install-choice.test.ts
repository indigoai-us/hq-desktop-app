/**
 * install-choice adapter — the pure route rules the operator asked for.
 *
 * The rules under test:
 *   - When Claude Desktop is here and the coding tool is Claude Code, the
 *     first choice is "Set up with Claude" with a `claude://code/new?q=…&folder=`.
 *   - When the ChatGPT desktop app is here and the coding tool is Codex, the
 *     first choice is "Set up with ChatGPT" with a
 *     `codex://threads/new?prompt=…`.
 *   - When both assistants are here, both buttons are offered, native tool
 *     first.
 *   - When neither is here, only the direct-install fallback is offered.
 *   - When detection is still probing, the panel renders a single "probing"
 *     entry so the surrounding UI can render a neutral checking line.
 *   - The prompt strings live in ONE place and pin the text (never
 *     server-supplied).
 */
import { describe, expect, it } from "vitest";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch.js";
import {
  INSTALL_VIA_CHATGPT_PROMPT,
  INSTALL_VIA_CLAUDE_PROMPT,
  assistantAvailability,
  assistantOnlyChoices,
  buildChatGptCodexInstallUrl,
  buildClaudeDesktopInstallUrl,
  installPanelLede,
  resolveInstallChoices,
} from "./install-choice.js";

const CLAUDE_ONLY: AiTools = { ...NO_AI_TOOLS, claude_desktop: true, any: true };
const CHATGPT_ONLY: AiTools = { ...NO_AI_TOOLS, codex_desktop: true, any: true };
const BOTH: AiTools = {
  ...NO_AI_TOOLS,
  claude_desktop: true,
  codex_desktop: true,
  any: true,
};

describe("assistantAvailability", () => {
  it("reads the two flags off the shared AiTools record", () => {
    expect(assistantAvailability(CLAUDE_ONLY)).toEqual({
      claudeDesktop: true,
      chatgptDesktop: false,
    });
    expect(assistantAvailability(CHATGPT_ONLY)).toEqual({
      claudeDesktop: false,
      chatgptDesktop: true,
    });
    expect(assistantAvailability(NO_AI_TOOLS)).toEqual({
      claudeDesktop: false,
      chatgptDesktop: false,
    });
    expect(assistantAvailability(null)).toEqual({
      claudeDesktop: false,
      chatgptDesktop: false,
    });
  });
});

describe("resolveInstallChoices", () => {
  it("returns a single probing entry while tools are still resolving", () => {
    expect(resolveInstallChoices({ tools: null, tool: "claude" })).toEqual([
      { kind: "probing" },
    ]);
  });

  it("offers Claude first when Claude Desktop is the assistant on this computer AND the tool needed is Claude Code", () => {
    const choices = resolveInstallChoices({
      tools: CLAUDE_ONLY,
      tool: "claude",
      hqFolder: "/Users/me/HQ",
    });
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      kind: "assistant",
      assistant: "claude-desktop",
      buttonLabel: "Set up with Claude",
    });
    expect((choices[0] as { deepLink: string }).deepLink).toBe(
      buildClaudeDesktopInstallUrl({
        prompt: INSTALL_VIA_CLAUDE_PROMPT,
        folder: "/Users/me/HQ",
      }),
    );
    expect(choices[1]).toEqual({
      kind: "direct-install",
      tool: "claude",
      buttonLabel: "Install Claude Code",
    });
  });

  it("offers ChatGPT first for the Codex case when the ChatGPT app is here", () => {
    const choices = resolveInstallChoices({
      tools: CHATGPT_ONLY,
      tool: "codex",
    });
    expect(choices[0]).toMatchObject({
      kind: "assistant",
      assistant: "chatgpt-desktop",
      buttonLabel: "Set up with ChatGPT",
    });
    expect((choices[0] as { deepLink: string }).deepLink).toBe(
      buildChatGptCodexInstallUrl({ prompt: INSTALL_VIA_CHATGPT_PROMPT }),
    );
  });

  it("offers the matching assistant first, the other assistant second, direct-install last", () => {
    const forClaude = resolveInstallChoices({
      tools: BOTH,
      tool: "claude",
    });
    expect(forClaude.map((c) => c.kind)).toEqual([
      "assistant",
      "assistant",
      "direct-install",
    ]);
    expect((forClaude[0] as { assistant: string }).assistant).toBe("claude-desktop");
    expect((forClaude[1] as { assistant: string }).assistant).toBe("chatgpt-desktop");

    const forCodex = resolveInstallChoices({
      tools: BOTH,
      tool: "codex",
    });
    expect((forCodex[0] as { assistant: string }).assistant).toBe("chatgpt-desktop");
    expect((forCodex[1] as { assistant: string }).assistant).toBe("claude-desktop");
  });

  it("falls back to only the direct-install button when neither assistant app is here", () => {
    const choices = resolveInstallChoices({
      tools: NO_AI_TOOLS,
      tool: "claude",
    });
    expect(choices).toEqual([
      {
        kind: "direct-install",
        tool: "claude",
        buttonLabel: "Install Claude Code",
      },
    ]);
  });

  it("assistantOnlyChoices filters the direct-install fallback for callers that render their own", () => {
    const filtered = assistantOnlyChoices(
      resolveInstallChoices({ tools: BOTH, tool: "codex" }),
    );
    expect(filtered.every((c) => c.kind === "assistant" || c.kind === "probing")).toBe(
      true,
    );
    expect(filtered).toHaveLength(2);
  });
});

describe("URL builders", () => {
  it("builds the claude://code/new URL with q=<prompt>&folder=<path> using URLSearchParams encoding", () => {
    const url = buildClaudeDesktopInstallUrl({
      prompt: "install claude code",
      folder: "/Users/me/HQ",
    });
    expect(url.startsWith("claude://code/new?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("install claude code");
    expect(parsed.searchParams.get("folder")).toBe("/Users/me/HQ");
  });

  it("omits `folder` and `q` when empty", () => {
    expect(buildClaudeDesktopInstallUrl({ prompt: "" })).toBe(
      "claude://code/new",
    );
  });

  it("builds the codex://threads/new URL with prompt=<text>", () => {
    const url = buildChatGptCodexInstallUrl({ prompt: "install codex" });
    expect(url.startsWith("codex://threads/new?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("prompt")).toBe("install codex");
  });

  it("emits schemes the Rust validator accepts (byte allow-list = ASCII printable, no shell metachars)", () => {
    // The validator in `apps/sync/src-tauri/src/commands/launch.rs` rejects
    // any byte outside 0x21..0x7e and the shell-dangerous set. URLSearchParams
    // encoding stays inside that set, so the two builders below must never
    // emit anything the validator would reject.
    const dangerous = /[\s"'`<>\\|]/;
    const claude = buildClaudeDesktopInstallUrl({
      prompt: "one line\ntwo `back` <tags> \"quoted\" 'single' | pipe \\ back",
      folder: "/tmp/HQ with spaces",
    });
    const codex = buildChatGptCodexInstallUrl({
      prompt: "one line\ntwo `back` <tags> \"quoted\" 'single' | pipe \\ back",
    });
    for (const url of [claude, codex]) {
      expect(dangerous.test(url)).toBe(false);
    }
  });
});

describe("copy pinning", () => {
  it("pins the Claude install prompt so no server can change it", () => {
    // The panel embeds this string verbatim into the deep link. Any drift
    // gets flagged here — never in production.
    expect(INSTALL_VIA_CLAUDE_PROMPT).toContain("HQ");
    expect(INSTALL_VIA_CLAUDE_PROMPT).toContain("Claude Code");
    expect(INSTALL_VIA_CLAUDE_PROMPT).toContain("switch back to HQ");
  });

  it("pins the ChatGPT install prompt so no server can change it", () => {
    expect(INSTALL_VIA_CHATGPT_PROMPT).toContain("HQ");
    expect(INSTALL_VIA_CHATGPT_PROMPT).toContain("Codex");
    expect(INSTALL_VIA_CHATGPT_PROMPT).toContain("switch back to HQ");
  });

  it("names the machine 'Mac' on macOS, 'PC' on Windows, 'computer' otherwise", () => {
    expect(installPanelLede("Mac")).toContain("this Mac");
    expect(installPanelLede("PC")).toContain("this PC");
    expect(installPanelLede("computer")).toContain("this computer");
    expect(installPanelLede("")).toContain("this computer");
  });
});
