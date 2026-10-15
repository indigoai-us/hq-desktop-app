import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHqAnywhereGlobalRuntime, HQ_ANYWHERE_RUNTIME_FLAG } from "@hq/platform";
import { continueInTool, FIRST_RUN_INSTALL_WAIT_MS, type ContinueInToolInput } from "./continue-in-tool";

const ok = <T>(value: T) => ({ ok: true as const, value });
const failure = (reason: string, message: string) => ({ ok: false as const, reason, message });
const noPause = async () => undefined;

const CLAUDE_CLI = { claude_cli: true, claude_desktop: false, codex_cli: false, codex_desktop: false, grok_cli: false, any: true };

function setup(overrides: {
  folder?: string;
  setupStatus?: () => Promise<unknown>;
  putSetting?: (value: boolean) => Promise<unknown>;
  install?: (runtime: string) => Promise<unknown>;
  launchClaudeCode?: (folder: string) => Promise<unknown>;
  tools?: Record<string, boolean> | null;
} = {}) {
  const order: string[] = [];
  let personSetting = false;
  const putHqAnywherePersonSetting = vi.fn(
    overrides.putSetting ??
      (async (value: boolean) => {
        order.push(`opt-in:${value}`);
        personSetting = value;
        return ok(undefined);
      }),
  );
  const installRuntimeForTool = vi.fn(
    overrides.install ??
      (async (runtime: string) => {
        order.push(`install:${runtime}`);
        return ok(undefined);
      }),
  );
  const launchClaudeCode = vi.fn(
    overrides.launchClaudeCode ??
      (async (folder: string) => {
        order.push(`open:${folder}`);
        return ok(undefined);
      }),
  );
  const launchCliInTerminal = vi.fn(async (args: { path: string; tool: string }) => {
    order.push(`terminal:${args.tool}:${args.path}`);
    return ok(undefined);
  });
  const getSetupStatus = vi.fn(
    overrides.setupStatus ?? (async () => ok({ hqFolderPath: overrides.folder ?? "/tmp/HQ" })),
  );
  const tools = overrides.tools === undefined ? CLAUDE_CLI : overrides.tools;
  const settings = {
    getSetupStatus,
    installRuntimeForTool,
    putHqAnywherePersonSetting,
    getHqAnywherePersonSetting: vi.fn(async () => ok(personSetting)),
    syncHqAnywhereGlobal: vi.fn(async (enabled: boolean) => {
      order.push(`reconcile:${enabled}`);
      return ok(undefined);
    }),
  };
  const shell = {
    detectAiTools: vi.fn(async () => (tools ? ok({ ...CLAUDE_CLI, ...tools, grok_cli: true }) : failure("unavailable", "x"))),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode,
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal,
  };
  const input = (runtime: ContinueInToolInput["runtime"], extra: Partial<ContinueInToolInput> = {}): ContinueInToolInput => ({
    runtime,
    settings: settings as unknown as ContinueInToolInput["settings"],
    shell: shell as unknown as ContinueInToolInput["shell"],
    pause: noPause,
    ...extra,
  });
  return { order, settings, shell, input, putHqAnywherePersonSetting, installRuntimeForTool, launchClaudeCode, getSetupStatus };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("continueInTool", () => {
  it("records the HQ Anywhere opt-in before the install, then opens the tool in the HQ folder", async () => {
    const { order, input, putHqAnywherePersonSetting } = setup();
    await expect(continueInTool(input("claude"))).resolves.toEqual({ kind: "opened" });
    expect(putHqAnywherePersonSetting).toHaveBeenCalledWith(true);
    expect(order).toEqual(["opt-in:true", "install:claude", "open:/tmp/HQ"]);
  });

  it("a launch after Continue keeps the install: the reconcile reads the saved opt-in and never uninstalls", async () => {
    const { order, input, settings } = setup();
    await continueInTool(input("claude"));
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async (flag: string) =>
        ok({ configured: true, enabled: flag === HQ_ANYWHERE_RUNTIME_FLAG }),
      ),
    };
    // The next launch's startup reconcile, as App.svelte runs it.
    await ensureHqAnywhereGlobalRuntime(identity as never, settings as never, { pause: noPause });
    expect(settings.syncHqAnywhereGlobal).toHaveBeenCalledTimes(1);
    expect(settings.syncHqAnywhereGlobal).toHaveBeenCalledWith(true);
    expect(order).not.toContain("reconcile:false");
  });

  it("skips the install when the opt-in is not saved, so the next launch has nothing to uninstall, and still opens", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { order, input, installRuntimeForTool } = setup({
      putSetting: async () => failure("network", "offline"),
    });
    await expect(continueInTool(input("claude"))).resolves.toEqual({ kind: "opened" });
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(order).toEqual(["open:/tmp/HQ"]);
  });

  it("a failed install still opens the tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { input, launchClaudeCode } = setup({ install: async () => failure("hq-install", "exit 1") });
    await expect(continueInTool(input("claude"))).resolves.toEqual({ kind: "opened" });
    expect(launchClaudeCode).toHaveBeenCalledWith("/tmp/HQ");
  });

  it("a hung install opens the tool once the bounded wait runs out", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.fn();
    const { input, launchClaudeCode } = setup({ install: () => new Promise(() => undefined) });
    const pending = continueInTool(input("claude", { log }));
    await vi.advanceTimersByTimeAsync(FIRST_RUN_INSTALL_WAIT_MS - 1);
    expect(launchClaudeCode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ kind: "opened" });
    expect(launchClaudeCode).toHaveBeenCalledWith("/tmp/HQ");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("installed runtime=claude ok=timeout"));
    expect(FIRST_RUN_INSTALL_WAIT_MS).toBe(20_000);
  });

  it("Grok Build only opens: no opt-in, no install", async () => {
    const { order, input, putHqAnywherePersonSetting, installRuntimeForTool } = setup();
    await expect(continueInTool(input("grok"))).resolves.toEqual({ kind: "opened" });
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(order).toEqual(["terminal:grok:/tmp/HQ"]);
  });

  it("returns no-folder, touching nothing, when the HQ folder is empty or the status read fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const overrides of [
      { folder: "  " },
      { setupStatus: async () => failure("io", "boom") },
      { setupStatus: async () => Promise.reject(new Error("boom")) },
    ]) {
      const { order, input } = setup(overrides);
      await expect(continueInTool(input("claude"))).resolves.toEqual({ kind: "no-folder" });
      expect(order).toEqual([]);
    }
  });

  it("returns the launcher's plain sentence when the tool does not open", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notDetected = setup({ tools: { claude_cli: false } });
    await expect(continueInTool(notDetected.input("claude"))).resolves.toEqual({
      kind: "open-failed",
      message: "Claude Code was not detected. Open your HQ folder in Claude Code.",
    });
    const failed = setup({ launchClaudeCode: async () => failure("spawn", "ENOENT /bin/zsh") });
    await expect(continueInTool(failed.input("claude"))).resolves.toEqual({
      kind: "open-failed",
      message: "Could not open Claude Code. Try again.",
    });
  });
});
