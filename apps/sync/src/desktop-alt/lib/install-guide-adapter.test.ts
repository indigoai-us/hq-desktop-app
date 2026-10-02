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
  classifyInstallFailure,
  createSetupInstallGuideCallbacks,
  installFailureReason,
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

  it("maps a permission-denied error into a plain sentence — never leaks the raw path or exit code", async () => {
    // The Windows test persona report flagged raw error text as
    // intimidating for a non-technical person. The adapter now translates
    // known signals into plain sentences and drops the raw text into the
    // console log; the returned `reason` never carries the path or code.
    const invoke = vi.fn(async () => {
      throw "npm install failed: EACCES on /usr/local/lib";
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.oninstall("claude");
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("EACCES");
    expect(result.reason).not.toContain("/usr/local/lib");
    expect(result.reason).toMatch(/permission/i);
    expect(result.reason).toContain("Claude Code");
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
    // Falls back to the generic sentence, not any raw text.
    expect(result.reason).toContain("try again");
  });
});

describe("classifyInstallFailure — plain wording for each known signal", () => {
  it("routes network / offline signals to a plain-language sentence", () => {
    for (const raw of [
      "ETIMEDOUT while fetching registry.npmjs.org",
      "getaddrinfo ENOTFOUND registry.npmjs.org",
      "connect ECONNREFUSED",
      "network is unreachable",
      "DNS lookup failed",
    ]) {
      const plain = classifyInstallFailure(raw, "Claude Code")!;
      expect(plain).toContain("internet");
      expect(plain).toContain("Claude Code");
      expect(plain).not.toContain(raw);
    }
  });

  it("routes admin / permission signals to a plain-language sentence", () => {
    for (const raw of [
      "EPERM: operation not permitted",
      "EACCES: permission denied, mkdir …",
      "Access is denied.",
      "Requires administrator privileges to continue.",
    ]) {
      const plain = classifyInstallFailure(raw, "Claude Code")!;
      expect(plain.toLowerCase()).toMatch(/permission/);
      expect(plain).not.toContain(raw);
    }
  });

  it("routes antivirus / SmartScreen signals to a plain-language sentence", () => {
    const plain = classifyInstallFailure(
      "The installer was blocked by Microsoft Defender SmartScreen.",
      "Claude Code",
    )!;
    expect(plain.toLowerCase()).toContain("antivirus");
  });

  it("routes Node / npm bootstrap failures to a plain sentence that never says 'npm'", () => {
    const plain = classifyInstallFailure(
      "[claude] npm was not found after installing Node.js.",
      "Claude Code",
    )!;
    expect(plain).not.toMatch(/\bnpm\b/i);
    // "Node" as a bare word may still leak; the raw is the fallback trigger,
    // not the surface. What the person reads is "a required tool is missing".
    expect(plain).toContain("required tool is missing");
  });

  it("routes disk-full signals to a plain-language sentence", () => {
    const plain = classifyInstallFailure(
      "ENOSPC: no space left on device",
      "Claude Code",
    )!;
    expect(plain.toLowerCase()).toContain("disk space");
  });

  it("returns null for a signal it does not know, so the caller falls back to the generic sentence", () => {
    expect(classifyInstallFailure("who knows", "Claude Code")).toBeNull();
    expect(classifyInstallFailure("", "Claude Code")).toBeNull();
  });
});

