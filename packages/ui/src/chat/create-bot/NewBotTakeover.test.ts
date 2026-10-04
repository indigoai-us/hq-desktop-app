// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import NewBotTakeover from "./NewBotTakeover.svelte";
import { beginWakingSession } from "./waking-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function takeover(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="new-bot-takeover"]',
  );
  if (!element) throw new Error("missing new bot takeover");
  return element;
}

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  host.dataset.theme = "light";
  document.body.appendChild(host);
  component = mount(NewBotTakeover, {
    target: host,
    props: {
      oncancel: vi.fn(),
      ...props,
    },
  });
}

function takeoverStyles(): string {
  return readFileSync(
    resolve(process.cwd(), "src/chat/create-bot/new-bot-takeover.css"),
    "utf8",
  );
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.documentElement.removeAttribute("data-theme");
});

describe("NewBotTakeover", () => {
  it("takes over the light outer app with a dark wallpaper surface and one glass card", async () => {
    document.documentElement.dataset.theme = "light";
    render({ wallpaperIndex: 2 });
    await settle();

    const dialog = takeover();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.style.getPropertyValue("--new-bot-wallpaper")).toContain(
      "url(",
    );
    expect(takeoverStyles()).toMatch(
      /\.new-bot-takeover\s*\{[\s\S]*?color-scheme:\s*dark;/,
    );
    expect(dialog.querySelectorAll(".new-bot-takeover-card")).toHaveLength(1);
  });

  it("keeps Cancel and the local-route link keyboard reachable", async () => {
    const oncancel = vi.fn();
    const onopenlocal = vi.fn();
    render({ canCreateLocalBot: true, oncancel, onopenlocal });
    await settle();

    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="new-bot-takeover-cancel"]',
    )!;
    const local = document.querySelector<HTMLButtonElement>(
      '[data-testid="new-bot-takeover-local"]',
    )!;
    cancel.focus();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(local);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(oncancel).toHaveBeenCalledOnce();
    local.click();
    expect(onopenlocal).toHaveBeenCalledOnce();
  });

  it("removes the arrival animation for people who reduce motion", () => {
    expect(takeoverStyles()).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.new-bot-takeover-card\s*\{[\s\S]*?animation:\s*none;/,
    );
  });

  it("hands a created bot into the waking screen instead of closing the takeover", async () => {
    const onwaking = vi.fn();
    render({
      companies: [{ companyUid: "cmp_acme", label: "Acme" }],
      currentCompanyUid: "cmp_acme",
      runtimeReady: { codex: true },
      loadProvisionOptions: async () => ({
        ok: true as const,
        value: {
          defaultInstanceType: "t4g.medium",
          catalogVersion: "test",
          options: [
            {
              key: "basic" as const,
              productName: "Basic",
              instanceType: "t4g.medium",
              listCents: 5000,
              default: true,
              selectable: true,
              netMonthlyCents: 5000,
              deltaCents: 5000,
              unavailableReason: null,
              notBilled: false,
              lanes: 1,
              workers: 1,
            },
          ],
        },
      }),
      oncreate: async () => ({
        ok: true as const,
        target: {
          channelId: "chn_nova",
          cardId: null,
          cardKind: null,
          agentUid: "agt_nova",
        },
      }),
      getStatus: async () => ({
        ok: true,
        value: { setupState: { phase: "creating" } },
      }),
      onwaking,
    });
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="new-bot-name"]',
    )!;
    input.value = "Nova";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="new-bot-continue-name"]',
      )!
      .click();
    await settle();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="new-bot-create-submit"]',
      )!
      .click();
    await settle();

    expect(
      document.querySelector('[data-testid="new-bot-waking-screen"]')
        ?.textContent,
    ).toContain("Waking up Nova");
    expect(onwaking).toHaveBeenCalledWith(
      expect.objectContaining({ agentUid: "agt_nova", channelId: "chn_nova" }),
    );
  });

  describe("the Claude provider flag (review A-C1)", () => {
    const BASIC = {
      key: "basic" as const,
      productName: "Basic",
      instanceType: "t4g.medium",
      listCents: 5000,
      default: true,
      selectable: true,
      netMonthlyCents: 5000,
      deltaCents: 5000,
      unavailableReason: null,
      notBilled: false,
      lanes: 1,
      workers: 1,
    };
    async function brainsOffered(props: Record<string, unknown>): Promise<string[]> {
      render({
        companies: [{ companyUid: "cmp_acme", label: "Acme" }],
        currentCompanyUid: "cmp_acme",
        // Claude is the brain signed in on this computer.
        runtimeReady: { claude: true, codex: false, grok: false },
        loadProvisionOptions: async () => ({
          ok: true as const,
          value: { defaultInstanceType: "t4g.medium", catalogVersion: "test", options: [BASIC] },
        }),
        oncreate: async () => ({ ok: false as const, blocked: false, reason: "" }),
        ...props,
      });
      await settle();
      const input = document.querySelector<HTMLInputElement>('[data-testid="new-bot-name"]')!;
      input.value = "Nova";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await settle();
      document.querySelector<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
      await settle();
      return [...document.querySelectorAll<HTMLInputElement>("input[name='new-bot-brain']")].map(
        (brain) => `${brain.value}${brain.checked ? "*" : ""}`,
      );
    }

    it("offers Claude when the host says the provider is on", async () => {
      const loadClaudeProviderFlag = vi.fn(async () => ({ ok: true as const, value: true }));
      expect(await brainsOffered({ loadClaudeProviderFlag })).toEqual(["codex", "claude*", "grok"]);
      expect(loadClaudeProviderFlag).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["says it is off", async () => ({ ok: true as const, value: false })],
      ["could not be read", async () => ({ ok: false as const, reason: "error" as const, code: "http-500" })],
      ["threw", async () => { throw new Error("offline"); }],
    ])("leaves Claude out when the flag %s", async (_label, loadClaudeProviderFlag) => {
      expect(await brainsOffered({ loadClaudeProviderFlag })).toEqual(["codex*", "grok"]);
    });

    it("leaves Claude out when the host has no flag reader", async () => {
      expect(await brainsOffered({})).toEqual(["codex*", "grok"]);
    });
  });

  it("shows that the bot is live before opening chat once the status says ready", async () => {
    vi.useFakeTimers();
    const onopenchat = vi.fn();
    const onclosewaking = vi.fn();
    const onwakingchange = vi.fn();
    render({
      wakingSession: beginWakingSession({
        agentUid: "agt_nova",
        channelId: "chn_nova",
        companyUid: "cmp_acme",
        name: "Nova",
      }),
      getStatus: async () => ({
        ok: true,
        value: { setupState: { phase: "ready" } },
      }),
      onopenchat,
      onclosewaking,
      onwakingchange,
    });
    await settle();

    expect(
      document.querySelector('[data-testid="new-bot-waking-status"]')
        ?.textContent,
    ).toContain("Nova is live");
    expect(onopenchat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(onwakingchange).toHaveBeenCalledWith(null);
    expect(onopenchat).toHaveBeenCalledWith(
      expect.objectContaining({ agentUid: "agt_nova", phase: "ready" }),
    );
    expect(onclosewaking).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="new-bot-waking-screen"]'),
    ).toBeNull();
    vi.useRealTimers();
  });

  it("stops waiting for a bot the server no longer has, and offers Close instead of Cancel (review A-I4)", async () => {
    // A deleted bot answered 404 on every status read. The screen said
    // "Reconnecting" and read the status every 3 seconds for as long as it
    // stayed open, and Cancel offered to remove a bot that was already gone.
    vi.useFakeTimers();
    const getStatus = vi.fn(async () => ({ ok: false, reason: "error", code: "http-404", status: 404 }));
    const retryAgent = vi.fn(async () => ({ ok: true }));
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    const onwakingchange = vi.fn();
    render({
      wakingSession: beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova" }),
      getStatus,
      retryAgent,
      oncancelbot,
      onclosewaking,
      onwakingchange,
    });
    await settle();
    // One refusal is not enough: it can be a read that ran ahead of the write.
    expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).not.toContain("removed");
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).toBe("Nova was removed.");
    expect(onwakingchange).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "stopped", stopped: "removed" }));
    const reads = getStatus.mock.calls.length;
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getStatus).toHaveBeenCalledTimes(reads);
    expect(retryAgent).not.toHaveBeenCalled();

    // Nothing to cancel: the header button closes, with no question.
    const header = document.querySelector<HTMLButtonElement>('[data-testid="new-bot-takeover-cancel"]')!;
    expect(header.textContent?.trim()).toBe("Close");
    header.click();
    await settle();
    expect(document.querySelector('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(oncancelbot).not.toHaveBeenCalled();
    expect(onclosewaking).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("asks the server once per press of Try again, and says so when it is refused (review A-I14)", async () => {
    let answer: (value: unknown) => void = () => {};
    const retryAgent = vi.fn(() => new Promise<unknown>((resolve) => { answer = resolve; }));
    const onwakingchange = vi.fn();
    render({
      wakingSession: {
        ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova" }),
        phase: "failed" as const,
      },
      retryAgent,
      onwakingchange,
    });
    await settle();
    const button = () => document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-retry"]')!;
    button().click();
    await settle();
    // The request is out: the button says so and a second press does nothing.
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Trying again...");
    button().click();
    await settle();
    expect(retryAgent).toHaveBeenCalledTimes(1);

    answer({ ok: false, reason: "error", code: "STEP_ALREADY_IN_PROGRESS" });
    await settle();
    expect(document.querySelector('[data-testid="new-bot-waking-retry-message"]')?.textContent).toBe(
      "We couldn't start Nova again. Try again in a moment.",
    );
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Try again");
    expect(onwakingchange).not.toHaveBeenCalled();

    // The next press goes through, and the message goes with it.
    button().click();
    await settle();
    expect(retryAgent).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="new-bot-waking-retry-message"]')).toBeNull();
    answer({ ok: true });
    await settle();
    expect(onwakingchange).toHaveBeenLastCalledWith(expect.objectContaining({ agentUid: "agt_nova", phase: "waking" }));
  });

  it("reports a blocked sign-in window as not opened (review A-I13)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      render({
        wakingSession: {
          ...beginWakingSession({ agentUid: "agt_nova", channelId: "", companyUid: "cmp_acme", name: "Nova" }),
          approval: { provider: "grok" as const, url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: new Date().toISOString() },
        },
      });
      await settle();
      document.querySelector<HTMLButtonElement>('[data-testid="new-bot-approval-open"]')!.click();
      await settle();
      expect(open).toHaveBeenCalledWith("https://accounts.x.ai/device?user_code=TEST-CODE", "_blank");
      expect(document.querySelector('[data-testid="new-bot-approval-message"]')?.textContent).toBe(
        "We couldn't open the sign-in page. Try again.",
      );
      expect(document.querySelector('[data-testid="new-bot-approval-open"]')?.textContent).toBe("Continue with Grok");
    } finally {
      open.mockRestore();
    }
  });

  it("retries the same failed agent instead of returning to creation", async () => {
    const retryAgent = vi.fn(async () => ({ ok: true }));
    const onwakingchange = vi.fn();
    render({
      wakingSession: {
        ...beginWakingSession({
          agentUid: "agt_nova",
          channelId: "chn_nova",
          companyUid: "cmp_acme",
          name: "Nova",
        }),
        phase: "failed" as const,
      },
      retryAgent,
      onwakingchange,
    });
    await settle();
    document
      .querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-retry"]')!
      .click();
    await settle();

    expect(retryAgent).toHaveBeenCalledWith("agt_nova");
    expect(onwakingchange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentUid: "agt_nova",
        channelId: "chn_nova",
        phase: "waking",
      }),
    );
    expect(
      document.querySelector('[data-testid="new-bot-create-screen"]'),
    ).toBeNull();
  });
});
