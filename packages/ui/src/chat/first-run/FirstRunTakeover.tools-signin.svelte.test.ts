// @vitest-environment happy-dom

/**
 * Your coding tools is required (owner, 2026-10-10): "We totally need at
 * least one coding tool signed in since the local bot runs on that so we
 * should facilitate signin." No Continue in chat on this screen, a one-click
 * Sign in per tool, readiness read again when a sign-in ends or the window
 * comes back, and the tool whose desktop app is here first. These tests
 * change props on a mounted takeover, so they live in a runes test file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import { NO_AI_TOOLS, type AiTools } from "../../settings/setup-launch.js";
import type { RuntimeSignInApi, RuntimeSignInState } from "../create-bot/RuntimeSignIn.svelte";
import type { RuntimeStatus } from "../create-bot/runtime-status.js";
import type { FirstRunCreation } from "./visual-first-run.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

const NONE = { claude: false, codex: false, grok: false };
const OUT: RuntimeStatus = { state: "signedOut" };
const IN: RuntimeStatus = { state: "signedIn" };
const MISSING: RuntimeStatus = { state: "notInstalled", searched: [] };

interface Setup {
  ready?: Record<string, boolean> | null;
  status?: Record<string, RuntimeStatus> | null;
  aiTools?: AiTools | null;
  creation?: FirstRunCreation;
  api?: RuntimeSignInApi | null;
  /** What the host's readiness read answers after a sign-in. */
  afterSignIn?: { ready: Record<string, boolean>; status: Record<string, RuntimeStatus> };
}

function render(setup: Setup = {}) {
  const props = $state({
    runtimeReady: setup.ready === undefined ? NONE : setup.ready,
    runtimeStatus: setup.status === undefined ? { claude: OUT, codex: OUT } : setup.status,
    aiTools: setup.aiTools === undefined ? NO_AI_TOOLS : setup.aiTools,
    creation: setup.creation ?? ({ state: "idle" } as FirstRunCreation),
  });
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(),
    ontalk: vi.fn(),
    oncontinueinchat: vi.fn(),
    onruntime: vi.fn(),
    onrequestaitools: vi.fn(),
    onopenassistant: vi.fn(async () => ({ ok: true })),
    onassistedinstall: vi.fn(async () => ({ ok: true })),
    onrecheck: vi.fn(async () => {}),
    onsignedin: vi.fn(async () => {
      if (!setup.afterSignIn) return;
      props.runtimeReady = setup.afterSignIn.ready;
      props.runtimeStatus = setup.afterSignIn.status;
    }),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunTakeover, {
    target: host,
    props: {
      initialName: "Pickles",
      initialStep: "tools",
      get runtimeReady() {
        return props.runtimeReady;
      },
      get runtimeStatus() {
        return props.runtimeStatus;
      },
      get aiTools() {
        return props.aiTools;
      },
      get creation() {
        return props.creation;
      },
      signInApi: setup.api === undefined ? null : setup.api,
      pollMs: 10,
      ...handlers,
    },
  });
  return { props, handlers };
}

function signInApi(start: RuntimeSignInState, statuses: RuntimeSignInState[] = []): RuntimeSignInApi {
  return {
    loginStart: vi.fn(async () => start),
    loginStatus: vi.fn(async () => statuses.shift() ?? { state: "connected" as const }),
    loginCancel: vi.fn(async () => ({ state: "disconnected" as const })),
  };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

const chatExits = () =>
  ['[data-testid="first-run-continue-in-chat"]', '[data-testid="first-run-failed-chat"]'].filter((sel) => q(sel));

describe("Your coding tools: no Continue in chat", () => {
  it("has no Continue in chat while no tool is signed in, and Next stays held", async () => {
    render();
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("tools");
    expect(chatExits()).toEqual([]);
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Continue in chat");
  });

  it("has none with a tool signed in, while signing in, or with a failed create", async () => {
    render({ ready: { claude: true, codex: false, grok: false }, status: { claude: IN, codex: OUT } });
    await settle();
    expect(chatExits()).toEqual([]);
    await unmount(component!);
    component = null;
    host.remove();

    render({ api: signInApi({ state: "waiting" }, [{ state: "waiting" }, { state: "waiting" }]) });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-tool-claude-signin"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-tool-claude"]')?.getAttribute("data-phase")).toBe("waiting");
    expect(chatExits()).toEqual([]);
    await unmount(component!);
    component = null;
    host.remove();

    render({ creation: { state: "failed", name: "Pickles", reason: "Could not create setup." } });
    await settle();
    expect(q('[data-testid="first-run-retry"]')).toBeTruthy();
    expect(chatExits()).toEqual([]);
  });

  it("Escape stays blocked", async () => {
    const { handlers } = render();
    await settle();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(handlers.oncontinueinchat).not.toHaveBeenCalled();
    expect(q('[data-testid="first-run-takeover"]')).toBeTruthy();
  });

  it("other screens keep Continue in chat", async () => {
    render({ ready: { claude: true, codex: false, grok: false }, status: { claude: IN, codex: OUT } });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-back"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("name");
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeTruthy();
  });
});

