// @vitest-environment happy-dom

// Host wiring for the native setup run: a `setupRun` API on the registered
// Sessions page makes #welcome's Run Setup run in place (no navigation, no
// early graduation), "Show details" opens that session on the Sessions page
// with its id as the param, and the finish graduates welcome-first boot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import type { SetupRunApi, SetupRunEvent, SetupRunSnapshot } from "../chat/setup-run.js";

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

function fakeSetupRun() {
  const listeners = new Set<(snapshot: SetupRunSnapshot) => void>();
  const events: SetupRunEvent[] = [];
  const api: SetupRunApi & { emit(event: SetupRunEvent, phase?: SetupRunSnapshot["phase"]): void } = {
    preflight: vi.fn(async () => "ready" as const),
    start: vi.fn(async () => "sess-42"),
    attach: vi.fn(async () => true),
    subscribe: vi.fn((_sessionId: string, cb: (snapshot: SetupRunSnapshot) => void) => {
      listeners.add(cb);
      cb({ sessionId: "sess-42", events: [...events], phase: "starting" });
      return () => listeners.delete(cb);
    }),
    answerQuestion: vi.fn(async () => undefined),
    respondPermission: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    emit(event, phase = "working") {
      events.push(event);
      for (const cb of listeners) cb({ sessionId: "sess-42", events: [...events], phase });
    },
  };
  return api;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(setupRun: SetupRunApi, setupParam = vi.fn(() => "new?draft=x&prompt=%2Fsetup")) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
      extraPages: {
        sessions: {
          label: "Sessions",
          detail: "Local sessions",
          component: ExtraPageProbe,
          createAction: { label: "New session", param: () => "new?draft=y" },
          setupAction: { label: "Run Setup", param: setupParam },
          setupRun,
        },
      },
    },
  });
  await settle();
  const row = host.querySelector<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
  expect(row, "pinned #welcome row renders").toBeTruthy();
  row!.click();
  await settle();
  return setupParam;
}

