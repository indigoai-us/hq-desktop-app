/**
 * Adapter wiring for the SetupInstallGuide callbacks (US-005). These tests
 * verify that each callback:
 *
 *  - invokes the right Tauri command with the right args (macOS + Windows are
 *    both covered by the same command names; the Rust side branches on cfg)
 *  - maps success into `{ ok: true }` and failure into `{ ok: false, reason }`
 *    with a plain-language reason
 *  - keeps HQ out of the password path (sign-in returns `ok:true` only when
 *    the tool's own window reports `connected`)
 *  - falls back safely when a probe throws (detect_ai_tools does not block
 *    the guided flow)
 */

import { describe, expect, it, vi } from "vitest";
import {
  createSetupInstallGuideCallbacks,
  type InstallGuideDeps,
} from "./install-guide-adapter";

function fakeDeps(overrides: Partial<InstallGuideDeps> = {}): {
  deps: InstallGuideDeps;
  invoke: ReturnType<typeof vi.fn>;
  openUrl: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async (): Promise<unknown> => undefined);
  const openUrl = vi.fn(async (): Promise<unknown> => undefined);
  const deps: InstallGuideDeps = {
    invoke: overrides.invoke ?? (invoke as unknown as InstallGuideDeps["invoke"]),
    openUrl: overrides.openUrl ?? (openUrl as unknown as InstallGuideDeps["openUrl"]),
  };
  return { deps, invoke, openUrl };
}

describe("createSetupInstallGuideCallbacks - oninstall", () => {
  it("routes Claude Code through install_claude_code and returns ok on success", async () => {
    const invoke = vi.fn(async () => "ok");
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.oninstall("claude");
    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("install_claude_code");
  });

  it("routes Codex through install_codex", async () => {
    const invoke = vi.fn(async () => "ok");
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    await cb.oninstall("codex");
    expect(invoke).toHaveBeenCalledWith("install_codex");
  });

  it("surfaces the Rust command's error string as a plain reason", async () => {
    const invoke = vi.fn(async () => {
      throw "npm install failed: EACCES on /usr/local/lib";
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.oninstall("claude");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("EACCES");
  });

  it("falls back to a generic reason when the error is empty", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("");
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.oninstall("claude");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Claude Code");
  });
});

describe("createSetupInstallGuideCallbacks - onsignin", () => {
  it("resolves ok when the tool's window reports connected", async () => {
    const invoke = vi.fn(async () => ({ state: "connected" as const }));
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.onsignin("claude");
    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("agent_provider_login_start", {
      tool: "claude",
      force: false,
    });
  });

  it("surfaces the LoginState message on non-connected states", async () => {
    const invoke = vi.fn(async () => ({
      state: "error",
      message: "The sign-in window was closed before finishing.",
    }));
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.onsignin("claude");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("sign-in window was closed");
  });

  it("gives a plain reason when a pending state times out without a message", async () => {
    const invoke = vi.fn(async () => ({ state: "pending" }));
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.onsignin("codex");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Codex");
  });

  it("never asks HQ for the password: only 'connected' counts as ok", async () => {
    const invoke = vi.fn(async () => ({ state: "disconnected" }));
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.onsignin("claude");
    expect(result.ok).toBe(false);
  });
});

describe("createSetupInstallGuideCallbacks - onrefresh", () => {
  it("calls detect_ai_tools", async () => {
    const invoke = vi.fn(async () => ({ any: true, claude_cli: true }));
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    await cb.onrefresh();
    expect(invoke).toHaveBeenCalledWith("detect_ai_tools");
  });

  it("swallows a probe failure so the guided flow does not break", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("probe timeout");
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    await expect(cb.onrefresh()).resolves.toBeUndefined();
  });
});

describe("createSetupInstallGuideCallbacks - downloadUrlFor + onopen", () => {
  it("returns the official install page for each tool", () => {
    const { deps } = fakeDeps();
    const cb = createSetupInstallGuideCallbacks(deps);
    expect(cb.downloadUrlFor("claude")).toMatch(/^https:\/\/claude\.com\//);
    expect(cb.downloadUrlFor("codex")).toMatch(/^https:\/\/developers\.openai\.com\//);
  });

  it("opens the URL via the injected shell.open primitive", async () => {
    const { deps, openUrl } = fakeDeps();
    const cb = createSetupInstallGuideCallbacks(deps);
    const result = await cb.onopen("https://claude.com/download");
    expect(result).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith("https://claude.com/download");
  });

  it("surfaces a plain reason when the shell.open call fails", async () => {
    const openUrl = vi.fn(async () => {
      throw new Error("shell open denied by capability");
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: (async () => undefined) as unknown as InstallGuideDeps["invoke"],
      openUrl: openUrl as unknown as InstallGuideDeps["openUrl"],
    });
    const result = await cb.onopen("https://claude.com/download");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shell open denied");
  });
});
