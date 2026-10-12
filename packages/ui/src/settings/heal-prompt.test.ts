import { afterEach, describe, expect, it, vi } from "vitest";

import { createLaunchActions } from "./launch-actions";
import { NO_AI_TOOLS, type AiTools } from "./setup-launch";
import {
  HEAL_REASON_MAX_CHARS,
  buildHealPrompt,
  healReasonText,
  quietInstallWithReason,
} from "./update-row-actions";

afterEach(() => vi.restoreAllMocks());

describe("buildHealPrompt", () => {
  it("names the HQ CLI package, both versions, the failure and the commands", () => {
    expect(
      buildHealPrompt("cli", { current: "1.2.3", latest: "v5.347.0", reason: "EACCES: permission denied" }),
    ).toBe(
      "Update the HQ CLI (@indigoai-us/hq-cli, the `hq` command) from v1.2.3 to v5.347.0. " +
        "HQ's own update failed: EACCES: permission denied. Check `which -a hq` and `npm prefix -g`, " +
        "run `npm install -g @indigoai-us/hq-cli@latest` (fix EACCES or Node version if it fails), " +
        "then confirm with `hq --version`.",
    );
  });

  it("gives HQ Core its own request through the update-hq skill", () => {
    expect(
      buildHealPrompt("core", { current: "15.0.118", latest: "15.1.0", reason: "rescue clone failed" }),
    ).toBe(
      "Update HQ Core (the HQ files in this folder, versioned by hqVersion in core/core.yaml) " +
        "from v15.0.118 to v15.1.0. HQ's own update failed: rescue clone failed. " +
        "Run the /update-hq skill to upgrade from the latest indigoai-us/hq-core release " +
        "(if it is not available, read .claude/skills/update-hq/SKILL.md and follow it), " +
        "keep everything in personal/ and companies/, then confirm hqVersion in core/core.yaml reads v15.1.0.",
    );
  });

  it("gives the desktop app its own request through the GitHub release", () => {
    expect(
      buildHealPrompt("app", { current: "0.11.5", latest: "0.11.6", reason: "Download failed. Try again." }),
    ).toBe(
      "Update the HQ desktop app from v0.11.5 to v0.11.6. Its built-in updater failed: " +
        "Download failed. Try again. Download the newest release for this computer from " +
        "https://github.com/indigoai-us/hq-desktop-app/releases/latest (the .dmg on macOS, " +
        "the installer on Windows), quit HQ, install it over the existing app, then reopen HQ " +
        "and confirm Settings › Updates shows v0.11.6.",
    );
  });

  it("reads well with unknown versions, a staging SHA and no failure text", () => {
    expect(buildHealPrompt("cli", {})).toMatch(
      /^Update the HQ CLI \(@indigoai-us\/hq-cli, the `hq` command\) from the installed version to the latest version\. HQ's own update failed\. Check /,
    );
    expect(buildHealPrompt("core", { current: "15.0.118", latest: "1af82d0" })).toContain(
      "from v15.0.118 to 1af82d0.",
    );
  });

  it("keeps the failure reason to one bounded line", () => {
    expect(healReasonText("npm ERR! code EACCES\nnpm ERR! path /usr/local/lib\t\u001b[0m.")).toBe(
      "npm ERR! code EACCES npm ERR! path /usr/local/lib",
    );
    expect(healReasonText("   ")).toBeNull();
    const long = healReasonText("x".repeat(HEAL_REASON_MAX_CHARS * 3))!;
    expect(long.length).toBe(HEAL_REASON_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(buildHealPrompt("cli", { reason: "line one\nline two" })).not.toContain("\n");
  });
});

describe("quietInstallWithReason", () => {
  it("keeps the last attempt's failure text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "first" })
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce({ ok: false, reason: "timeout" });
    await expect(quietInstallWithReason(run)).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("reports success without a reason", async () => {
    await expect(quietInstallWithReason(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });
});

describe("createLaunchActions terminalPrompt", () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value });

  function shellStub(tools: Partial<AiTools>) {
    return {
      detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
      openClaudeCodeLink: vi.fn(async () => ok(undefined)),
      launchClaudeCode: vi.fn(async () => ok(undefined)),
      launchCodexWorkspace: vi.fn(async () => ok(undefined)),
      launchCliInTerminal: vi.fn(async () => ok(undefined)),
    };
  }

  const PROMPT = "--help me update the HQ CLI";

  it.each([
    ["grok", { grok_cli: true }, "launchGrok"],
    ["codex", { codex_cli: true }, "launchCodex"],
    ["claude", { claude_cli: true }, "launchClaude"],
  ] as const)("passes the prompt to the %s terminal CLI", async (tool, tools, fn) => {
    const shell = shellStub(tools);
    const actions = createLaunchActions({
      shell: shell as unknown as Parameters<typeof createLaunchActions>[0]["shell"],
      hqFolderPath: "/hq",
      prompt: PROMPT,
      terminalPrompt: PROMPT,
    });
    expect(await actions[fn]()).toBeNull();
    expect(shell.launchCliInTerminal).toHaveBeenCalledWith({ path: "/hq", tool, prompt: PROMPT });
    expect(shell.launchClaudeCode).not.toHaveBeenCalled();
  });

  it.each([
    ["grok", { grok_cli: true }, "launchGrok"],
    ["codex", { codex_cli: true }, "launchCodex"],
  ] as const)("keeps the bare %s terminal launch without terminalPrompt", async (tool, tools, fn) => {
    const shell = shellStub(tools);
    const actions = createLaunchActions({
      shell: shell as unknown as Parameters<typeof createLaunchActions>[0]["shell"],
      hqFolderPath: "/hq",
      prompt: "/setup",
    });
    expect(await actions[fn]()).toBeNull();
    expect(shell.launchCliInTerminal).toHaveBeenCalledWith({ path: "/hq", tool });
  });
});