describe("DesktopApp native setup run wiring", () => {
  it("runs setup inside #welcome instead of opening the Sessions draft", async () => {
    const api = fakeSetupRun();
    const setupParam = await mountApp(api);
    const button = host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]');
    expect(button?.textContent).toContain("Run Setup");
    button!.click();
    await settle();
    expect(api.start).toHaveBeenCalledWith("/setup --guided");
    expect(setupParam).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="extra-page-probe"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-run-card"]')).toBeTruthy();
    // Starting is not finishing: a relaunch must still land on #welcome.
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBeNull();
  });

  it("the Setup Agent talks in the channel and the composer replies to it", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "[hq-setup] step=tools status=running\nChecking what's already in place on this Mac." });
    await settle();
    const messages = Array.from(host.querySelectorAll('[data-testid="conversation-message"]'));
    const agentMessage = messages.find((el) => el.textContent?.includes("Checking what's already in place"));
    expect(agentMessage).toBeTruthy();
    expect(agentMessage?.textContent).toContain("Setup Agent");
    expect(agentMessage?.textContent).not.toContain("[hq-setup]");
    // Working shows as the same thinking row any agent gets, not a box.
    expect(host.querySelector('[data-testid="agent-thinking-row"]')?.textContent).toContain("Setup Agent");
    expect(host.querySelector('[data-testid="setup-agent-prompt"] [data-testid="setup-run-question"]')).toBeNull();

    // A structured question shows as the prompt under the messages.
    api.emit(
      { kind: "questionRequest", requestId: "req-1", questions: [{ id: "q1", text: "What's your name?", options: [{ label: "Skip for now" }] }] },
      "needsYou",
    );
    await settle();
    const prompt = host.querySelector('[data-testid="setup-agent-prompt"]');
    expect(prompt?.querySelector('[data-testid="setup-run-choice"]')?.textContent?.trim()).toBe("Skip for now");
    // The question itself is the agent's message, not repeated in the prompt.
    expect(prompt?.querySelector(".question-text")).toBeNull();
    expect(host.querySelector('[data-testid="agent-thinking-row"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]')?.placeholder).toContain("Setup Agent");

    // Typing in the normal composer answers it — nothing is posted to the channel.
    const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]')!;
    composer.value = "Jacob";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
    await settle();
    expect(api.answerQuestion).toHaveBeenCalledWith("sess-42", "req-1", [{ questionId: "q1", values: ["Jacob"] }]);
  });

  it("an expired sign-in shows the Connect step under the chat instead of a bare Run Setup", async () => {
    const api = fakeSetupRun();
    // Signed in when the run starts; the sign-in has lapsed by the time the agent re-checks.
    const providers = vi.fn(async () => ({ hqReady: true, claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false }));
    api.providers = providers;
    api.providerLoginStart = vi.fn(async () => ({ state: "waiting" as const }));
    api.providerLoginStatus = vi.fn(async () => ({ state: "waiting" as const }));
    api.providerLoginCancel = vi.fn(async () => ({ state: "disconnected" as const }));
    api.providerInstallUrl = vi.fn(() => "https://claude.ai/download");
    api.openExternal = vi.fn(async () => undefined);
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "Checking tools." });
    providers.mockResolvedValue({ hqReady: true, claudeAvailable: true, claudeLoggedIn: false, codexAvailable: false, codexLoggedIn: false });
    api.emit({ kind: "error", message: "Failed to refresh OAuth token: conflict" });
    api.emit({ kind: "exited", code: 1 }, "ended");
    await settle();
    const messages = Array.from(host.querySelectorAll('[data-testid="conversation-message"]')).map((el) => el.textContent ?? "");
    expect(messages.some((text) => text.includes("Failed to refresh OAuth token"))).toBe(false);
    expect(messages.some((text) => text.includes("sign-in for your coding agent has expired"))).toBe(true);
    const connect = host.querySelector('[data-testid="setup-agent-prompt"] [data-testid="setup-connect-step"]');
    expect(connect).toBeTruthy();
    expect(connect?.classList.contains("connect--surface")).toBe(true);
    expect(host.querySelector('[data-testid="setup-agent-prompt"] [data-testid="setup-run-stopped-title"]')).toBeNull();
  });

  it("the thinking row goes away when the turn ends, and the finish buttons appear on the skill's last marker", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "Let me finish the last bit of housekeeping." });
    await settle();
    expect(host.querySelector('[data-testid="agent-thinking-row"]')).toBeTruthy();
    api.emit({ kind: "turnDone", status: "success", error: null }, "idle");
    await settle();
    expect(host.querySelector('[data-testid="agent-thinking-row"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-agent-finish"]')).toBeNull();

    api.emit({ kind: "assistantMessage", text: "`[hq-setup] step=moves status=done`\n\nAll set — you're done. Here's where you landed.\n\n**Everything's working:**\n- Tools healthy." });
    api.emit({ kind: "turnDone", status: "success", error: null }, "idle");
    await settle();
    expect(host.querySelector('[data-testid="agent-thinking-row"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-agent-finish"]')).toBeTruthy();
    const last = Array.from(host.querySelectorAll('[data-testid="conversation-message"]')).pop();
    expect(last?.textContent).toContain("All set — you're done");
    expect(last?.textContent).not.toContain("[hq-setup]");
    expect(last?.querySelector("strong")?.textContent).toBe("Everything's working:");
  });

  it("a usage-limit stop names the reason and offers the other agent right there", async () => {
    const api = fakeSetupRun();
    api.providers = vi.fn(async () => ({ hqReady: true, claudeAvailable: true, claudeLoggedIn: true, codexAvailable: true, codexLoggedIn: true }));
    api.providerLoginStart = vi.fn(async () => ({ state: "waiting" as const }));
    api.providerLoginStatus = vi.fn(async () => ({ state: "waiting" as const }));
    api.providerLoginCancel = vi.fn(async () => ({ state: "disconnected" as const }));
    api.providerInstallUrl = vi.fn(() => "https://claude.ai/download");
    api.openExternal = vi.fn(async () => undefined);
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    const reason = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.";
    api.emit({ kind: "turnDone", status: "error", error: reason }, "ended");
    await settle();
    const messages = Array.from(host.querySelectorAll('[data-testid="conversation-message"]')).map((el) => el.textContent ?? "");
    expect(messages.some((text) => text.includes("has hit its usage limit"))).toBe(true);
    const prompt = host.querySelector('[data-testid="setup-agent-prompt"]')!;
    expect(prompt.querySelector('[data-testid="setup-connect-detail"]')?.textContent).toBe(reason);
    expect(prompt.textContent).toContain("that coding agent has hit its usage limit");
    prompt.querySelector<HTMLButtonElement>('[data-testid="setup-connect-claude-run"]')!.click();
    await settle();
    expect(api.start).toHaveBeenLastCalledWith("/setup --guided", "claude");
  });

  it("finishing offers Open in Sessions, Claude Code, and Codex under the last message", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "You're all set — here's your welcome page (private to you): https://x.example/w" });
    api.emit({ kind: "turnDone", status: "success" }, "idle");
    await settle();
    const finish = host.querySelector('[data-testid="setup-agent-finish"]');
    expect(finish).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-agent-open-claude"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-agent-open-codex"]')).toBeTruthy();
    // Open in Sessions starts a fresh session with /startwork ready, not the setup transcript.
    host.querySelector<HTMLButtonElement>('[data-testid="setup-agent-open-sessions"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="extra-page-probe"]')?.getAttribute("data-param")).toBe("new?draft=y");
  });

  it("Open setup chat opens the session on the Sessions page by id", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-details"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="extra-page-probe"]')?.getAttribute("data-param")).toBe("sess-42");
  });

  it("graduates welcome-first boot once the run finishes", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "You're all set — here's your welcome page (private to you): https://x.example/w" });
    api.emit({ kind: "turnDone", status: "success" }, "idle");
    await settle();
    expect(host.querySelector('[data-testid="setup-run-done-title"]')).toBeTruthy();
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
  });

  it("falls back to the Sessions draft when the host preflight is not ready", async () => {
    const api = fakeSetupRun();
    (api.preflight as ReturnType<typeof vi.fn>).mockResolvedValue("needs-sessions-page");
    const setupParam = await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    expect(api.start).not.toHaveBeenCalled();
    expect(setupParam).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="extra-page-probe"]')?.getAttribute("data-param")).toBe(
      "new?draft=x&prompt=%2Fsetup",
    );
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
  });
});
