// @vitest-environment happy-dom

// Host wiring for the native setup run: a `setupRun` API on the registered
// Sessions page makes #welcome's Run Setup run in place (no navigation, no
// early graduation), "Show details" opens that session on the Sessions page
// with its id as the param, and the finish graduates welcome-first boot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount, type ComponentProps } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import type { SetupRunApi, SetupRunEvent, SetupRunSnapshot } from "../chat/setup-run.js";
import type { Workspace } from "../chat/workspaces.js";

const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: false,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

/** A company-scope channel row for ACME, so the rail can open it directly. */
const ACME_CHANNEL_ROW = {
  channelId: "chn_acme",
  type: "chat",
  scope: "company",
  companyUid: "cmp_acme",
  name: "acme",
  lastActivityAt: new Date().toISOString(),
};

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

async function mountApp(
  setupRun: SetupRunApi,
  setupParam = vi.fn(() => "new?draft=x&prompt=%2Fsetup"),
  extra: Partial<ComponentProps<typeof DesktopApp>> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      ...extra,
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
    // With a question open the composer invites a typed answer (the CLI's "Other").
    expect(host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]')?.placeholder).toBe("Type your answer…");

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
    // The reported phase may lag ("idle" here): words followed by a tool call still mean working.
    api.emit({ kind: "assistantMessage", text: "Let me finish the last bit of housekeeping." }, "idle");
    api.emit({ kind: "toolCall", id: "t1", name: "Bash" }, "idle");
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

  it("when the agent goes quiet without a finish marker, the person can close it out themselves", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    // Nothing offered while it works…
    api.emit({ kind: "assistantMessage", text: "You're synced and ready. Ball's in your court — /startwork when you're ready." });
    await settle();
    expect(host.querySelector('[data-testid="setup-run-finish"]')).toBeNull();
    // …but once the turn ends with nothing asked, the way out is explicit.
    api.emit({ kind: "turnDone", status: "success", error: null }, "idle");
    await settle();
    expect(host.querySelector('[data-testid="setup-agent-finish"]')).toBeNull();
    const finish = host.querySelector<HTMLButtonElement>('[data-testid="setup-agent-prompt"] [data-testid="setup-run-finish"]');
    expect(finish?.textContent?.trim()).toBe("I'm all set");
    expect(host.querySelector('[data-testid="setup-agent-prompt"] [data-testid="setup-run-again"]')).toBeTruthy();
    finish!.click();
    await settle();
    expect(host.querySelector('[data-testid="setup-agent-finish"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-run-finish"]')).toBeNull();
    // The conversation stays.
    const messages = Array.from(host.querySelectorAll('[data-testid="conversation-message"]')).map((el) => el.textContent ?? "");
    expect(messages.some((text) => text.includes("Ball's in your court"))).toBe(true);
    expect(window.localStorage.getItem("hq.welcome.setup-run.v1")).toBeTruthy();
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

  it("finishing offers Continue in HQ Sessions, Claude Code, and Codex under the last message", async () => {
    const api = fakeSetupRun();
    await mountApp(api, undefined, { companies: [ACME] });
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    // Mid-run: the composer talks to the agent; no finale yet.
    const composer = host.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]');
    expect(composer?.disabled).toBe(false);
    expect(host.querySelector('[data-testid="setup-agent-finish"]')).toBeNull();
    api.emit({ kind: "assistantMessage", text: "You're all set — here's your welcome page (private to you): https://x.example/w" });
    api.emit({ kind: "turnDone", status: "success" }, "idle");
    await settle();
    // One finale block under the last message holds every next step.
    const finish = host.querySelector('[data-testid="setup-agent-finish"]');
    expect(finish).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-agent-prompt"] [data-testid="setup-agent-finish"]')).toBe(finish);
    expect(finish!.textContent).toContain("You're set up");
    expect(finish!.querySelector('[data-testid="setup-agent-open-sessions"]')?.textContent?.trim()).toBe("Continue in HQ Sessions");
    expect(finish!.querySelector('[data-testid="setup-agent-open-claude"]')?.textContent?.trim()).toBe("Continue in Claude Code");
    expect(finish!.querySelector('[data-testid="setup-agent-open-codex"]')?.textContent?.trim()).toBe("Continue in Codex");
    expect(finish!.querySelector('[data-testid="setup-run-again"]')).toBeTruthy();
    // The company channel, not the setup transcript, is the bottom-row way on.
    expect(finish!.querySelector('[data-testid="setup-finale-open-company"]')?.textContent?.trim()).toBe(
      "Continue setup for Acme",
    );
    // Nowhere in #welcome — the hero's own copy goes once the run is done too.
    expect(host.querySelector('[data-testid="setup-run-details"]')).toBeNull();
    expect(host.textContent).not.toContain("Open setup chat");
    expect(host.querySelectorAll('[data-testid="setup-run-again"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="setup-run-done-title"]')).toBeNull();
    expect(finish!.querySelectorAll('[data-testid^="setup-finale-resource-"]').length).toBeGreaterThan(0);
    // The composer rests: setup is over, the finale is the way forward.
    expect(composer?.disabled).toBe(true);
    expect(composer?.getAttribute("placeholder")).toBe("Setup is complete — pick a next step above.");
    expect(host.querySelector('[data-testid="composer-send"]')?.getAttribute("aria-disabled")).toBe("true");
    // No first-moves list anywhere in #welcome.
    expect(host.querySelector('[data-testid="first-moves"]')).toBeNull();
    // Open in Sessions starts a fresh session with /startwork ready, not the setup transcript.
    finish!.querySelector<HTMLButtonElement>('[data-testid="setup-agent-open-sessions"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="extra-page-probe"]')?.getAttribute("data-param")).toBe("new?draft=y");
  });

  it("the finale's Open <Company> selects that company's channel when the rail has it", async () => {
    const api = fakeSetupRun();
    const onselectrow = vi.fn();
    await mountApp(api, undefined, {
      companies: [{ ...ACME, state: "synced", hasLocalFolder: true }],
      seedDirectory: [ACME_CHANNEL_ROW],
      onselectrow,
    });
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "You're all set — here's your welcome page (private to you): https://x.example/w" });
    api.emit({ kind: "turnDone", status: "success" }, "idle");
    await settle();
    const open = host.querySelector<HTMLButtonElement>(
      '[data-testid="setup-agent-finish"] [data-testid="setup-finale-open-company"]',
    );
    expect(open?.textContent?.trim()).toBe("Open Acme");
    expect(open?.getAttribute("data-variant")).toBe("secondary");
    open!.click();
    await settle(10);
    expect(onselectrow).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "ch:chn_acme", companyUid: "cmp_acme" }),
    );
    // Off #welcome and onto the company channel; no Sessions page opened.
    expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeNull();
    expect(host.querySelector('[data-testid="extra-page-probe"]')).toBeNull();
  });

  it("the finale has no company button when the roster is empty", async () => {
    const api = fakeSetupRun();
    await mountApp(api);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    api.emit({ kind: "assistantMessage", text: "You're all set — here's your welcome page (private to you): https://x.example/w" });
    api.emit({ kind: "turnDone", status: "success" }, "idle");
    await settle();
    expect(host.querySelector('[data-testid="setup-agent-finish"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-finale-open-company"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-run-details"]')).toBeNull();
  });

  it("Open setup chat opens the running session on the Sessions page by id (mid-run only)", async () => {
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
    // The finale (not the run card's done face) marks the finish under the chat.
    expect(host.querySelector('[data-testid="setup-agent-finish"] [data-testid="setup-finale-title"]')).toBeTruthy();
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
