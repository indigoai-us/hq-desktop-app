import { describe, expect, it, vi } from "vitest";

import { createLaunchActions } from "./launch-actions";
import { NO_AI_TOOLS, type AiTools } from "./setup-launch";
import { BRIEF_CLAUDE_PERMISSION_MODE } from "../brief/brief-runs.js";
import { claudeLaunchArgs } from "../../../platform/src/tauri/claude-launch.js";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function shellStub(tools: Partial<AiTools>) {
  const shell = {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
  };
  return { shell, typed: shell as unknown as Parameters<typeof createLaunchActions>[0]["shell"] };
}

describe("Claude permission mode on launch", () => {
  it("the brief's preset is bypassPermissions", () => {
    expect(BRIEF_CLAUDE_PERMISSION_MODE).toBe("bypassPermissions");
  });

  it("passes the permission mode to the terminal Claude launch", async () => {
    const { shell, typed } = shellStub({ claude_cli: true, any: true });
    const err = await createLaunchActions({ shell: typed, hqFolderPath: "/hq", prompt: "Do it", permissionMode: "bypassPermissions" }).launchClaude();
    expect(err).toBeNull();
    expect(shell.launchClaudeCode).toHaveBeenCalledWith("/hq", { permissionMode: "bypassPermissions", prompt: "Do it" });
  });

  it("with no prompt, sends only the mode", async () => {
    const { shell, typed } = shellStub({ claude_cli: true, any: true });
    await createLaunchActions({ shell: typed, hqFolderPath: "/hq", permissionMode: "bypassPermissions" }).launchClaude();
    expect(shell.launchClaudeCode).toHaveBeenCalledWith("/hq", { permissionMode: "bypassPermissions" });
  });

  it("the host command gets path, mode and prompt, and a plain launch only the path", () => {
    expect(claudeLaunchArgs("/hq", { permissionMode: "bypassPermissions", prompt: "Resume it" })).toEqual({
      path: "/hq",
      permissionMode: "bypassPermissions",
      prompt: "Resume it",
    });
    expect(claudeLaunchArgs("/hq")).toEqual({ path: "/hq" });
    expect(claudeLaunchArgs("/hq", { prompt: "  " })).toEqual({ path: "/hq" });
  });

  it("callers that set no mode launch exactly as before", async () => {
    const { shell, typed } = shellStub({ claude_cli: true, any: true });
    await createLaunchActions({ shell: typed, hqFolderPath: "/hq" }).launchClaude();
    expect(shell.launchClaudeCode).toHaveBeenCalledWith("/hq");
    expect(shell.launchClaudeCode.mock.calls[0]).toHaveLength(1);
  });
});
