import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_AI_TOOLS, type AiTools } from "../../settings/setup-launch.js";
import type { RuntimeSignInApi } from "../create-bot/RuntimeSignIn.svelte";
import type { RuntimeStatus } from "../create-bot/runtime-status.js";
import { FIRST_RUN_BANNED_DASHES } from "./visual-first-run.js";
import {
  TOOL_SIGNIN_COPY,
  createToolSignInRunner,
  orderedSignInTools,
  preferredSignInTool,
  toolRowAction,
  toolRowKind,
  toolRowKinds,
  toolRowNote,
  toolSignInLabel,
  toolsSignInLead,
  type ToolRowKind,
  type ToolSignInState,
} from "./tools-signin.js";

const tools = (patch: Partial<AiTools>): AiTools => ({ ...NO_AI_TOOLS, ...patch });
const OUT: RuntimeStatus = { state: "signedOut" };
const IN: RuntimeStatus = { state: "signedIn" };
const MISSING: RuntimeStatus = { state: "notInstalled", searched: ["/opt/homebrew/bin"] };
const NONE = { claude: false, codex: false, grok: false };

describe("toolRowKind: signed in is only what the binary HQ runs says", () => {
  it("a desktop app being here never counts as signed in", () => {
    const desktop = tools({ claude_desktop: true, codex_desktop: true });
    expect(toolRowKind("claude", OUT, NONE, desktop)).toBe("signIn");
    expect(toolRowKind("codex", OUT, NONE, desktop)).toBe("signIn");
    expect(toolRowKind("claude", MISSING, NONE, desktop)).toBe("openDesktop");
  });

  it("reads each state", () => {
    expect(toolRowKind("claude", IN, NONE, null)).toBe("signedIn");
    expect(toolRowKind("claude", null, { claude: true }, null)).toBe("signedIn");
    expect(toolRowKind("claude", MISSING, NONE, null)).toBe("install");
    expect(toolRowKind("codex", { state: "probeFailed", reason: "x" }, NONE, null)).toBe("recheck");
    // A host without per-tool status: the booleans decide.
    expect(toolRowKind("codex", null, NONE, null)).toBe("signIn");
    // Nothing known yet.
    expect(toolRowKind("codex", null, null, null)).toBe("checking");
  });

  it("toolRowKinds reads both tools off the host's maps", () => {
    expect(toolRowKinds({ claude: MISSING, codex: OUT }, NONE, tools({ claude_desktop: true }))).toEqual({
      claude: "openDesktop",
      codex: "signIn",
    });
  });
});

describe("preferredSignInTool: lead with the tool whose desktop app is here", () => {
  const both: Record<"claude" | "codex", ToolRowKind> = { claude: "signIn", codex: "signIn" };

  it("leads with Codex when only the ChatGPT app (with Codex) is here", () => {
    expect(preferredSignInTool(both, tools({ codex_desktop: true }))).toBe("codex");
    expect(orderedSignInTools("codex")).toEqual(["codex", "claude"]);
  });

  it("leads with Claude Code when Claude Desktop is here, and when both or neither are", () => {
    expect(preferredSignInTool(both, tools({ claude_desktop: true }))).toBe("claude");
    expect(preferredSignInTool(both, tools({ claude_desktop: true, codex_desktop: true }))).toBe("claude");
    expect(preferredSignInTool(both, NO_AI_TOOLS)).toBe("claude");
    expect(preferredSignInTool(both, null)).toBe("claude");
  });

  it("Claude Desktop without a runnable Claude Code still leads with a tool that can sign in", () => {
    const kinds = { claude: "openDesktop", codex: "signIn" } as const;
    expect(preferredSignInTool(kinds, tools({ claude_desktop: true }))).toBe("codex");
    // Nothing can sign in: the desktop app's tool leads, with its next step.
    expect(preferredSignInTool({ claude: "openDesktop", codex: "install" }, tools({ claude_desktop: true }))).toBe("claude");
  });
});