describe("Your coding tools: Sign in per tool", () => {
  it("offers a one-click Sign in for Claude Code and for Codex", async () => {
    render({ api: signInApi({ state: "waiting" }) });
    await settle();
    expect(q('[data-testid="first-run-tool-claude-signin"]')?.textContent).toBe("Sign in with your Claude account");
    expect(q('[data-testid="first-run-tool-codex-signin"]')?.textContent).toBe("Sign in with your ChatGPT account");
    // The flow's tool cards are not on screen while none is signed in.
    expect(q('[data-testid="create-bot-runtime-cards"]')).toBeNull();
  });

  it("Sign in runs the tool's login, and the screen turns ready once readiness says signed in", async () => {
    const api = signInApi({ state: "waiting" }, [{ state: "waiting" }, { state: "connected" }]);
    const { handlers } = render({
      api,
      afterSignIn: { ready: { claude: false, codex: true, grok: false }, status: { claude: OUT, codex: IN } },
    });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-tool-codex-signin"]')!.click();
    await settle();
    expect(api.loginStart).toHaveBeenCalledWith("codex");
    expect(handlers.onruntime).toHaveBeenLastCalledWith("codex");
    const note = q('[data-testid="first-run-tool-codex-note"]')?.textContent ?? "";
    expect(note).toContain("Finish signing in in your browser");
    expect(q('[data-testid="first-run-live"]')?.textContent).toContain("Finish signing in");
    // Only one sign-in at a time.
    expect(q<HTMLButtonElement>('[data-testid="first-run-tool-claude-signin"]')?.disabled).toBe(true);
    await vi.waitFor(() => expect(handlers.onsignedin).toHaveBeenCalledWith("codex"));
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(false);
    expect(q('[data-testid="first-run-tools-signin"]')).toBeNull();
    expect(q('[data-testid="chat-bot-runtime-codex"]')?.getAttribute("data-ready")).toBe("true");
    expect(q('[data-testid="chat-bot-runtime-codex"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("a failed sign-in says so plainly with Try again, and reads readiness again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = signInApi({ state: "error", message: "exit status 1: claude auth login failed" });
    const { handlers } = render({ api });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-tool-claude-signin"]')!.click();
    await settle();
    const row = q('[data-testid="first-run-tool-claude"]')!;
    expect(row.getAttribute("data-phase")).toBe("failed");
    expect(q('[data-testid="first-run-tool-claude-note"]')?.textContent?.trim()).toBe("Sign in did not finish.");
    expect(document.body.textContent).not.toContain("exit status");
    expect(document.body.textContent).not.toContain("auth login");
    expect(handlers.onrecheck).toHaveBeenCalled();
    q<HTMLButtonElement>('[data-testid="first-run-tool-claude-retry"]')!.click();
    await settle();
    expect(api.loginStart).toHaveBeenCalledTimes(2);
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
  });

  it("reads readiness again when the window comes back into focus", async () => {
    const { handlers } = render();
    await settle();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(handlers.onrecheck).toHaveBeenCalledTimes(1);
    expect(handlers.onrequestaitools).toHaveBeenCalled();
  });
});

describe("Your coding tools: lead with the desktop app that is here", () => {
  it("Claude Desktop: Claude Code first, preselected, and the copy names the Claude account", async () => {
    const { handlers } = render({
      aiTools: { ...NO_AI_TOOLS, claude_desktop: true, claude_cli: true, any: true },
      api: signInApi({ state: "waiting" }),
    });
    await settle();
    const rows = [...document.querySelectorAll('[data-testid="first-run-tools-signin"] > li')].map((li) => li.getAttribute("data-testid"));
    expect(rows).toEqual(["first-run-tool-claude", "first-run-tool-codex"]);
    expect(q('[data-testid="first-run-tools-lead"]')?.textContent).toContain("sign in with your Claude account");
    expect(q('[data-testid="first-run-tool-claude-signin"]')?.classList.contains("primary")).toBe(true);
    expect(handlers.onruntime).not.toHaveBeenCalledWith("codex");
  });

  it("the ChatGPT app with Codex: Codex first, preselected, and the copy names the ChatGPT account", async () => {
    const { handlers } = render({
      aiTools: { ...NO_AI_TOOLS, codex_desktop: true, codex_cli: true, any: true },
      api: signInApi({ state: "waiting" }),
    });
    await settle();
    const rows = [...document.querySelectorAll('[data-testid="first-run-tools-signin"] > li')].map((li) => li.getAttribute("data-testid"));
    expect(rows).toEqual(["first-run-tool-codex", "first-run-tool-claude"]);
    expect(q('[data-testid="first-run-tools-lead"]')?.textContent).toContain(
      "You have the ChatGPT app, so sign in with your ChatGPT account.",
    );
    expect(q('[data-testid="first-run-tool-codex-signin"]')?.classList.contains("primary")).toBe(true);
    expect(handlers.onruntime).toHaveBeenCalledWith("codex");
  });

  it("Claude Desktop before its Code tab was used: says so with one next step, and leads with Codex", async () => {
    const { handlers } = render({
      status: { claude: MISSING, codex: OUT },
      aiTools: { ...NO_AI_TOOLS, claude_desktop: true, any: true },
      api: signInApi({ state: "waiting" }),
    });
    await settle();
    expect(q('[data-testid="first-run-tool-claude"]')?.getAttribute("data-kind")).toBe("openDesktop");
    expect(q('[data-testid="first-run-tool-claude-note"]')?.textContent).toContain(
      "The Claude app is here, but Claude Code is not set up in it yet.",
    );
    expect(q('[data-testid="first-run-tool-claude-signin"]')).toBeNull();
    const open = q<HTMLButtonElement>('[data-testid="first-run-tool-claude-openDesktop"]')!;
    expect(open.textContent).toBe("Open Claude");
    // The other tool is still offered, first.
    const rows = [...document.querySelectorAll('[data-testid="first-run-tools-signin"] > li')].map((li) => li.getAttribute("data-testid"));
    expect(rows[0]).toBe("first-run-tool-codex");
    expect(q('[data-testid="first-run-tool-codex-signin"]')).toBeTruthy();
    open.click();
    await settle();
    expect(handlers.onopenassistant).toHaveBeenCalledWith("claude-desktop", expect.stringMatching(/^claude:\/\/code\/new\?/));
    expect(q('[data-testid="first-run-tool-claude-recheck"]')).toBeTruthy();
  });

  it("a ChatGPT app without Codex in it is not a Codex source: Codex is not led with", async () => {
    // detect_ai_tools reports codex_desktop only when the bundled codex is there.
    render({
      status: { claude: OUT, codex: MISSING },
      aiTools: { ...NO_AI_TOOLS, codex_desktop: false, any: false },
    });
    await settle();
    const rows = [...document.querySelectorAll('[data-testid="first-run-tools-signin"] > li')].map((li) => li.getAttribute("data-testid"));
    expect(rows[0]).toBe("first-run-tool-claude");
    expect(q('[data-testid="first-run-tool-codex"]')?.getAttribute("data-kind")).toBe("install");
  });
});
