// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import NewBotWakingScreen from "./NewBotWakingScreen.svelte";
import { CLAUDE_CODE_CONFIRM_MS, CLAUDE_CODE_RESEND_AFTER_MS } from "./claude-code-submit";
import {
  beginWakingSession,
  recordWakingCheckFailure,
  WAKING_NUDGE_FAST_WINDOW_MS,
  WAKING_NUDGE_MS,
  WAKING_POLL_FAILING_MS,
  WAKING_POLL_FAST_WINDOW_MS,
  WAKING_POLL_MS,
  WAKING_POLL_SLOW_MS,
} from "./waking-model";

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
  component = mount(NewBotWakingScreen, {
    target: host,
    props: {
      session,
      getStatus: async () => ({ ok: true, value: { setupState: { phase: "creating" } } }),
      retryAgent,
      onupdate,
      onclose,
      onretry,
      ...overrides,
    },
  });
  return { onupdate, onclose, onretry, retryAgent };
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

  it("offers one way out and no chat link before the bot can chat", async () => {
    // Owner walkthrough 2026-10-02: "Open chat now" beside "Close" made no
    // sense for a bot that had not been signed in to its brain yet.
    const { onclose } = render();
    await settle();
    expect(document.querySelector('[data-testid="new-bot-waking-open-chat"]')).toBeNull();
    expect(document.querySelector('[data-testid="new-bot-waking-screen"]')?.textContent).not.toMatch(/open chat/i);
    const close = document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-close"]')!;
    expect(close.textContent?.trim()).toBe("Close and keep working");
    close.click();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("asks the server to re-check setup while the screen is open", async () => {
    // Regression (owner walkthrough 2026-10-02): after the sign-in the screen
    // only watched, and setup waited for the server's once-a-minute pass.
    vi.useFakeTimers();
    const { retryAgent } = render();
    await settle();
    expect(retryAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAKING_NUDGE_MS + WAKING_POLL_MS);
    expect(retryAgent).toHaveBeenCalledWith("agt_nova");
    const calls = retryAgent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WAKING_POLL_MS);
    expect(retryAgent.mock.calls.length).toBe(calls);
  });

  it("shows the Codex code large with a copy button before anything is clicked", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { getStatus: null });
    await settle();
    expect(document.querySelector('[data-testid="new-bot-codex-code"]')?.textContent).toBe("TEST-CODE");
    const copy = document.querySelector<HTMLButtonElement>('[data-testid="new-bot-codex-copy"]')!;
    expect(copy.getAttribute("aria-label")).toBe("Copy code");
    copy.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("TEST-CODE");
    expect(copy.textContent).toContain("Copied");
  });

  it("lets the person say they signed in, and re-checks at once", async () => {
    const openExternal = vi.fn();
    const { retryAgent } = render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "grok", url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { openExternal, getStatus: null });
    await settle();
    expect(document.querySelector('[data-testid="new-bot-approval-done"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-done"]')!.click();
    await settle();
    expect(retryAgent).toHaveBeenCalledWith("agt_nova");
    expect(document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent).toBe("Checking your sign-in.");
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

  it("never reads the clipboard, and writes it only on a press (review A-I13)", async () => {
    // The screen used to read the clipboard when the bot became ready, to
    // clear the code it had copied. Outside a press that read makes the
    // webview show a paste prompt. (The two tests this one replaces asserted
    // that read and the clearing write; that is the behaviour the review
    // asked to change. The second of them, "does not erase a newer clipboard
    // value", still holds: nothing is erased at all.)
    vi.useFakeTimers();
    let ready = false;
    const writeText = vi.fn(async () => undefined);
    const readText = vi.fn(async () => "TEST-CODE");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText, writeText } });
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, {
      getStatus: async () => ({ ok: true, value: { setupState: { phase: ready ? "ready" : "creating" } } }),
      openExternal: vi.fn(),
    });
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    ready = true;
    await vi.advanceTimersByTimeAsync(WAKING_POLL_MS * 3);
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("TEST-CODE");
  });

  it("opens the sign-in page inside the press, before anything is awaited (review A-I13)", async () => {
    // The page was opened after the clipboard write had been awaited. A
    // window opened after an await is not the person's own action any more,
    // and a webview may block it.
    let finishCopy: () => void = () => {};
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const openExternal = vi.fn();
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { openExternal, getStatus: null });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    // No await between the press and these: both began inside it, while the
    // clipboard write is still out.
    expect(writeText).toHaveBeenCalledWith("TEST-CODE");
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
    finishCopy();
    await settle();
    expect(document.querySelector('[data-testid="new-bot-approval-open"]')?.textContent).toBe("Open Codex again");
  });

  it("logs a refused clipboard write and still asks the person to copy the code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const writeText = vi.fn(async () => {
        throw new Error("clipboard denied");
      });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const openExternal = vi.fn(() => true);
      render({
        ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
        approval: { provider: "codex", url: "https://auth.openai.com/codex/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
      }, { openExternal, getStatus: null });
      await settle();
      document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
      await settle();
      expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
      expect(document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent).toBe(
        "Copy the code and paste it on the next page.",
      );
      expect(warn).toHaveBeenCalledWith("new-bot: clipboard write failed", "clipboard denied");
      expect(warn.mock.calls.some((call) => String(call[1]).includes("TEST-CODE"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not say the page is open when the host could not open it (review A-I13)", async () => {
    const openExternal = vi.fn(() => false);
    render({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      approval: { provider: "grok", url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
    }, { openExternal, getStatus: null });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
    await settle();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent).toBe("We couldn't open the sign-in page. Try again.");
    expect(document.querySelector('[data-testid="new-bot-approval-open"]')?.textContent).toBe("Continue with Grok");
    expect(document.querySelector('[data-testid="new-bot-approval-done"]')).toBeNull();
    expect(document.querySelector('[data-testid="new-bot-approval-waiting"]')).toBeNull();
  });

  describe("how often it asks (review A-I7)", () => {
    function setHidden(hidden: boolean): void {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    afterEach(() => {
      Reflect.deleteProperty(document, "hidden");
    });

    it("asks nothing while the window is hidden, and picks up when it is shown again", async () => {
      vi.useFakeTimers();
      setHidden(true);
      const getStatus = vi.fn(async () => ({ ok: true, value: { setupState: { phase: "creating" } } }));
      const { retryAgent } = render(undefined, { getStatus });
      await settle();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(getStatus).not.toHaveBeenCalled();
      expect(retryAgent).not.toHaveBeenCalled();

      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(getStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(WAKING_POLL_MS);
      expect(getStatus).toHaveBeenCalledTimes(2);

      // Hidden again mid-wait: the read that comes due is held.
      setHidden(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(getStatus).toHaveBeenCalledTimes(2);
    });

    it("reads the status every 3 seconds at first, then every 15 once half an hour has passed", async () => {
      vi.useFakeTimers();
      const getStatus = vi.fn(async () => ({ ok: true, value: { setupState: { phase: "creating" } } }));
      render(undefined, { getStatus });
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(20);
      expect(getStatus.mock.calls.length).toBeLessThanOrEqual(21);

      await vi.advanceTimersByTimeAsync(WAKING_POLL_FAST_WINDOW_MS);
      const before = getStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getStatus.mock.calls.length - before).toBe(60_000 / WAKING_POLL_SLOW_MS);
    });

    it("asks for a re-check every 12 seconds at first, then once a minute after ten minutes", async () => {
      vi.useFakeTimers();
      const { retryAgent } = render();
      await settle();
      await vi.advanceTimersByTimeAsync(WAKING_NUDGE_FAST_WINDOW_MS);
      const early = retryAgent.mock.calls.length;
      // Every 12 seconds, on the 3-second read that first passes the mark.
      expect(early).toBeGreaterThanOrEqual(40);
      expect(early).toBeLessThanOrEqual(50);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const later = retryAgent.mock.calls.length - early;
      expect(later).toBeGreaterThanOrEqual(9);
      expect(later).toBeLessThanOrEqual(11);
    });

    it("spaces out status reads that keep failing", async () => {
      vi.useFakeTimers();
      const getStatus = vi.fn(async () => ({ ok: false, reason: "error", code: "http-502" }));
      const failing = { ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova", now: Date.now() }), consecutiveCheckFailures: 5 };
      render(failing, { getStatus });
      await settle();
      expect(getStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(WAKING_POLL_FAILING_MS - 1);
      expect(getStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getStatus).toHaveBeenCalledTimes(2);
    });
  });

  describe("a bot that is gone or out of reach (review A-I4)", () => {
    it("stops reading and re-checking once the status says the bot is being removed", async () => {
      // "deprovisioning" read as waking: the screen kept its countdown and
      // kept asking the server to re-check a bot it was taking down.
      vi.useFakeTimers();
      const getStatus = vi.fn(async () => ({ ok: true, value: { setupState: { phase: "deprovisioning", steps: [] } } }));
      const { onupdate, retryAgent } = render(undefined, { getStatus });
      await settle();
      expect(onupdate).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "stopped", stopped: "removing", approval: null }));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(retryAgent).not.toHaveBeenCalled();
    });

    it("shows its own line and one Close for a stopped bot, with no sign-in and no Try again", async () => {
      render({
        ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova" }),
        phase: "stopped" as const,
        stopped: "removed" as const,
      }, { getStatus: vi.fn() });
      await settle();
      expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).toBe("Nova was removed.");
      expect(document.querySelector('[data-testid="new-bot-approval"]')).toBeNull();
      expect(document.querySelector('[data-testid="new-bot-waking-retry"]')).toBeNull();
      expect(document.querySelector('[data-testid="new-bot-waking-close"]')?.textContent?.trim()).toBe("Close");
    });
  });

  it("holds Try again while the request is out and says so when it is refused (review A-I14)", async () => {
    const failed = { ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova" }), phase: "failed" as const };
    const { onretry } = render(failed, { retryBusy: true });
    await settle();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-retry"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Trying again...");
    button.click();
    expect(onretry).not.toHaveBeenCalled();

    await unmount(component!);
    component = null;
    host.remove();
    render(failed, { retryMessage: "We couldn't start Nova again. Try again in a moment." });
    await settle();
    expect(document.querySelector('[data-testid="new-bot-waking-retry-message"]')?.textContent).toBe(
      "We couldn't start Nova again. Try again in a moment.",
    );
    expect(document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-retry"]')!.disabled).toBe(false);
  });

  describe("Claude code paste-back (owner: the code disappeared and nothing happened)", () => {
    const claudeApproval = () => ({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova", brain: "claude" }),
      approval: { provider: "claude" as const, url: "https://claude.ai/oauth/authorize", code: "", capturedAt: new Date().toISOString() },
    });
    const waitingStatus = {
      ok: true,
      value: {
        agent: { provider: "claude" },
        pairing: { url: "https://claude.ai/oauth/authorize" },
        setupState: { phase: "creating", steps: [{ name: "codex-auth", status: "pending" }] },
      },
    };
    const signedInStatus = {
      ok: true,
      value: {
        agent: { provider: "claude" },
        setupState: { phase: "creating", steps: [{ name: "codex-auth", status: "done" }] },
      },
    };
    const answer = (outcome: string) => ({
      ok: true,
      value: { uid: "agt_nova", ok: true, outcome, reason: "Login failed: invalid_grant [code removed]", at: new Date().toISOString() },
    });
    const field = () => document.querySelector<HTMLInputElement>('[data-testid="new-bot-claude-code"]')!;
    const submit = () => document.querySelector<HTMLButtonElement>('[data-testid="new-bot-claude-submit"]')!;
    const message = () => document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent ?? "";
    async function flush() {
      for (let i = 0; i < 8; i += 1) await settle();
    }

    async function openAndPaste(overrides: Record<string, unknown>) {
      const rendered = render(claudeApproval(), { openExternal: vi.fn(), getStatus: async () => waitingStatus, ...overrides });
      await settle();
      document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
      await settle();
      field().value = "returned-code";
      field().dispatchEvent(new InputEvent("input", { bubbles: true }));
      return rendered;
    }

    it("keeps the code in a locked field with a visible Checking state, and sends it once on a double press", async () => {
      let resolveSubmit: (value: unknown) => void = () => {};
      const submitClaudeLoginCode = vi.fn(() => new Promise((resolve) => { resolveSubmit = resolve; }));
      await openAndPaste({ submitClaudeLoginCode });
      submit().click();
      submit().click();
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle();
      expect(submitClaudeLoginCode).toHaveBeenCalledTimes(1);
      expect(submitClaudeLoginCode).toHaveBeenCalledWith("agt_nova", "returned-code");
      expect(field().value).toBe("returned-code");
      expect(field().disabled).toBe(true);
      expect(submit().disabled).toBe(true);
      expect(submit().textContent).toContain("Checking...");
      expect(message()).toBe("Checking your sign-in.");
      resolveSubmit(answer("accepted"));
      await settle();
      // Still checking: the code stays until the outcome is known.
      expect(field().value).toBe("returned-code");
      expect(field().disabled).toBe(true);
    });

    it("asks the server to re-check straight away after an accepted code and moves on", async () => {
      let signedIn = false;
      const submitClaudeLoginCode = vi.fn(async () => { signedIn = true; return answer("accepted"); });
      const getStatus = vi.fn(async () => (signedIn ? signedInStatus : waitingStatus));
      const { onupdate, retryAgent } = await openAndPaste({ submitClaudeLoginCode, getStatus });
      retryAgent.mockClear();
      submit().click();
      await flush();
      expect(retryAgent).toHaveBeenCalledWith("agt_nova");
      const last = onupdate.mock.calls.at(-1)?.[0];
      expect(last?.approval).toBeNull();
      expect(last?.signedInAt).not.toBeNull();
      expect(message()).toBe("");
    });

    it("sends the code once more when Claude's answer was not seen, then moves on", async () => {
      vi.useFakeTimers();
      let sends = 0;
      const submitClaudeLoginCode = vi.fn(async () => answer(++sends === 1 ? "unknown" : "accepted"));
      const getStatus = vi.fn(async () => (sends >= 2 ? signedInStatus : waitingStatus));
      const { onupdate } = await openAndPaste({ submitClaudeLoginCode, getStatus });
      submit().click();
      await settle();
      expect(submitClaudeLoginCode).toHaveBeenCalledTimes(1);
      expect(field().value).toBe("returned-code");
      await vi.advanceTimersByTimeAsync(CLAUDE_CODE_RESEND_AFTER_MS + 1_000);
      expect(submitClaudeLoginCode).toHaveBeenCalledTimes(2);
      expect(submitClaudeLoginCode).toHaveBeenLastCalledWith("agt_nova", "returned-code");
      expect(onupdate.mock.calls.at(-1)?.[0]?.approval).toBeNull();
    });

    it("times out with a plain message, keeps the code, and Try again checks without sending it twice", async () => {
      vi.useFakeTimers();
      const submitClaudeLoginCode = vi.fn(async () => answer("accepted"));
      let signedIn = false;
      const getStatus = vi.fn(async () => (signedIn ? signedInStatus : waitingStatus));
      const { onupdate } = await openAndPaste({ submitClaudeLoginCode, getStatus });
      submit().click();
      await settle();
      await vi.advanceTimersByTimeAsync(CLAUDE_CODE_CONFIRM_MS + 5_000);
      expect(message()).toBe("We couldn't confirm your sign-in yet. Try again.");
      expect(field().value).toBe("returned-code");
      expect(field().disabled).toBe(false);
      expect(submit().disabled).toBe(false);
      expect(submit().textContent).toContain("Try again");
      signedIn = true;
      submit().click();
      await vi.advanceTimersByTimeAsync(10);
      expect(submitClaudeLoginCode).toHaveBeenCalledTimes(1);
      expect(onupdate.mock.calls.at(-1)?.[0]?.approval).toBeNull();
    });

    it("says plainly when Claude did not accept the code and keeps it in the field", async () => {
      const submitClaudeLoginCode = vi.fn(async () => answer("rejected"));
      await openAndPaste({ submitClaudeLoginCode });
      submit().click();
      await flush();
      expect(message()).toBe("Claude didn't accept that code. Open Claude again for a new code, then paste it here.");
      expect(field().value).toBe("returned-code");
      expect(field().disabled).toBe(false);
      expect(document.body.textContent).not.toMatch(/invalid_grant|Login failed|code removed/);
    });

    it("keeps the code and offers Try again when the request fails, with no raw error on screen", async () => {
      const submitClaudeLoginCode = vi.fn(async () => ({ ok: false, code: "network", message: "Network error: operation timed out" }));
      await openAndPaste({ submitClaudeLoginCode });
      submit().click();
      await flush();
      expect(message()).toBe("We couldn't send that code. Try again.");
      expect(field().value).toBe("returned-code");
      expect(submit().textContent).toContain("Try again");
      expect(document.body.textContent).not.toMatch(/Network error|timed out/);
    });
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
    expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).toMatch(/^You're signed in\. Finishing up\./);
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
  describe("the bot's first message", () => {
    const CHAT_READY = {
      ok: true,
      value: {
        setupState: {
          phase: "waiting",
          steps: [
            { name: "codex-auth", status: "done" },
            { name: "sync", status: "done" },
            { name: "audit", status: "waiting" },
          ],
        },
      },
    };

    it("asks the bot for its first message and holds the person until it is there", async () => {
      // Regression (owner walkthrough 2026-10-02): the person was taken to the
      // conversation, wrote twice, and got no answer.
      const sendHello = vi.fn(async (_session: { agentUid: string }) => true);
      const checkHello = vi.fn(async () => false);
      const { onupdate, retryAgent } = render(undefined, { getStatus: async () => CHAT_READY, sendHello, checkHello });
      await settle();
      await settle();
      expect(sendHello).toHaveBeenCalledTimes(1);
      expect(sendHello.mock.calls[0]?.[0]).toMatchObject({ agentUid: "agt_nova" });
      const last = onupdate.mock.calls.at(-1)?.[0];
      expect(last.phase).toBe("waking");
      expect(last.chatReadyAt).toEqual(expect.any(Number));
      expect(last.helloAskedAt).toEqual(expect.any(Number));
      // Setup is past the point a re-check helps; the wait is for the bot now.
      expect(retryAgent).not.toHaveBeenCalled();
    });

    it("writes the request down, with its key, before the request leaves (review item 8)", async () => {
      let sent!: (ok: boolean) => void;
      const sendHello = vi.fn((_session: { agentUid: string; helloKey?: string | null }) => new Promise<boolean>((resolve) => { sent = resolve; }));
      const checkHello = vi.fn(async () => false);
      const { onupdate } = render(undefined, { getStatus: async () => CHAT_READY, sendHello, checkHello });
      await settle();
      await settle();

      // The request is out and has not come back. The mark is already saved.
      expect(sendHello).toHaveBeenCalledTimes(1);
      const marked = onupdate.mock.calls.at(-1)?.[0];
      expect(marked).toMatchObject({ helloAskingAt: expect.any(Number), helloKey: "new-bot-hello-agt_nova" });
      expect(marked.helloAskedAt ?? null).toBeNull();
      // The request carries the same key.
      expect(sendHello.mock.calls[0]?.[0]).toMatchObject({ helloKey: "new-bot-hello-agt_nova" });

      sent(true);
      await settle();
      await settle();
      const asked = onupdate.mock.calls.at(-1)?.[0];
      // Counted from when it was begun, not from when it came back.
      expect(asked.helloAskedAt).toBe(marked.helloAskingAt);
    });

    it("a screen that takes over a request that was begun sends that same request, not a second one", async () => {
      // The first screen went away while its request was out. Nothing says
      // whether the request arrived.
      const begun = {
        ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova", now: Date.now() - 200_000 }),
        helloAskingAt: Date.now() - 60_000,
        helloKey: "new-bot-hello-agt_nova",
      };
      const sendHello = vi.fn(async (_session: { agentUid: string; helloKey?: string | null; helloAskingAt?: number | null }) => true);
      const checkHello = vi.fn(async () => false);
      const { onupdate } = render(begun, { getStatus: async () => CHAT_READY, sendHello, checkHello });
      await settle();
      await settle();

      expect(sendHello).toHaveBeenCalledTimes(1);
      expect(sendHello.mock.calls[0]?.[0]).toMatchObject({
        helloKey: "new-bot-hello-agt_nova",
        helloAskingAt: begun.helloAskingAt,
      });
      // The bot's answer is looked for from the first attempt on.
      expect(onupdate.mock.calls.at(-1)?.[0]).toMatchObject({ helloAskedAt: begun.helloAskingAt });
    });

    it("hands over as soon as the first message is seen, without asking twice", async () => {
      const asked = {
        ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova", now: Date.now() - 200_000 }),
        chatReadyAt: Date.now() - 20_000,
        helloAskedAt: Date.now() - 19_000,
      };
      const sendHello = vi.fn(async () => true);
      const checkHello = vi.fn(async () => true);
      const { onupdate } = render(asked, { getStatus: async () => CHAT_READY, sendHello, checkHello });
      await settle();
      await settle();
      expect(sendHello).not.toHaveBeenCalled();
      expect(checkHello).toHaveBeenCalledTimes(1);
      expect(onupdate.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "ready", progress: 100 });
    });

    it("asks again on the next check when the request could not be sent", async () => {
      const sendHello = vi.fn(async () => false);
      const checkHello = vi.fn(async () => false);
      const { onupdate } = render(undefined, { getStatus: async () => CHAT_READY, sendHello, checkHello });
      await settle();
      await settle();
      const last = onupdate.mock.calls.at(-1)?.[0];
      expect(last.phase).toBe("waking");
      expect(last.helloAskedAt ?? null).toBeNull();
      expect(checkHello).not.toHaveBeenCalled();
    });

    it("hands over at once on a host that cannot ask for a first message", async () => {
      const { onupdate } = render(undefined, { getStatus: async () => CHAT_READY });
      await settle();
      await settle();
      expect(onupdate.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "ready" });
    });

    it("says the bot is writing while it waits", async () => {
      const waiting = {
        ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova", now: Date.now() - 200_000 }),
        signedInAt: Date.now() - 30_000,
        chatReadyAt: Date.now() - 5_000,
      };
      render(waiting, { getStatus: async () => CHAT_READY, sendHello: async () => true, checkHello: async () => false });
      await settle();
      expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).toBe(
        "Almost there. Nova is writing its first message to you.",
      );
      expect(document.querySelector('[data-testid="new-bot-approval"]')).toBeNull();
    });
  });
});
