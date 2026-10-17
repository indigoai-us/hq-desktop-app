import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHqAnywhereGlobalRuntime, HQ_ANYWHERE_RUNTIME_FLAG } from "@hq/platform";
import { type LaunchShell } from "../../settings/launch-actions";
import { continueInTool, continueWillInstallHq, openPreparedCodingTool, FIRST_RUN_INSTALL_WAIT_MS, type ContinueInToolInput } from "./continue-in-tool";

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
  runtimeFlag?: boolean;
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
  const identity = {
    resolveFeatureFlagStatus: vi.fn(async (flag: string) =>
      ok({ configured: true, enabled: flag === HQ_ANYWHERE_RUNTIME_FLAG && (overrides.runtimeFlag ?? true) }),
    ),
  };
  const input = (runtime: ContinueInToolInput["runtime"], extra: Partial<ContinueInToolInput> = {}): ContinueInToolInput => ({
    runtime,
    identity: identity as unknown as ContinueInToolInput["identity"],
    settings: settings as unknown as ContinueInToolInput["settings"],
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
  it("does not opt in or install unless Enable was pressed", async () => {
    const { order, input, putHqAnywherePersonSetting, installRuntimeForTool, launchClaudeCode } = setup();
    await expect(continueInTool(input("claude"))).resolves.toEqual({ kind: "prepared", install: "skipped" });
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(launchClaudeCode).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("records the HQ Anywhere opt-in before the install and does not open the tool", async () => {
    const { order, input, putHqAnywherePersonSetting, launchClaudeCode } = setup();
    await expect(continueInTool(input("claude", { enableHqAnywhere: true }))).resolves.toEqual({ kind: "prepared", install: "installed" });
    expect(putHqAnywherePersonSetting).toHaveBeenCalledWith(true);
    expect(order).toEqual(["opt-in:true", "install:claude"]);
    expect(launchClaudeCode).not.toHaveBeenCalled();
  });

  it("a launch after Continue keeps the install: the reconcile reads the saved opt-in and never uninstalls", async () => {
    const { order, input, settings } = setup();
    await continueInTool(input("claude", { enableHqAnywhere: true }));
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

  it("skips the install when the opt-in is not saved, does not open, and returns a sentence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { order, input, installRuntimeForTool, launchClaudeCode } = setup({
      putSetting: async () => failure("network", "offline"),
    });
    await expect(continueInTool(input("claude", { enableHqAnywhere: true }))).resolves.toEqual({
      kind: "prepared-without-opt-in",
      message: "Couldn't save your HQ Anywhere choice. HQ was not installed in Claude Code. Try again from Settings.",
    });
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(launchClaudeCode).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("with the hq-anywhere-runtime kill switch off, prepares nothing: no opt-in write, no install, no open", async () => {
    const { order, input, putHqAnywherePersonSetting, installRuntimeForTool, launchClaudeCode } = setup({ runtimeFlag: false });
    await expect(continueInTool(input("claude", { enableHqAnywhere: true }))).resolves.toEqual({ kind: "prepared", install: "skipped" });
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(launchClaudeCode).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("with no identity to read the kill switch, fails closed and does not install or open", async () => {
    const { order, input, installRuntimeForTool, launchClaudeCode } = setup();
    await expect(continueInTool(input("claude", { identity: undefined, enableHqAnywhere: true }))).resolves.toEqual({ kind: "prepared", install: "skipped" });
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(launchClaudeCode).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("a failed install still prepares the Open action and does not open the tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { input, launchClaudeCode } = setup({ install: async () => failure("hq-install", "exit 1") });
    await expect(continueInTool(input("claude", { enableHqAnywhere: true }))).resolves.toEqual({ kind: "prepared", install: "failed" });
    expect(launchClaudeCode).not.toHaveBeenCalled();
  });

  it("a hung install is pending, then reports the real result without opening the tool", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.fn();
    const onInstallSettled = vi.fn();
    let finish: (value: { ok: true; value: undefined }) => void = () => undefined;
    const { input, launchClaudeCode } = setup({
      install: () => new Promise((resolve) => {
        finish = resolve;
      }),
    });
    const pending = continueInTool(input("claude", { log, enableHqAnywhere: true, onInstallSettled }));
    await vi.advanceTimersByTimeAsync(FIRST_RUN_INSTALL_WAIT_MS - 1);
    expect(launchClaudeCode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ kind: "prepared", install: "pending" });
    expect(launchClaudeCode).not.toHaveBeenCalled();
    expect(onInstallSettled).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("installed runtime=claude ok=timeout"));
    expect(FIRST_RUN_INSTALL_WAIT_MS).toBe(20_000);
    finish(ok(undefined));
    await vi.waitFor(() => expect(onInstallSettled).toHaveBeenCalledWith(ok(undefined)));
  });

  it("Grok Build prepares without an opt-in, an install, or an open", async () => {
    const { order, input, putHqAnywherePersonSetting, installRuntimeForTool } = setup();
    await expect(continueInTool(input("grok", { enableHqAnywhere: true }))).resolves.toEqual({ kind: "prepared", install: "skipped" });
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(installRuntimeForTool).not.toHaveBeenCalled();
    expect(order).toEqual([]);
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

  it("returns the launcher's plain sentence when Open cannot start the tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notDetected = setup({ tools: { claude_cli: false } });
    await expect(openPreparedCodingTool({ ...notDetected.input("claude"), shell: notDetected.shell as LaunchShell })).resolves.toEqual({
      kind: "open-failed",
      message: "Claude Code was not detected. Open your HQ folder in Claude Code.",
    });
    const failed = setup({ launchClaudeCode: async () => failure("spawn", "ENOENT /bin/zsh") });
    await expect(openPreparedCodingTool({ ...failed.input("claude"), shell: failed.shell as LaunchShell })).resolves.toEqual({
      kind: "open-failed",
      message: "Could not open Claude Code. Try again.",
    });
  });
});

describe("continueWillInstallHq", () => {
  it("is true only when Continue will install, and false when HQ Anywhere is off", () => {
    expect(continueWillInstallHq({ runtime: "claude", runtimeEnabled: true, canInstall: true })).toBe(true);
    expect(continueWillInstallHq({ runtime: "codex", runtimeEnabled: true, canInstall: true })).toBe(true);
    expect(continueWillInstallHq({ runtime: "claude", runtimeEnabled: false, canInstall: true })).toBe(false);
    expect(continueWillInstallHq({ runtime: "codex", runtimeEnabled: false, canInstall: true })).toBe(false);
    expect(continueWillInstallHq({ runtime: "grok", runtimeEnabled: true, canInstall: true })).toBe(false);
    expect(continueWillInstallHq({ runtime: "claude", runtimeEnabled: true, canInstall: false })).toBe(false);
  });
});

describe("openPreparedCodingTool", () => {
  it("opens Claude Code in the HQ folder and leaves Codex closed", async () => {
    const { shell, input, launchClaudeCode } = setup();
    await expect(openPreparedCodingTool({ ...input("claude"), shell: shell as LaunchShell })).resolves.toEqual({ kind: "opened" });
    expect(launchClaudeCode).toHaveBeenCalledWith("/tmp/HQ");
    expect(shell.launchCodexWorkspace).not.toHaveBeenCalled();
  });

  it("opens Codex in the HQ folder and leaves Claude Code closed", async () => {
    const { shell, input, launchClaudeCode } = setup({
      tools: { claude_cli: false, codex_cli: false, codex_desktop: true },
    });
    await expect(openPreparedCodingTool({ ...input("codex"), shell: shell as LaunchShell })).resolves.toEqual({ kind: "opened" });
    expect(shell.launchCodexWorkspace).toHaveBeenCalledWith("/tmp/HQ");
    expect(launchClaudeCode).not.toHaveBeenCalled();
  });
});
