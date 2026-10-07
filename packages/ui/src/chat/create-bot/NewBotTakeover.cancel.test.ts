// @vitest-environment happy-dom

/**
 * Cancel in the new bot takeover (US-016). Cancel stops the create and asks
 * the host to remove what it made. Leaving the waiting screen keeps the bot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import NewBotTakeover from "./NewBotTakeover.svelte";
import { beginBotRemoval, type BotRemoval } from "./cancel-model.js";
import { beginWakingSession } from "./waking-model.js";
import type { EntryPointResult } from "../lifecycle-entry-points.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function click(selector: string): void {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

function press(key: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const CREATE_PROPS = {
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
};

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NewBotTakeover, {
    target: host,
    props: { oncancel: vi.fn(), ...props },
  });
}

async function typeName(value: string): Promise<void> {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await settle();
}

async function pressCreate(name: string): Promise<void> {
  await typeName(name);
  click('[data-testid="new-bot-continue-name"]');
  await settle();
  click('[data-testid="new-bot-create-submit"]');
  await settle();
}

function wakingSession(patch: Record<string, unknown> = {}) {
  return {
    ...beginWakingSession({
      agentUid: "agt_nova",
      channelId: "",
      companyUid: "cmp_acme",
      name: "Nova",
    }),
    ...patch,
  };
}

const CREATED: EntryPointResult = {
  ok: true,
  target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_nova" },
};

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Cancel while the create request is out", () => {
  it("returns to a clean create screen and ignores the answer when it arrives", async () => {
    // Owner walkthrough 2026-10-02: Cancel, a new name, and then the app
    // "quickly took me back to the one I tried to Cancel".
    let finish!: (result: EntryPointResult) => void;
    const oncreate = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finish = resolve; }));
    const oncancel = vi.fn();
    const oncancelcreate = vi.fn();
    const onwaking = vi.fn();
    render({ ...CREATE_PROPS, oncreate, oncancel, oncancelcreate, onwaking });
    await settle();
    await pressCreate("Woah");
    expect(q('[data-testid="new-bot-creating"]')).toBeTruthy();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    // Still in the takeover, on the first step (the name), with nothing typed.
    expect(oncancel).not.toHaveBeenCalled();
    expect(oncancelcreate).toHaveBeenCalledOnce();
    expect(q('[data-testid="new-bot-creating"]')).toBeNull();
    expect(q('[data-testid="new-bot-step-name"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("");

    await typeName("Second");
    finish(CREATED);
    await settle(10);

    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-testid="new-bot-step-name"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Second");
    expect(onwaking).not.toHaveBeenCalled();
  });

  it("lets the person create another bot at once, and only that bot reaches the waiting screen", async () => {
    const finishers: Array<(result: EntryPointResult) => void> = [];
    const oncreate = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishers.push(resolve); }));
    const onwaking = vi.fn();
    render({ ...CREATE_PROPS, oncreate, onwaking, getStatus: async () => ({ ok: true, value: { setupState: { phase: "provisioning" } } }) });
    await settle();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    await pressCreate("Second");
    expect(oncreate).toHaveBeenCalledTimes(2);

    // The cancelled request answers while the second one is still out.
    finishers[0]!({ ok: true, target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_woah" } });
    await settle(10);
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-testid="new-bot-creating"]')?.textContent).toContain("Second");

    finishers[1]!({ ok: true, target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_second" } });
    await settle(10);
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Second");
    expect(onwaking).toHaveBeenCalledTimes(1);
    expect(onwaking).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_second" }));
  });

  it("Escape cancels the create the same way the Cancel button does", async () => {
    const oncreate = vi.fn(() => new Promise<EntryPointResult>(() => {}));
    const oncancel = vi.fn();
    const oncancelcreate = vi.fn();
    render({ ...CREATE_PROPS, oncreate, oncancel, oncancelcreate });
    await settle();
    await pressCreate("Woah");

    press("Escape");
    await settle();

    expect(oncancelcreate).toHaveBeenCalledOnce();
    expect(oncancel).not.toHaveBeenCalled();
    expect(q('[data-testid="new-bot-step-name"]')).toBeTruthy();
  });

  it("Cancel before Create bot is pressed still leaves the flow", async () => {
    const oncancel = vi.fn();
    const oncancelcreate = vi.fn();
    render({ ...CREATE_PROPS, oncreate: vi.fn(), oncancel, oncancelcreate });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    expect(oncancel).toHaveBeenCalledOnce();
    expect(oncancelcreate).not.toHaveBeenCalled();
  });
});

describe("Cancel for a bot that exists", () => {
  it("asks first, in the app, naming the bot and saying it will be removed", async () => {
    const oncancelbot = vi.fn();
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot });
    await settle();

    const cancel = q<HTMLButtonElement>('[data-testid="new-bot-takeover-cancel"]')!;
    expect(cancel.textContent?.trim()).toBe("Cancel");
    cancel.click();
    await settle();

    const dialog = q('[data-testid="new-bot-cancel-confirm"]')!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("Cancel Nova?");
    expect(dialog.textContent).toContain("Nova will be removed from Acme");
    expect(q('[data-testid="new-bot-cancel-remove"]')?.textContent?.trim()).toBe("Remove Nova");
    expect(q('[data-testid="new-bot-cancel-keep"]')?.textContent?.trim()).toBe("Keep Nova");
    // Nothing is removed until the person says so, and no native dialog is used.
    expect(oncancelbot).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("removes the bot on confirm and lands on a clean create screen", async () => {
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    render({ ...CREATE_PROPS, oncreate: vi.fn(), wakingSession: wakingSession(), getStatus: null, oncancelbot, onclosewaking });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-testid="new-bot-cancel-remove"]');
    await settle();

    expect(oncancelbot).toHaveBeenCalledOnce();
    expect(oncancelbot).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova", name: "Nova" }));
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-testid="new-bot-step-name"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("");
    // The takeover stays open: the person can start another bot at once.
    expect(onclosewaking).not.toHaveBeenCalled();
  });

  it("keeps the bot when the person backs out, by button or by Escape", async () => {
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot, onclosewaking });
    await settle();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-testid="new-bot-cancel-keep"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    press("Escape");
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy();
    expect(oncancelbot).not.toHaveBeenCalled();
    // Escape answered the question. It did not also leave the screen.
    expect(onclosewaking).not.toHaveBeenCalled();
  });

  it("keeps the keyboard inside the question while it is open", async () => {
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot: vi.fn() });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    const keep = q<HTMLButtonElement>('[data-testid="new-bot-cancel-keep"]')!;
    const remove = q<HTMLButtonElement>('[data-testid="new-bot-cancel-remove"]')!;
    keep.focus();
    press("Tab");
    expect(document.activeElement).toBe(remove);
    press("Tab");
    expect(document.activeElement).toBe(keep);
  });

  it("is offered while the bot waits on sign-in, and for a bot that failed to start", async () => {
    const approval = {
      provider: "codex" as const,
      code: "ABCD-1234",
      url: "https://auth.openai.com/codex/device",
      capturedAt: null,
    };
    render({ ...CREATE_PROPS, wakingSession: wakingSession({ approval }), getStatus: null, oncancelbot: vi.fn() });
    await settle();
    expect(q('[data-testid="new-bot-takeover-cancel"]')?.textContent?.trim()).toBe("Cancel");
    // Leaving is a different control with different words.
    expect(q('[data-testid="new-bot-waking-close"]')?.textContent?.trim()).toBe("Do this later");
    await unmount(component!);
    component = null;
    host.remove();

    render({ ...CREATE_PROPS, wakingSession: wakingSession({ phase: "failed" }), getStatus: null, oncancelbot: vi.fn() });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')?.textContent).toContain("Cancel Nova?");
  });

  it("holds the hand-off to chat while the question is open, and resumes it if the bot is kept", async () => {
    vi.useFakeTimers();
    let status: unknown = { setupState: { phase: "provisioning" } };
    const onopenchat = vi.fn();
    const oncancelbot = vi.fn();
    render({
      ...CREATE_PROPS,
      wakingSession: wakingSession(),
      getStatus: async () => ({ ok: true, value: status }),
      onopenchat,
      oncancelbot,
    });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    status = { setupState: { phase: "ready" } };
    await vi.advanceTimersByTimeAsync(3_100);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onopenchat).not.toHaveBeenCalled();
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeTruthy();

    click('[data-testid="new-bot-cancel-keep"]');
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    expect(onopenchat).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova", phase: "ready" }));
    expect(oncancelbot).not.toHaveBeenCalled();
  });

  it("is not offered once the hand-off to chat has begun", async () => {
    render({
      ...CREATE_PROPS,
      wakingSession: wakingSession({ phase: "ready", progress: 100 }),
      getStatus: null,
      oncancelbot: vi.fn(),
    });
    await settle();
    expect(q('[data-testid="new-bot-takeover-cancel"]')).toBeNull();
  });
});

describe("Cancel for a person who may not remove the bot (review A-I8)", () => {
  // Removing a bot is for an owner or admin of its company. A member who
  // created one was asked "Nova will be removed ... This can't be undone",
  // and the server then refused.
  it("says who can remove the bot, promises nothing, and closes the screen", async () => {
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    const onwakingchange = vi.fn();
    const canRemoveBot = vi.fn(() => false);
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot, canRemoveBot, onclosewaking, onwakingchange });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    expect(canRemoveBot).toHaveBeenCalledWith("cmp_acme");
    const dialog = q('[data-testid="new-bot-cancel-confirm"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("You can't remove Nova");
    expect(dialog.querySelector("#new-bot-confirm-body")?.textContent).toBe(
      "Nova has already been created in Acme. Only an owner or admin of this company can remove a bot. Ask one of them to remove Nova.",
    );
    expect(dialog.textContent).not.toMatch(/will be removed|can't be undone/);
    expect(q('[data-testid="new-bot-cancel-remove"]')).toBeNull();
    expect(q('[data-testid="new-bot-cancel-keep"]')?.textContent?.trim()).toBe("Keep waiting");
    expect(q('[data-testid="new-bot-cancel-leave"]')?.textContent?.trim()).toBe("Close");

    click('[data-testid="new-bot-cancel-leave"]');
    await settle();
    expect(oncancelbot).not.toHaveBeenCalled();
    expect(onclosewaking).toHaveBeenCalledOnce();
    // The bot is left as it is: its session goes back to the host unchanged.
    expect(onwakingchange).toHaveBeenLastCalledWith(expect.objectContaining({ agentUid: "agt_nova", phase: "waking" }));
  });

  it("goes back to the waiting screen on Keep waiting", async () => {
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot, canRemoveBot: () => false, onclosewaking });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-testid="new-bot-cancel-keep"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy();
    expect(onclosewaking).not.toHaveBeenCalled();
    expect(oncancelbot).not.toHaveBeenCalled();
  });

  it("still offers removal to an owner or admin, and to a person whose role is not known", async () => {
    const oncancelbot = vi.fn();
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot, canRemoveBot: () => true });
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')?.textContent).toContain("Nova will be removed from Acme");
    click('[data-testid="new-bot-cancel-remove"]');
    await settle();
    expect(oncancelbot).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova" }));
  });
});

describe("Leaving during the hand-off to chat (review A-I11)", () => {
  // For 350 ms the screen says the bot is live, then opens the chat. Escape
  // or Close in that moment stopped the timer and left: the bot's session
  // stayed "ready" for ever, with a row that reopened a finished screen.
  async function reachHandoff(extra: Record<string, unknown> = {}) {
    vi.useFakeTimers();
    const calls = { onopenchat: vi.fn(), onclosewaking: vi.fn(), onwakingdone: vi.fn(), onwakingchange: vi.fn() };
    render({
      ...CREATE_PROPS,
      wakingSession: wakingSession(),
      getStatus: async () => ({ ok: true, value: { setupState: { phase: "ready" } } }),
      ...calls,
      ...extra,
    });
    await settle();
    expect(q('[data-testid="new-bot-waking-status"]')?.textContent).toContain("Nova is live");
    expect(calls.onopenchat).not.toHaveBeenCalled();
    return calls;
  }

  it("finishes the hand-off at once on Escape", async () => {
    const calls = await reachHandoff();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();

    expect(calls.onwakingdone).toHaveBeenCalledTimes(1);
    expect(calls.onwakingdone).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova", phase: "ready" }));
    expect(calls.onopenchat).toHaveBeenCalledTimes(1);
    expect(calls.onclosewaking).toHaveBeenCalledTimes(1);
    // The timer was stopped with it: nothing happens twice.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.onwakingdone).toHaveBeenCalledTimes(1);
    expect(calls.onopenchat).toHaveBeenCalledTimes(1);
    expect(calls.onclosewaking).toHaveBeenCalledTimes(1);
  });

  it("finishes the hand-off at once on the screen's own Close", async () => {
    const calls = await reachHandoff();
    click('[data-testid="new-bot-waking-close"]');
    await settle();
    expect(calls.onwakingdone).toHaveBeenCalledTimes(1);
    expect(calls.onopenchat).toHaveBeenCalledTimes(1);
    expect(calls.onclosewaking).toHaveBeenCalledTimes(1);
  });

  it("stops the timer when the takeover goes away, and tells the host the wait is over", async () => {
    const calls = await reachHandoff();
    await unmount(component!);
    component = null;

    expect(calls.onwakingdone).toHaveBeenCalledTimes(1);
    expect(calls.onwakingdone).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova", phase: "ready" }));
    // The person did not ask to open the chat, and the screen is gone.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.onopenchat).not.toHaveBeenCalled();
    expect(calls.onclosewaking).not.toHaveBeenCalled();
    expect(calls.onwakingdone).toHaveBeenCalledTimes(1);
  });

  it("hands off a session that was already ready when the takeover opened", async () => {
    const onopenchat = vi.fn();
    const onwakingdone = vi.fn();
    const onclosewaking = vi.fn();
    render({
      ...CREATE_PROPS,
      wakingSession: wakingSession({ phase: "ready", progress: 100 }),
      getStatus: null,
      onopenchat,
      onwakingdone,
      onclosewaking,
    });
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect(onwakingdone).toHaveBeenCalledTimes(1);
    expect(onopenchat).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova" }));
    expect(onclosewaking).toHaveBeenCalledTimes(1);
  });
});

describe("Leaving the waiting screen", () => {
  it("keeps the bot: no question, no removal", async () => {
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    const onwakingchange = vi.fn();
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot, onclosewaking, onwakingchange });
    await settle();

    const leave = q<HTMLButtonElement>('[data-testid="new-bot-waking-close"]')!;
    expect(leave.textContent?.trim()).toBe("Close and keep working");
    leave.click();
    await settle();

    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(oncancelbot).not.toHaveBeenCalled();
    expect(onclosewaking).toHaveBeenCalledOnce();
    expect(onwakingchange).toHaveBeenLastCalledWith(expect.objectContaining({ agentUid: "agt_nova" }));
  });

  it("Escape on the waiting screen leaves and keeps the bot", async () => {
    const oncancelbot = vi.fn();
    const onclosewaking = vi.fn();
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, oncancelbot, onclosewaking });
    await settle();
    press("Escape");
    await settle();
    expect(onclosewaking).toHaveBeenCalledOnce();
    expect(oncancelbot).not.toHaveBeenCalled();
  });

  it("a host that cannot remove bots keeps the header button as Close", async () => {
    const onclosewaking = vi.fn();
    render({ ...CREATE_PROPS, wakingSession: wakingSession(), getStatus: null, onclosewaking });
    await settle();
    const header = q<HTMLButtonElement>('[data-testid="new-bot-takeover-cancel"]')!;
    expect(header.textContent?.trim()).toBe("Close");
    header.click();
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(onclosewaking).toHaveBeenCalledOnce();
  });
});

describe("What the person sees about a cancelled bot", () => {
  function removal(patch: Partial<BotRemoval>): BotRemoval {
    return { ...beginBotRemoval({ name: "Nova", companyUid: "cmp_acme", agentUid: "agt_nova" }), ...patch };
  }

  it("shows one plain line while removal runs, with nothing to press", async () => {
    render({ ...CREATE_PROPS, oncreate: vi.fn(), removals: [removal({ phase: "removing" })], onretryremoval: vi.fn() });
    await settle();
    const notice = q('[data-testid="new-bot-cancel-notice"]')!;
    expect(notice.textContent).toContain("Removing Nova. This can take a minute.");
    expect(q('[data-testid="new-bot-cancel-retry"]')).toBeNull();
    // The create screen is there to use meanwhile.
    expect(q('[data-testid="new-bot-step-name"]')).toBeTruthy();
  });

  it("says so when removal fails and offers Try again", async () => {
    const onretryremoval = vi.fn();
    const ondismissremoval = vi.fn();
    const failed = removal({ phase: "failed", problem: "error" });
    render({ ...CREATE_PROPS, oncreate: vi.fn(), removals: [failed], onretryremoval, ondismissremoval });
    await settle();
    const notice = q('[data-testid="new-bot-cancel-notice"]')!;
    expect(notice.textContent).toContain("We couldn't remove Nova. It still exists.");
    expect(notice.textContent).not.toContain("was removed");
    click('[data-testid="new-bot-cancel-retry"]');
    expect(onretryremoval).toHaveBeenCalledWith(failed.id);
    // The other way out keeps the bot, and says so.
    const keep = q<HTMLButtonElement>('[data-testid="new-bot-cancel-dismiss"]')!;
    expect(keep.textContent?.trim()).toBe("Keep Nova");
    keep.click();
    expect(ondismissremoval).toHaveBeenCalledWith(failed.id);
  });

  it("offers no Try again when asking again cannot help", async () => {
    render({
      ...CREATE_PROPS,
      oncreate: vi.fn(),
      removals: [removal({ phase: "failed", problem: "not-allowed" })],
      onretryremoval: vi.fn(),
      ondismissremoval: vi.fn(),
    });
    await settle();
    expect(q('[data-testid="new-bot-cancel-notice"]')?.textContent).toContain(
      "Only an owner or admin of this company can remove a bot.",
    );
    expect(q('[data-testid="new-bot-cancel-retry"]')).toBeNull();
    expect(q('[data-testid="new-bot-cancel-dismiss"]')?.textContent?.trim()).toBe("OK");
  });

  it("says the result plainly once the bot is gone", async () => {
    render({ ...CREATE_PROPS, oncreate: vi.fn(), removals: [removal({ phase: "removed" })], ondismissremoval: vi.fn() });
    await settle();
    expect(q('[data-testid="new-bot-cancel-notice"]')?.textContent?.trim()).toBe("Nova was removed.");
    expect(q('[data-testid="new-bot-cancel-dismiss"]')).toBeNull();
  });
});
