import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_AI_TOOLS, type AiTools } from "../../settings/setup-launch.js";
import type { RuntimeSignInApi } from "../create-bot/RuntimeSignIn.svelte";
import type { RuntimeStatus } from "../create-bot/runtime-status.js";
import { FIRST_RUN_BANNED_DASHES } from "./visual-first-run.js";
import {
  TOOL_SIGNIN_CHECK_DEADLINE_MS,
  TOOL_SIGNIN_COPY,
  checkedReadiness,
  createSignInChecker,
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
  type ToolSignInChecks,
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

  it("a start that never answers is called off at the deadline, so the browser cannot open after the failure", async () => {
    const hung = api({ loginStart: vi.fn(() => new Promise<never>(() => {})) });
    const { runner, onfailed } = run(hung, 1000);
    runner.start("claude");
    await vi.advanceTimersByTimeAsync(999);
    expect(hung.loginCancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.current()).toEqual({ tool: "claude", phase: "failed" });
    expect(hung.loginCancel).toHaveBeenCalledTimes(1);
    expect(hung.loginCancel).toHaveBeenCalledWith("claude");
    expect(onfailed).toHaveBeenCalledWith("claude");
  });

  it("a plain error from the host is not cancelled again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = api({ loginStart: vi.fn(async () => ({ state: "error" as const })) });
    const { runner } = run(host);
    runner.start("codex");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.current()?.phase).toBe("failed");
    expect(host.loginCancel).not.toHaveBeenCalled();
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

// A stored login is not a working one: `claude auth status` reports a login
// whose refresh token is dead as signed in. The owner's first run said
// "Signed in", created the assistant saying so, and its first turn failed with
// an expired session. These pin the real check that now stands in between.
describe("the real sign-in check", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const STORED = { claude: true, codex: false, grok: false };
  const ok = (value: unknown) => ({ ok: true as const, value });

  function checker(probe: ((tool: "claude" | "codex") => Promise<unknown>) | null) {
    const seen: ToolSignInChecks[] = [];
    const c = createSignInChecker({
      probe: probe as never,
      onchange: (checks) => seen.push(checks),
    });
    return { c, seen };
  }

  it("a stored but dead login: the row offers Sign in, it does not count, and Sign in replaces it", async () => {
    const probe = vi.fn(async () => ok({ ok: false, class: "signed-out", detail: "OAuth session expired" }));
    const { c } = checker(probe);
    c.sync(STORED);
    // While the check runs the row reads Checking and nothing counts yet.
    expect(c.current()).toEqual({ claude: "checking" });
    expect(toolRowKinds({ claude: IN, codex: OUT }, STORED, null, c.current()).claude).toBe("checking");
    expect(checkedReadiness(STORED, c.current())?.claude).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("claude");
    expect(c.current()).toEqual({ claude: "signedOut" });
    expect(toolRowKinds({ claude: IN, codex: OUT }, STORED, null, c.current()).claude).toBe("signIn");
    expect(checkedReadiness(STORED, c.current())?.claude).toBe(false);
    expect(c.needsForce("claude")).toBe(true);
    // Readiness read again with the same stored login: no second check.
    c.sync(STORED);
    expect(probe).toHaveBeenCalledTimes(1);
    // The sign-in that replaced it counts.
    c.signedIn("claude");
    expect(c.current()).toEqual({ claude: "passed" });
    expect(c.needsForce("claude")).toBe(false);
    expect(checkedReadiness(STORED, c.current())?.claude).toBe(true);
  });

  it("Sign in on a dead login runs a forced login (log out, then in)", async () => {
    const host: RuntimeSignInApi = {
      loginStart: vi.fn(async () => ({ state: "connected" as const })),
      loginStatus: vi.fn(async () => ({ state: "connected" as const })),
    };
    const onconnected = vi.fn();
    const runner = createToolSignInRunner({
      api: host,
      onchange: () => {},
      onconnected,
      force: (tool) => tool === "claude",
    });
    runner.start("claude");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.loginStart).toHaveBeenCalledWith("claude", { force: true });
    expect(onconnected).toHaveBeenCalledWith("claude");
    // A tool whose login is not dead signs in as before.
    runner.start("codex");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.loginStart).toHaveBeenLastCalledWith("codex");
  });

  it("a valid login shows Signed in once the check passed", async () => {
    const probe = vi.fn(async (_tool: "claude" | "codex") => ok({ ok: true, class: null }));
    const { c } = checker(probe);
    c.sync({ claude: true, codex: true, grok: false });
    await vi.advanceTimersByTimeAsync(0);
    // Codex goes through the same check.
    expect(probe.mock.calls.map(([tool]) => tool)).toEqual(["claude", "codex"]);
    expect(c.current()).toEqual({ claude: "passed", codex: "passed" });
    const kinds = toolRowKinds({ claude: IN, codex: IN }, { claude: true, codex: true }, null, c.current());
    expect(kinds).toEqual({ claude: "signedIn", codex: "signedIn" });
    expect(checkedReadiness({ claude: true, codex: true, grok: false }, c.current())).toEqual({
      claude: true,
      codex: true,
      grok: false,
    });
  });

  it("a check that never answers does not block: at the deadline the stored login counts, and it is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const { c } = checker(probe);
    c.sync(STORED);
    await vi.advanceTimersByTimeAsync(TOOL_SIGNIN_CHECK_DEADLINE_MS - 1);
    expect(c.current()).toEqual({ claude: "checking" });
    await vi.advanceTimersByTimeAsync(1);
    expect(c.current()).toEqual({ claude: "unverified" });
    expect(toolRowKinds({ claude: IN, codex: OUT }, STORED, null, c.current()).claude).toBe("signedIn");
    expect(checkedReadiness(STORED, c.current())?.claude).toBe(true);
    expect(c.needsForce("claude")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["a transient failure", async () => ok({ ok: false, class: "transient" })],
    ["an unknown failure", async () => ok({ ok: false, class: "unknown" })],
    ["a check that could not run", async () => ({ ok: false as const, message: "hq not found" })],
    ["a check that threw", async () => Promise.reject(new Error("boom"))],
    ["an hq CLI without the check", async () => ok({ supported: false })],
  ])("%s does not block: the stored login counts as before", async (_label, answer) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { c } = checker(vi.fn(answer));
    c.sync(STORED);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.current()).toEqual({ claude: "unverified" });
    expect(checkedReadiness(STORED, c.current())?.claude).toBe(true);
  });

  it("a host without the check takes the stored login at its word", async () => {
    const { c } = checker(null);
    c.sync(STORED);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.current()).toEqual({ claude: "unverified" });
  });

  it("a login that is gone forgets the old verdict, so the next stored one is checked afresh", async () => {
    const answers = [ok({ ok: false, class: "signed-out" }), ok({ ok: true })];
    const probe = vi.fn(async () => answers.shift());
    const { c } = checker(probe);
    c.sync(STORED);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.current()).toEqual({ claude: "signedOut" });
    c.sync({ claude: false, codex: false, grok: false });
    expect(c.current()).toEqual({});
    c.sync(STORED);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(c.current()).toEqual({ claude: "passed" });
  });

  it("without checks (a host that runs none) nothing changes", () => {
    expect(checkedReadiness(STORED, null)).toBe(STORED);
    expect(toolRowKinds({ claude: IN, codex: OUT }, STORED, null, null).claude).toBe("signedIn");
  });
});
