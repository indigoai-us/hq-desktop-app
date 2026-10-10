// @vitest-environment happy-dom

/**
 * A local bot's runtime repair reply draws as a repair card in its DM, the
 * card's buttons run the real fix through the host (mocked invoke), and the
 * same message row turns into "You're all set" with no new message. Without a
 * valid payload the reply draws its plain text exactly as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import { RuntimeRepairController } from "./runtime-repair.svelte.js";
import type { ConversationMessageWire } from "../chat-api.js";

const SELF = "prs_self";
const BOT = "agt_scout";
const RAW = 'spawn codex ENOENT: HTTP 500 {"error":"Internal Server Error"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function block(cls: string, action: string, extra: Record<string, unknown> = {}) {
  return { v: 1, kind: "runtime-repair", class: cls, runtime: "claude", action, botName: "scout", ...extra };
}

function thread(repair: unknown, from = BOT): ConversationMessageWire[] {
  return [
    { eventId: "evt_ask", fromPersonUid: SELF, fromDisplayName: "Stefan", body: "Sum up the pricing call", createdAt: "2026-10-10T09:41:00.000Z", direction: "out" },
    {
      eventId: "evt_repair",
      fromPersonUid: from,
      fromDisplayName: "Pickles",
      body: "Claude Code is signed out on this Mac. Sign in, then send your message again.",
      createdAt: "2026-10-10T09:41:05.000Z",
      direction: "in",
      ...(repair === undefined ? {} : { richContent: repair }),
    },
  ];
}

/** A fake Tauri invoke, by command, recording every call. */
function fakeInvoke(answers: Record<string, unknown>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const answer = answers[cmd];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? (answer as () => unknown)() : answer;
  });
  return { invoke, calls };
}

/** The controller as the shell builds it, over a fake invoke. */
function controllerOver(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  return new RuntimeRepairController({
    signIn: async (runtime) => {
      const start = (await invoke("agent_provider_login_start", { tool: runtime, force: true })) as { state: string };
      return start.state === "connected";
    },
    update: async (runtime) => (await invoke("install_session_provider", { tool: runtime }), true),
    setModel: async (name, model) => (await invoke("local_bots_set_model", { name, model }), true),
    probe: (runtime, model) => invoke("local_bots_probe", { runtime, model: model ?? null }),
  });
}

function render(messages: ConversationMessageWire[], controller: RuntimeRepairController | null, onsend = vi.fn(async () => {})) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages,
      selfPersonUid: SELF,
      selfDisplayName: "Stefan",
      onsend,
      runtimeRepair: controller ? { botUid: BOT, botName: "Pickles", controller } : null,
    },
  });
  return onsend;
}

const card = () => host.querySelector<HTMLElement>('[data-testid="runtime-repair-card"]');
const primary = () => host.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-primary"]')!;

