// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import NewBotWakingScreen from "./NewBotWakingScreen.svelte";
import { beginWakingSession, recordWakingCheckFailure, WAKING_POLL_MS } from "./waking-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
}

function render(
  session = beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova", now: Date.now() }),
  overrides: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onupdate = vi.fn();
  const onclose = vi.fn();
  const onretry = vi.fn();
  const retryAgent = vi.fn(async () => ({ ok: true }));
  const onopenchat = vi.fn();
  component = mount(NewBotWakingScreen, {
    target: host,
    props: {
      session,
      getStatus: async () => ({ ok: true, value: { setupState: { phase: "creating" } } }),
      retryAgent,
      onupdate,
      onclose,
      onretry,
      onopenchat,
      ...overrides,
    },
  });
  return { onupdate, onclose, onretry, onopenchat, retryAgent };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
});

describe("NewBotWakingScreen", () => {
  it("shows one calm status line and never renders setup step labels", async () => {
    render();
    await settle();
    const screen = document.querySelector('[data-testid="new-bot-waking-screen"]');
    const ring = document.querySelector('[data-testid="new-bot-waking-ring"]');
    const status = document.querySelector('[data-testid="new-bot-waking-status"]');
    expect(screen?.textContent).toContain("Waking up Nova");
    expect(screen?.textContent).not.toMatch(/identity|membership|vault|runtime|sync|channels|audit/i);
    expect(screen?.hasAttribute("aria-live")).toBe(false);
    expect(ring?.getAttribute("role")).toBe("progressbar");
    expect(ring?.getAttribute("aria-valuenow")).toBe("8");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
  });

  it("offers a quiet close and early chat route while the bot wakes", async () => {
    const { onclose, onopenchat } = render();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-open-chat"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-close"]')!.click();
    expect(onopenchat).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("shows a single-sentence failure with Try again", async () => {
    const { onretry } = render(recordWakingCheckFailure({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      phase: "failed",
    }));
    await settle();
    expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).toBe("We couldn't start this bot.");
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-retry"]')!.click();
    expect(onretry).toHaveBeenCalledOnce();
  });

  it("opens Grok with its code in the provider link", async () => {
    const openExternal = vi.fn();
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "grok", url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { openExternal });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    expect(openExternal).toHaveBeenCalledWith("https://accounts.x.ai/device?user_code=TEST-CODE");
    expect(document.querySelector('[data-testid="new-bot-approval-waiting"]')?.textContent).toContain("Waiting for Grok");
  });

  it("keeps approval recoverable when the provider page cannot open", async () => {
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "grok", url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { openExternal: vi.fn(async () => { throw new Error("blocked"); }) });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    expect(document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent).toContain("couldn't open");
    expect(document.querySelector('[data-testid="new-bot-approval-waiting"]')).toBeNull();
  });

  it("polls the selected brain so the server returns the current pairing", async () => {
    const getStatus = vi.fn(async () => ({ ok: true, value: { setupState: { phase: "creating" } } }));
    render(beginWakingSession({
      agentUid: "agt_nova",
      channelId: "chn_nova",
      companyUid: "cmp_acme",
      name: "Nova",
      brain: "grok",
    }), { getStatus });
    await settle();
    expect(getStatus).toHaveBeenCalledWith("agt_nova", "grok");
  });

  it("copies and displays the Codex code before opening its device page", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const openExternal = vi.fn();
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { openExternal });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("TEST-CODE");
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
    expect(document.querySelector('[data-testid="new-bot-codex-code"]')?.textContent).toBe("TEST-CODE");
  });

  it("clears the copied Codex code after the bot is ready", async () => {
    vi.useFakeTimers();
    let ready = false;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => "TEST-CODE"), writeText },
    });
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, {
      getStatus: async () => ({ ok: true, value: { setupState: { phase: ready ? "ready" : "creating" } } }),
      openExternal: vi.fn(),
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    ready = true;
    await vi.advanceTimersByTimeAsync(WAKING_POLL_MS);
    expect(writeText).toHaveBeenNthCalledWith(1, "TEST-CODE");
    expect(writeText).toHaveBeenNthCalledWith(2, "");
  });

  it("does not erase a newer clipboard value after Codex approval completes", async () => {
    vi.useFakeTimers();
    let ready = false;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => "newer clipboard value"), writeText },
    });
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, {
      getStatus: async () => ({ ok: true, value: { setupState: { phase: ready ? "ready" : "creating" } } }),
      openExternal: vi.fn(),
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    ready = true;
    await vi.advanceTimersByTimeAsync(WAKING_POLL_MS);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("TEST-CODE");
  });

  it("submits the Claude browser code and enters a pending state", async () => {
    const submitClaudeLoginCode = vi.fn(async () => ({ ok: true }));
    const openExternal = vi.fn();
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "claude", url: "https://claude.ai/oauth/authorize", code: "", capturedAt: new Date().toISOString() },
    }, { openExternal, submitClaudeLoginCode });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-bot-claude-code"]')!;
    input.value = "returned-code";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-claude-submit"]')!.click();
    await settle();
    expect(openExternal).toHaveBeenCalledWith("https://claude.ai/oauth/authorize");
    expect(submitClaudeLoginCode).toHaveBeenCalledWith("agt_nova", "returned-code");
    expect(document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent).toContain("Checking your sign-in");
  });

  it("removes the approval action when the next status response resumes waking", async () => {
    const initial = {
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "grok" as const, url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    };
    const { onupdate } = render(initial, {
      getStatus: async () => ({ ok: true, value: { setupState: { phase: "creating" } } }),
    });
    await settle();

    const resumed = onupdate.mock.calls[0]?.[0];
    expect(resumed).toMatchObject({ phase: "waking", approval: null });

    await unmount(component!);
    component = null;
    host.remove();
    render(resumed, { getStatus: null });
    await settle();
    expect(document.querySelector('[data-testid="new-bot-approval-open"]')).toBeNull();
    expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).not.toBe("One thing from you.");
  });

  it("offers a fresh approval after ten minutes", async () => {
    const restartBrainApproval = vi.fn(async () => ({ ok: true, value: { agent: { provider: "grok" }, setupState: { phase: "creating" }, pairing: null } }));
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "grok", url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date(Date.now() - 601_000).toISOString() },
    }, { restartBrainApproval });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-restart"]')!.click();
    await settle();
    expect(restartBrainApproval).toHaveBeenCalledWith("agt_nova", "grok");
  });
});
