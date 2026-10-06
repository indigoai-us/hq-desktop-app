import { afterEach, describe, expect, it, vi } from "vitest";

import { createLaunchActions } from "./launch-actions";
import { NO_AI_TOOLS, type AiTools } from "./setup-launch";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = () => ({ ok: false as const, reason: "error", message: RAW });

function shellStub(tools: Partial<AiTools>) {
  return {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async () => fail()),
    launchClaudeCode: vi.fn(async () => fail()),
    launchCodexWorkspace: vi.fn(async () => fail()),
    launchCliInTerminal: vi.fn(async () => fail()),
    writeClipboard: vi.fn(async () => ok(undefined)),
  } as unknown as Parameters<typeof createLaunchActions>[0]["shell"];
}

afterEach(() => vi.restoreAllMocks());

describe("launch actions raw errors (AUDIT-3c)", () => {
  it.each([
    ["claude desktop", { claude_desktop: true, any: true }, "launchClaude"],
    ["claude cli", { claude_cli: true, any: true }, "launchClaude"],
    ["codex", { codex_cli: true, any: true }, "launchCodex"],
    ["grok", { grok_cli: true, any: true }, "launchGrok"],
  ] as const)("%s failure returns plain copy and logs the raw text", async (_n, tools, fn) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions = createLaunchActions({
      shell: shellStub(tools as Partial<AiTools>),
      hqFolderPath: "/hq",
    });
    const msg = await actions[fn]();
    expect(msg).not.toBeNull();
    expect(msg).not.toContain("boom");
    expect(msg).not.toContain("HTTP 500");
    expect(msg).toMatch(/^Could not open .+\. Try again\.$/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[launch\] open .* failed$/), RAW);
  });
});

describe("launch actions prompt recovery", () => {
  it("copies the prefilled prompt when Claude falls back to a terminal", async () => {
    const shell = shellStub({ claude_cli: true, any: true });
    (shell.launchClaudeCode as ReturnType<typeof vi.fn>).mockResolvedValue(ok(undefined));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const message = await createLaunchActions({ shell, hqFolderPath: "/hq", prompt: "meeting prompt", copyPromptOnTerminalLaunch: true }).launchClaude();
    expect(writeText).toHaveBeenCalledWith("meeting prompt");
    expect(message).toContain("prompt was copied");
  });
});