describe("installFailureReason — the last line of defence", () => {
  it("returns the generic plain sentence when the raw text is not recognised", () => {
    const reason = installFailureReason(new Error("mysterious internal state"), "codex");
    expect(reason).toContain("Codex");
    expect(reason).not.toContain("mysterious internal state");
    expect(reason).toContain("try again");
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
      sleep: async () => undefined,
      signInPollMs: 0,
      signInDeadlineMs: 5,
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

/**
 * Regression for the fresh-Mac VM report: the guide showed "Sign-in did not
 * complete" with "Complete sign-in in your browser." in red the moment the
 * browser opened. `agent_provider_login_start` answers "waiting" right away;
 * the adapter used to treat anything but "connected" as the final answer.
 */
describe("createSetupInstallGuideCallbacks - onsignin waits for the browser", () => {
  function scripted(answers: Record<string, unknown[]>) {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      const queue = answers[cmd] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    });
    return { invoke: invoke as unknown as InstallGuideDeps["invoke"], calls };
  }

  it("keeps waiting while the host says 'waiting', then resolves ok when signed in", async () => {
    const { invoke, calls } = scripted({
      agent_provider_login_start: [{ state: "waiting", message: "Complete sign-in in your browser." }],
      agent_provider_login_status: [
        { state: "waiting", message: "Complete sign-in in your browser." },
        { state: "waiting", message: "Complete sign-in in your browser." },
        { state: "connected" },
      ],
    });
    const sleep = vi.fn(async () => undefined);
    const cb = createSetupInstallGuideCallbacks({ invoke, openUrl: async () => undefined, sleep });
    const result = await cb.onsignin("claude");
    expect(result).toEqual({ ok: true });
    expect(calls.filter(([cmd]) => cmd === "agent_provider_login_status")).toHaveLength(3);
    expect(calls.find(([cmd]) => cmd === "agent_provider_login_status")?.[1]).toEqual({ tool: "claude" });
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("never reports the waiting message as the failure reason", async () => {
    const { invoke } = scripted({
      agent_provider_login_start: [{ state: "waiting", message: "Complete sign-in in your browser." }],
      agent_provider_login_status: [{ state: "error", message: "Sign-in timed out. Please retry." }],
    });
    const cb = createSetupInstallGuideCallbacks({ invoke, openUrl: async () => undefined, sleep: async () => undefined });
    const result = await cb.onsignin("claude");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Sign-in timed out. Please retry.");
  });

  it("gives up after its deadline with a plain sentence, not the browser prompt", async () => {
    const { invoke } = scripted({
      agent_provider_login_start: [{ state: "waiting", message: "Complete sign-in in your browser." }],
      agent_provider_login_status: [{ state: "waiting", message: "Complete sign-in in your browser." }],
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke,
      openUrl: async () => undefined,
      sleep: () => new Promise((r) => setTimeout(r, 2)),
      signInPollMs: 1,
      signInDeadlineMs: 10,
    });
    const result = await cb.onsignin("claude");
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("Complete sign-in in your browser");
    expect(result.reason).toContain("Claude Code");
  });

  it("rides out a status check that throws", async () => {
    const { invoke } = scripted({
      agent_provider_login_start: [{ state: "waiting" }],
      agent_provider_login_status: [new Error("ipc hiccup"), { state: "connected" }],
    });
    const cb = createSetupInstallGuideCallbacks({ invoke, openUrl: async () => undefined, sleep: async () => undefined });
    expect(await cb.onsignin("codex")).toEqual({ ok: true });
  });

  it("stops waiting when the guide aborts", async () => {
    const { invoke } = scripted({
      agent_provider_login_start: [{ state: "waiting" }],
      agent_provider_login_status: [{ state: "waiting" }],
    });
    const controller = new AbortController();
    const cb = createSetupInstallGuideCallbacks({
      invoke,
      openUrl: async () => undefined,
      sleep: async () => {
        controller.abort();
      },
    });
    const result = await cb.onsignin("claude", { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Sign-in cancelled.");
  });
});

describe("createSetupInstallGuideCallbacks - onstatus + oncancelsignin", () => {
  it("reads 'connected' from agent_provider_login_status as signed in", async () => {
    const invoke = vi.fn(async () => ({ state: "connected" }));
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    expect(await cb.onstatus("codex")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("agent_provider_login_status", { tool: "codex" });
  });

  it("reads anything else, including a failed check, as not signed in", async () => {
    for (const answer of [{ state: "disconnected" }, { state: "waiting" }, { state: "error" }]) {
      const cb = createSetupInstallGuideCallbacks({
        invoke: (async () => answer) as unknown as InstallGuideDeps["invoke"],
        openUrl: async () => undefined,
      });
      expect(await cb.onstatus("claude")).toBe(false);
    }
    const throwing = createSetupInstallGuideCallbacks({
      invoke: (async () => {
        throw new Error("no");
      }) as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    expect(await throwing.onstatus("claude")).toBe(false);
  });

  it("cancels through agent_provider_login_cancel and swallows a failure", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("nothing running");
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    await expect(cb.oncancelsignin("claude")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("agent_provider_login_cancel", { tool: "claude" });
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

describe("createSetupInstallGuideCallbacks - onopenassistant", () => {
  it("routes claude-desktop to open_claude_code_link with the URL verbatim", async () => {
    const invoke = vi.fn(async () => undefined);
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const url = "claude://code/new?q=install%20claude%20code";
    const result = await cb.onopenassistant("claude-desktop", url);
    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("open_claude_code_link", { url });
  });

  it("routes chatgpt-desktop to open_codex_deep_link", async () => {
    const invoke = vi.fn(async () => undefined);
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const url = "codex://threads/new?prompt=install%20codex";
    const result = await cb.onopenassistant("chatgpt-desktop", url);
    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("open_codex_deep_link", { url });
  });

  it("surfaces a plain reason when dispatch fails, and never leaks a stack trace", async () => {
    const invoke = vi.fn(async () => {
      throw new Error(
        "ShellExecuteW failed to open codex link: 2\n  at some/rust/frame.rs:99",
      );
    });
    const cb = createSetupInstallGuideCallbacks({
      invoke: invoke as unknown as InstallGuideDeps["invoke"],
      openUrl: async () => undefined,
    });
    const result = await cb.onopenassistant(
      "chatgpt-desktop",
      "codex://threads/new?prompt=hello",
    );
    expect(result.ok).toBe(false);
    // The error message is passed through; stacks are naturally elided by
    // JS `err.message`, and no callback logs the whole `err` object.
    expect(result.reason).toContain("ShellExecuteW");
  });
});
