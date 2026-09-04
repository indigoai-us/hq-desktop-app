import { describe, expect, it, vi } from "vitest";

import { buildClaudeCodeUrl } from "./claude-code-link";
import { createLaunchActions } from "./launch-actions";
import {
  NO_AI_TOOLS,
  SETUP_BOOTSTRAP_COMMAND,
  SETUP_CORE_MARKER,
  SETUP_DEEP_LINK_PROMPT,
  SETUP_PROMPT,
  SETUP_REPAIR_COMMAND,
  SETUP_SKILL_PATH,
  type AiTools,
} from "./setup-launch";

// Regression: the "Finish setting up HQ" deep link used to carry the bare
// `/setup` slash command. Claude Desktop treats a folder handed to it by a
// `claude://` link as untrusted and scans skills BEFORE the trust dialog is
// accepted, so HQ's project skill under `.claude/skills/` is suppressed
// ("skipped because this workspace was not trusted when plugins were
// scanned"). The pre-typed `/setup` then landed in the composer as an
// unknown command and the one-click setup CTA did nothing.
//
// The deep link now carries a plain-language prompt that names the skill
// file, so the session can run the wizard without the skill being
// registered. Terminal launches settle trust before the scan, so they keep
// the slash command.

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function shellStub(tools: Partial<AiTools>) {
  return {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
  } as unknown as Parameters<typeof createLaunchActions>[0]["shell"] & {
    openClaudeCodeLink: ReturnType<typeof vi.fn>;
    launchClaudeCode: ReturnType<typeof vi.fn>;
  };
}

describe("SETUP_DEEP_LINK_PROMPT", () => {
  it("never starts with a slash, so Claude cannot parse it as a command", () => {
    expect(SETUP_DEEP_LINK_PROMPT.startsWith("/")).toBe(false);
    expect(SETUP_DEEP_LINK_PROMPT.trimStart().startsWith("/")).toBe(false);
  });

  it("names the setup skill file so the session can read it directly", () => {
    expect(SETUP_SKILL_PATH).toBe(".claude/skills/setup/SKILL.md");
    expect(SETUP_DEEP_LINK_PROMPT).toContain(SETUP_SKILL_PATH);
  });

  // This CTA is the installer's REPAIR path: `runSetup` reaches the ready
  // screen even when `fetch_and_extract_template` failed, and the Rust
  // preflight (`bind_hq_root_for_setup_repair`) deliberately accepts any
  // existing directory for exactly that case. So the folder the link opens
  // may have no HQ tree at all — including no setup skill to read. A prompt
  // that only knows how to read the skill file dead-ends on the machines
  // that need this button most.
  it("recovers a partially installed HQ folder, not just a complete one", () => {
    expect(SETUP_DEEP_LINK_PROMPT).toContain(SETUP_CORE_MARKER);
    expect(SETUP_DEEP_LINK_PROMPT).toContain(SETUP_REPAIR_COMMAND);
  });

  it("bootstraps a folder where the template never downloaded", () => {
    // `hq rescue` cannot serve this case — it resolves the HQ root and reads
    // core/core.yaml for its version floor, neither of which exists yet.
    expect(SETUP_BOOTSTRAP_COMMAND).toContain("create-hq");
    expect(SETUP_DEEP_LINK_PROMPT).toContain(SETUP_BOOTSTRAP_COMMAND);
    expect(SETUP_REPAIR_COMMAND).not.toContain("create-hq");
  });

  it("covers all three folder states in order, most-complete first", () => {
    const skill = SETUP_DEEP_LINK_PROMPT.indexOf(SETUP_SKILL_PATH);
    const repair = SETUP_DEEP_LINK_PROMPT.indexOf(SETUP_REPAIR_COMMAND);
    const bootstrap = SETUP_DEEP_LINK_PROMPT.indexOf(SETUP_BOOTSTRAP_COMMAND);
    expect(skill).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(skill);
    expect(bootstrap).toBeGreaterThan(repair);
  });

  it("survives URL encoding into the deep link's q parameter", () => {
    const parsed = new URL(
      buildClaudeCodeUrl({ folder: "/p", prompt: SETUP_DEEP_LINK_PROMPT }),
    );
    expect(parsed.searchParams.get("q")).toBe(SETUP_DEEP_LINK_PROMPT);
  });

  it("stays inside the deep link's documented prompt budget", () => {
    expect(SETUP_DEEP_LINK_PROMPT.length).toBeLessThan(5_000);
  });
});

describe("createLaunchActions deep-link vs terminal prompt", () => {
  it("sends deepLinkPrompt (not the slash command) on the desktop deep link", async () => {
    const shell = shellStub({ claude_desktop: true });
    const actions = createLaunchActions({
      shell,
      hqFolderPath: "/Users/me/HQ",
      prompt: SETUP_PROMPT,
      deepLinkPrompt: SETUP_DEEP_LINK_PROMPT,
    });

    expect(await actions.launchClaude()).toBeNull();

    const url = new URL(shell.openClaudeCodeLink.mock.calls[0][0] as string);
    expect(url.searchParams.get("q")).toBe(SETUP_DEEP_LINK_PROMPT);
    expect(url.searchParams.get("q")).not.toBe(SETUP_PROMPT);
    expect(url.searchParams.get("folder")).toBe("/Users/me/HQ");
  });

  it("falls back to prompt when no deepLinkPrompt is given", async () => {
    const shell = shellStub({ claude_desktop: true });
    const actions = createLaunchActions({
      shell,
      hqFolderPath: "/Users/me/HQ",
      prompt: "do a thing",
    });

    await actions.launchClaude();

    const url = new URL(shell.openClaudeCodeLink.mock.calls[0][0] as string);
    expect(url.searchParams.get("q")).toBe("do a thing");
  });

  it("leaves the terminal-CLI launch untouched by the deep-link prompt", async () => {
    const shell = shellStub({ claude_cli: true });
    const actions = createLaunchActions({
      shell,
      hqFolderPath: "/Users/me/HQ",
      prompt: SETUP_PROMPT,
      deepLinkPrompt: SETUP_DEEP_LINK_PROMPT,
    });

    expect(await actions.launchClaude()).toBeNull();

    expect(shell.openClaudeCodeLink).not.toHaveBeenCalled();
    expect(shell.launchClaudeCode).toHaveBeenCalledWith("/Users/me/HQ");
  });

  it("still tells an undetected user to run /setup, not the long prompt", async () => {
    const shell = shellStub({});
    const actions = createLaunchActions({
      shell,
      hqFolderPath: "/Users/me/HQ",
      prompt: SETUP_PROMPT,
      deepLinkPrompt: SETUP_DEEP_LINK_PROMPT,
    });

    expect(await actions.launchClaude()).toContain("/setup");
  });
});