describe("ChannelConversation runtime repair cards", () => {
  it("draws the bot's repair reply as the card, with the bot's real name, in place of its plain text", async () => {
    const { invoke } = fakeInvoke({});
    render(thread({ v: 1, blocks: [block("signed-out", "signIn")] }), controllerOver(invoke));
    await settle();
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("Pickles needs Claude Code to reply.");
    expect(host.textContent).not.toContain("Sign in, then send your message again.");
  });

  it.each([
    ["no payload", undefined],
    ["a malformed payload", { v: 1, blocks: [block("not-a-class", "signIn")] }],
    ["a payload of another version", { v: 1, blocks: [{ ...block("signed-out", "signIn"), v: 2 }] }],
    ["garbage", "{not json"],
  ])("draws the plain text as before with %s", async (_label, repair) => {
    const { invoke } = fakeInvoke({});
    render(thread(repair), controllerOver(invoke));
    await settle();
    expect(card()).toBeNull();
    expect(host.textContent).toContain("Sign in, then send your message again.");
  });

  it("draws plain text outside a local bot's DM, and for a payload the person sent", async () => {
    render(thread({ v: 1, blocks: [block("signed-out", "signIn")] }), null);
    await settle();
    expect(card()).toBeNull();
    expect(host.textContent).toContain("Sign in, then send your message again.");
    await unmount(component!);
    component = null;
    host.remove();
    const { invoke } = fakeInvoke({});
    render(thread({ v: 1, blocks: [block("signed-out", "signIn")] }, SELF), controllerOver(invoke));
    await settle();
    expect(card()).toBeNull();
  });

  it("Sign in runs the tool's sign-in and the check, then the same row turns fixed with no new message", async () => {
    const { invoke, calls } = fakeInvoke({
      agent_provider_login_start: { state: "connected" },
      local_bots_probe: { ok: true, detail: "fine" },
    });
    const messages = thread({ v: 1, blocks: [block("signed-out", "signIn")] });
    const onsend = render(messages, controllerOver(invoke));
    await settle();
    const before = card();
    const rowsBefore = host.querySelectorAll("[data-event-id]").length;
    expect(rowsBefore).toBe(2);
    const repairRow = card()!.closest("[data-event-id]");
    expect(repairRow?.getAttribute("data-event-id")).toBe("evt_repair");
    primary().click();
    await settle();
    expect(calls.map((c) => c.cmd)).toEqual(["agent_provider_login_start", "local_bots_probe"]);
    expect(calls[0]!.args).toEqual({ tool: "claude", force: true });
    expect(card()).toBe(before);
    expect(card()!.dataset.phase).toBe("fixed");
    expect(card()!.textContent).toContain("You’re all set");
    expect(card()!.textContent).toContain("Send me anything.");
    expect(host.querySelectorAll("[data-event-id]").length).toBe(rowsBefore);
    expect(card()!.closest("[data-event-id]")).toBe(repairRow);
    expect(onsend).not.toHaveBeenCalled();
  });

  it("Update runs the app's install path for the tool, then the check", async () => {
    const { invoke, calls } = fakeInvoke({ install_session_provider: "ok", local_bots_probe: { ok: true } });
    render(thread({ v: 1, blocks: [{ ...block("cli-outdated", "update"), runtime: "codex" }] }), controllerOver(invoke));
    await settle();
    primary().click();
    await settle();
    expect(calls).toEqual([
      { cmd: "install_session_provider", args: { tool: "codex" } },
      { cmd: "local_bots_probe", args: { runtime: "codex", model: null } },
    ]);
    expect(card()!.dataset.phase).toBe("fixed");
  });

  it("Use a supported model sets the bot's model through the CLI command, then checks that model", async () => {
    const { invoke, calls } = fakeInvoke({ local_bots_set_model: { ok: true }, local_bots_probe: { ok: true } });
    render(thread({ v: 1, blocks: [block("model-unsupported", "switchModel", { suggestedModel: "sonnet" })] }), controllerOver(invoke));
    await settle();
    primary().click();
    await settle();
    expect(calls).toEqual([
      { cmd: "local_bots_set_model", args: { name: "scout", model: "sonnet" } },
      { cmd: "local_bots_probe", args: { runtime: "claude", model: "sonnet" } },
    ]);
    expect(card()!.dataset.phase).toBe("fixed");
  });

  it("Try again checks the tool, then sends the person's failed message again", async () => {
    const { invoke, calls } = fakeInvoke({ local_bots_probe: { ok: true } });
    const onsend = render(
      thread({ v: 1, blocks: [block("transient", "tryAgain", { retryOf: "evt_ask" })] }),
      controllerOver(invoke),
    );
    await settle();
    primary().click();
    await settle();
    expect(calls.map((c) => c.cmd)).toEqual(["local_bots_probe"]);
    expect(onsend).toHaveBeenCalledWith("Sum up the pricing call", [], []);
    expect(card()!.dataset.phase).toBe("fixed");
  });

  it("a failed action goes back to the problem with a plain line and never shows raw error text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { invoke } = fakeInvoke({
      agent_provider_login_start: { state: "connected" },
      local_bots_probe: new Error(RAW),
    });
    render(thread({ v: 1, blocks: [block("signed-out", "signIn")] }), controllerOver(invoke));
    await settle();
    primary().click();
    await settle();
    expect(card()!.dataset.phase).toBe("offered");
    expect(host.querySelector('[data-testid="runtime-repair-note"]')!.textContent).toBe("Claude Code is still signed out. Try again.");
    expect(host.textContent).not.toMatch(/ENOENT|HTTP 500|Internal Server Error/);
    expect(host.innerHTML).not.toMatch(/ENOENT|HTTP 500|Internal Server Error/);
    expect(warn).toHaveBeenCalled();
    // The button is back for another try.
    expect(primary().disabled).toBe(false);
  });
});