describe("copy", () => {
  it("names the account to use when the lead tool's desktop app is here", () => {
    const kinds = { claude: "signIn", codex: "signIn" } as const;
    expect(toolsSignInLead("Pickles", "Mac", "claude", kinds, tools({ claude_desktop: true }))).toBe(
      "Pickles thinks with Claude Code on this Mac. You have the Claude app, so sign in with your Claude account. One coding tool is enough.",
    );
    expect(toolsSignInLead("Pickles", "Mac", "codex", kinds, tools({ codex_desktop: true }))).toContain(
      "You have the ChatGPT app, so sign in with your ChatGPT account.",
    );
    expect(toolsSignInLead("Pickles", "Mac", "claude", kinds, NO_AI_TOOLS)).toBe(
      "Pickles thinks with a coding tool signed in on this Mac, under your own login. Sign in to one to go on.",
    );
    expect(toolSignInLabel("claude")).toBe("Sign in with your Claude account");
    expect(toolSignInLabel("codex")).toBe("Sign in with your ChatGPT account");
  });

  it("says plainly when Claude Desktop has no Claude Code yet, with one next step", () => {
    expect(toolRowNote("claude", "openDesktop", "Mac")).toBe(
      "The Claude app is here, but Claude Code is not set up in it yet. Open Claude and use its Code tab once, then come back.",
    );
    expect(toolRowAction("claude", "openDesktop")).toBe("Open Claude");
  });

  it("never uses dashes, commands or CLI words", () => {
    const lines: string[] = [];
    for (const tool of ["claude", "codex"] as const) {
      for (const kind of ["checking", "signIn", "signedIn", "openDesktop", "install", "recheck"] as const) {
        lines.push(toolRowNote(tool, kind, "Mac"), toolRowAction(tool, kind) ?? "");
      }
      lines.push(TOOL_SIGNIN_COPY.openFailed(tool), TOOL_SIGNIN_COPY.opened(tool), TOOL_SIGNIN_COPY.installing(tool, "Mac"));
      lines.push(toolsSignInLead("Pickles", "Mac", tool, { claude: "signIn", codex: "signIn" }, tools({ claude_desktop: true, codex_desktop: true })));
    }
    lines.push(TOOL_SIGNIN_COPY.opening, TOOL_SIGNIN_COPY.waiting, TOOL_SIGNIN_COPY.failed, TOOL_SIGNIN_COPY.installFailed);
    for (const line of lines) {
      for (const dash of FIRST_RUN_BANNED_DASHES) expect(line).not.toContain(dash);
      expect(line).not.toMatch(/\b(auth login|codex login|terminal|npm|CLI|hq )\b/);
    }
  });
});

describe("createToolSignInRunner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function api(patch: Partial<RuntimeSignInApi> = {}): RuntimeSignInApi {
    return {
      loginStart: vi.fn(async () => ({ state: "waiting" as const })),
      loginStatus: vi.fn(async () => ({ state: "waiting" as const })),
      loginCancel: vi.fn(async () => ({ state: "disconnected" as const })),
      ...patch,
    };
  }

  function run(host: RuntimeSignInApi, openTimeoutMs = 20_000) {
    const states: (ToolSignInState | null)[] = [];
    const onconnected = vi.fn();
    const onfailed = vi.fn();
    const runner = createToolSignInRunner({
      api: host,
      pollMs: 100,
      openTimeoutMs,
      onchange: (state) => states.push(state),
      onconnected,
      onfailed,
    });
    return { runner, states, onconnected, onfailed };
  }

  it("starts the tool's login, polls, and reports connected once", async () => {
    const statuses = [{ state: "waiting" as const }, { state: "connected" as const }];
    const host = api({ loginStatus: vi.fn(async () => statuses.shift() ?? { state: "connected" as const }) });
    const { runner, states, onconnected } = run(host);
    runner.start("codex");
    runner.start("codex");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.loginStart).toHaveBeenCalledTimes(1);
    expect(host.loginStart).toHaveBeenCalledWith("codex");
    expect(runner.current()).toEqual({ tool: "codex", phase: "waiting" });
    await vi.advanceTimersByTimeAsync(250);
    expect(runner.current()).toEqual({ tool: "codex", phase: "connected" });
    expect(onconnected).toHaveBeenCalledTimes(1);
    expect(onconnected).toHaveBeenCalledWith("codex");
    expect(states.map((s) => s?.phase)).toEqual(["opening", "waiting", "connected"]);
  });

  it("an error from the host is a plain failure, and Try again starts over", async () => {
    const host = api({ loginStart: vi.fn(async () => ({ state: "error" as const, message: "exit status 1: raw" })) });
    const { runner, onfailed } = run(host);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runner.start("claude");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.current()).toEqual({ tool: "claude", phase: "failed" });
    expect(onfailed).toHaveBeenCalledWith("claude");
    runner.start("claude");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.loginStart).toHaveBeenCalledTimes(2);
  });

  it("a login that ends without signing in fails, and so does a start that never answers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ended = api({ loginStatus: vi.fn(async () => ({ state: "disconnected" as const })) });
    const first = run(ended);
    first.runner.start("claude");
    await vi.advanceTimersByTimeAsync(150);
    expect(first.runner.current()?.phase).toBe("failed");

    const hung = api({ loginStart: vi.fn(() => new Promise<never>(() => {})) });
    const second = run(hung, 1000);
    second.runner.start("codex");
    await vi.advanceTimersByTimeAsync(999);
    expect(second.runner.current()?.phase).toBe("opening");
    await vi.advanceTimersByTimeAsync(1);
    expect(second.runner.current()?.phase).toBe("failed");
  });

  it("Cancel stops polling and asks the host to cancel", async () => {
    const host = api();
    const { runner } = run(host);
    runner.start("claude");
    await vi.advanceTimersByTimeAsync(0);
    runner.cancel();
    expect(runner.current()).toBeNull();
    expect(host.loginCancel).toHaveBeenCalledWith("claude");
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.loginStatus).not.toHaveBeenCalled();
  });
});
